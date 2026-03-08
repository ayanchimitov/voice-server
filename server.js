// server.js - Signaling Server with Twilio TURN + APNs Mobile Support

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const apn = require('@parse/node-apn');

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// Active users: userId -> { socketId, lastSeen, platform }
const users = new Map();

// Mobile device tokens: userId -> { deviceToken, platform, bundleId }
// platform: 'ios' | 'android'
const mobileTokens = new Map();

// ============================================================
// APNs SETUP (iOS PushKit for VoIP)
// ============================================================
let apnProvider = null;

function initAPNs() {
  // Requires environment variables:
  // APNS_KEY      - contents of the .p8 key file
  // APNS_KEY_ID   - 10-character key ID from Apple Developer
  // APNS_TEAM_ID  - 10-character Team ID from Apple Developer
  // APNS_BUNDLE_ID - your app bundle ID e.g. com.yourname.messenger

  if (!process.env.APNS_KEY || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    console.warn('⚠️  APNs not configured - iOS push notifications disabled');
    console.warn('   Set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID env vars to enable');
    return;
  }

  apnProvider = new apn.Provider({
    token: {
      key: Buffer.from(process.env.APNS_KEY, 'utf8'),
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    },
    production: process.env.NODE_ENV === 'production'
  });

  console.log('✅ APNs provider initialized');
  console.log(`   Mode: ${process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'}`);
}

initAPNs();

// Send VoIP push notification via PushKit
async function sendVoIPPush(userId, payload) {
  const tokenData = mobileTokens.get(userId);

  if (!tokenData || tokenData.platform !== 'ios') {
    return false;
  }

  if (!apnProvider) {
    console.warn(`⚠️  APNs not configured, cannot push to ${userId}`);
    return false;
  }

  const notification = new apn.Notification();
  notification.topic = `${process.env.APNS_BUNDLE_ID || tokenData.bundleId}.voip`;
  notification.payload = payload;
  notification.priority = 10; // High priority for VoIP
  notification.pushType = 'voip';
  notification.expiry = Math.floor(Date.now() / 1000) + 30; // Expire in 30 seconds

  try {
    const result = await apnProvider.send(notification, tokenData.deviceToken);

    if (result.failed.length > 0) {
      const failure = result.failed[0];
      console.error(`❌ APNs push failed for ${userId}:`, failure.response);

      // Remove invalid token
      if (failure.response?.reason === 'BadDeviceToken' ||
          failure.response?.reason === 'Unregistered') {
        mobileTokens.delete(userId);
        console.log(`🧹 Removed invalid device token for ${userId}`);
      }
      return false;
    }

    console.log(`📱 VoIP push sent to ${userId}`);
    return true;

  } catch (error) {
    console.error(`❌ APNs error for ${userId}:`, error.message);
    return false;
  }
}

// ============================================================
// TWILIO TURN CREDENTIALS
// ============================================================
app.get('/turn-credentials', async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('❌ Twilio credentials not configured');
    return res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      ttl: 86400,
      warning: 'TURN not configured - direct connections only'
    });
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Twilio API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Twilio TURN credentials generated, servers:', data.ice_servers?.length || 0);

    res.json({
      iceServers: data.ice_servers,
      ttl: data.ttl,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Twilio error:', error.message);
    res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      ttl: 86400,
      error: 'TURN temporarily unavailable'
    });
  }
});

// ============================================================
// REST ENDPOINTS
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Voice Signaling Server',
    users: users.size,
    mobileUsers: mobileTokens.size,
    apnsConfigured: !!apnProvider,
    timestamp: new Date().toISOString(),
    version: '3.0.0'
  });
});

app.get('/stats', (req, res) => {
  res.json({
    activeUsers: users.size,
    mobileTokens: mobileTokens.size,
    connectedSockets: io.sockets.sockets.size,
    apnsConfigured: !!apnProvider,
    uptime: process.uptime()
  });
});

app.get('/user/:userId/status', (req, res) => {
  const userId = req.params.userId;
  const user = users.get(userId);
  const mobile = mobileTokens.get(userId);

  res.json({
    userId,
    online: !!user,
    hasMobileToken: !!mobile,
    platform: mobile?.platform || null,
    lastSeen: user?.lastSeen || null
  });
});

app.post('/users/status', (req, res) => {
  const { userIds } = req.body;

  if (!Array.isArray(userIds)) {
    return res.status(400).json({ error: 'userIds must be an array' });
  }

  const statuses = {};
  userIds.forEach(userId => {
    const user = users.get(userId);
    const mobile = mobileTokens.get(userId);
    statuses[userId] = {
      online: !!user,
      hasMobileToken: !!mobile,
      lastSeen: user?.lastSeen || null
    };
  });

  res.json(statuses);
});

// ============================================================
// SOCKET.IO EVENTS
// ============================================================
io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);

  // Register user (works for both web extension and mobile)
  socket.on('register', (userId) => {
    if (!userId || typeof userId !== 'string') {
      socket.emit('error', { message: 'Invalid user ID' });
      return;
    }

    const existing = users.get(userId);
    if (existing && existing.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existing.socketId);
      if (oldSocket) {
        oldSocket.emit('replaced', { message: 'Connected from another location' });
        oldSocket.disconnect(true);
      }
    }

    users.set(userId, {
      socketId: socket.id,
      lastSeen: Date.now()
    });
    socket.userId = userId;

    socket.emit('registered', {
      userId,
      socketId: socket.id
    });

    console.log(`✅ User ${userId} registered (total: ${users.size})`);
  });

  // ============================================================
  // MOBILE: Register device token for push notifications
  // Called by mobile app after registering userId
  // ============================================================
  socket.on('register-device-token', (data) => {
    const { userId, deviceToken, platform, bundleId } = data;

    if (!userId || !deviceToken || !platform) {
      socket.emit('error', { message: 'Invalid device token data' });
      return;
    }

    if (!['ios', 'android'].includes(platform)) {
      socket.emit('error', { message: 'Platform must be ios or android' });
      return;
    }

    mobileTokens.set(userId, {
      deviceToken,
      platform,
      bundleId: bundleId || process.env.APNS_BUNDLE_ID,
      registeredAt: Date.now()
    });

    socket.emit('device-token-registered', { userId, platform });
    console.log(`📱 Device token registered for ${userId} (${platform})`);
  });

  // Unregister device token (on logout)
  socket.on('unregister-device-token', (userId) => {
    if (userId && mobileTokens.has(userId)) {
      mobileTokens.delete(userId);
      console.log(`📱 Device token removed for ${userId}`);
    }
  });

  // Keep alive / heartbeat
  socket.on('ping', () => {
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user) user.lastSeen = Date.now();
    }
    socket.emit('pong');
  });

  // Check user online status
  socket.on('check-user', (targetUserId, callback) => {
    const user = users.get(targetUserId);
    const mobile = mobileTokens.get(targetUserId);

    if (callback && typeof callback === 'function') {
      callback({
        online: !!user,
        reachable: !!user || !!mobile // online OR has push token
      });
    }
  });

  // Check multiple users status
  socket.on('check-users-status', (userIds) => {
    if (!Array.isArray(userIds)) return;

    const statuses = {};
    userIds.forEach(userId => {
      const user = users.get(userId);
      const mobile = mobileTokens.get(userId);
      statuses[userId] = {
        online: !!user,
        reachable: !!user || !!mobile,
        lastSeen: user?.lastSeen || null
      };
    });

    socket.emit('users-status', statuses);
  });

  // ============================================================
  // CALL SIGNALING
  // ============================================================

  // Initiate call (caller -> server -> receiver)
  socket.on('call-user', async (data) => {
    const { to, from, offer, callerName } = data;

    if (!to || !from || !offer) {
      socket.emit('call-error', { error: 'Invalid call data' });
      return;
    }

    console.log(`📞 Call: ${from} -> ${to}`);

    const recipient = users.get(to);

    if (recipient) {
      // Recipient is online — deliver directly
      io.to(recipient.socketId).emit('incoming-call', { from, offer, callerName });
      console.log(`  ✅ Forwarded to online user ${to}`);
    } else {
      // Recipient is offline — try push notification (mobile only)
      const pushed = await sendVoIPPush(to, {
        type: 'incoming-call',
        from,
        callerName: callerName || from,
        offer // Include offer so app can answer immediately after waking
      });

      if (pushed) {
        // Let caller know we sent a push, waiting for recipient to wake up
        socket.emit('call-ringing', { to, method: 'push' });
        console.log(`  📱 Push sent to offline user ${to}`);
      } else {
        socket.emit('user-offline', { to });
        console.log(`  ❌ User ${to} offline and no push token`);
      }
    }
  });

  // Renegotiation offer
  socket.on('renegotiate', (data) => {
    const { to, from, offer } = data;
    if (!to || !offer) return;

    const recipient = users.get(to);
    if (recipient) {
      io.to(recipient.socketId).emit('renegotiate', { from, offer });
    }
  });

  // Answer call
  socket.on('answer-call', (data) => {
    const { to, from, answer } = data;
    if (!to || !answer) return;

    const caller = users.get(to);
    if (caller) {
      io.to(caller.socketId).emit('call-answered', { from, answer });
    }
  });

  // ICE candidate exchange
  socket.on('ice-candidate', (data) => {
    const { to, from, candidate } = data;
    if (!to || !candidate) return;

    const recipient = users.get(to);
    if (recipient) {
      io.to(recipient.socketId).emit('ice-candidate', {
        from: from || socket.userId,
        candidate
      });
    }
  });

  // End call
  socket.on('end-call', (data) => {
    const { to } = data;
    if (!to) return;

    const recipient = users.get(to);
    if (recipient) {
      io.to(recipient.socketId).emit('call-ended', { from: socket.userId });
    }
  });

  // Decline call
  socket.on('decline-call', (data) => {
    const { to } = data;
    if (!to) return;

    const recipient = users.get(to);
    if (recipient) {
      io.to(recipient.socketId).emit('call-declined', { from: socket.userId });
    }
  });

  // ============================================================
  // CHAT MESSAGING
  // ============================================================

  socket.on('chat-message', (data) => {
    const { to, from, message, messageId, timestamp } = data;
    if (!to || !message) return;

    const recipient = users.get(to);

    if (recipient) {
      io.to(recipient.socketId).emit('chat-message', { from, message, messageId, timestamp });
      socket.emit('message-delivered', { to, messageId });
      console.log(`💬 Message delivered: ${from} -> ${to}`);
    } else {
      socket.emit('message-pending', { to, messageId, reason: 'User offline' });
      console.log(`⏳ Message pending: ${from} -> ${to} (offline)`);
    }
  });

  socket.on('typing', (data) => {
    const { to, from, isTyping } = data;
    if (!to) return;

    const recipient = users.get(to);
    if (recipient) {
      io.to(recipient.socketId).emit('typing', { from, isTyping });
    }
  });

  socket.on('message-read', (data) => {
    const { to, from, messageIds } = data;
    if (!to || !messageIds) return;

    const recipient = users.get(to);
    if (recipient) {
      io.to(recipient.socketId).emit('message-read', { from, messageIds });
    }
  });

  // ============================================================
  // DISCONNECT
  // ============================================================
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Disconnected: ${socket.id} (${reason})`);

    if (socket.userId) {
      users.delete(socket.userId);
      // Note: we keep mobileTokens on disconnect so push still works
      console.log(`  User ${socket.userId} removed (total: ${users.size})`);
    }
  });
});

// ============================================================
// CLEANUP STALE USERS (every 5 minutes)
// ============================================================
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;

  for (const [userId, userData] of users.entries()) {
    if (now - userData.lastSeen > staleThreshold) {
      const socket = io.sockets.sockets.get(userData.socketId);
      if (!socket || !socket.connected) {
        users.delete(userId);
        console.log(`🧹 Cleaned stale user: ${userId}`);
      }
    }
  }
}, 5 * 60 * 1000);

// Cleanup very old mobile tokens (30 days inactive)
setInterval(() => {
  const now = Date.now();
  const tokenExpiry = 30 * 24 * 60 * 60 * 1000;

  for (const [userId, tokenData] of mobileTokens.entries()) {
    if (now - tokenData.registeredAt > tokenExpiry) {
      mobileTokens.delete(userId);
      console.log(`🧹 Cleaned expired device token: ${userId}`);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`   Twilio configured: ${!!process.env.TWILIO_ACCOUNT_SID}`);
  console.log(`   APNs configured: ${!!apnProvider}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  io.emit('server-shutdown', { message: 'Server restarting' });

  if (apnProvider) apnProvider.shutdown();

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
