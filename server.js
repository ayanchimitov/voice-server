// server.js - Signaling Server with Twilio TURN

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

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

// Active users: userId -> { socketId, lastSeen }
const users = new Map();

// ============================================================
// TWILIO TURN CREDENTIALS
// ============================================================
app.get('/turn-credentials', async (req, res) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    console.error('❌ Twilio credentials not configured');
    // Return fallback public STUN servers
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
    // Twilio Network Traversal Service API
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
    
    // Fallback to public STUN only
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
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

app.get('/stats', (req, res) => {
  res.json({
    activeUsers: users.size,
    connectedSockets: io.sockets.sockets.size,
    uptime: process.uptime()
  });
});

// Check if user is online (REST endpoint for pre-call check)
app.get('/user/:userId/status', (req, res) => {
  const userId = req.params.userId;
  const user = users.get(userId);
  
  res.json({
    userId: userId,
    online: !!user,
    lastSeen: user?.lastSeen || null
  });
});

// ============================================================
// SOCKET.IO EVENTS
// ============================================================
io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  // Register user
  socket.on('register', (userId) => {
    if (!userId || typeof userId !== 'string') {
      socket.emit('error', { message: 'Invalid user ID' });
      return;
    }
    
    // Remove old socket if exists
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
      userId: userId,
      socketId: socket.id 
    });
    
    console.log(`✅ User ${userId} registered (total: ${users.size})`);
  });
  
  // Keep alive / heartbeat
  socket.on('ping', () => {
    if (socket.userId) {
      const user = users.get(socket.userId);
      if (user) {
        user.lastSeen = Date.now();
      }
    }
    socket.emit('pong');
  });
  
  // Check user online status
  socket.on('check-user', (targetUserId, callback) => {
    const user = users.get(targetUserId);
    const isOnline = !!user;
    
    if (callback && typeof callback === 'function') {
      callback({ online: isOnline });
    }
  });
  
  // ============================================================
  // CALL SIGNALING
  // ============================================================
  
  // Initiate call (caller -> server -> receiver)
  socket.on('call-user', (data) => {
    const { to, from, offer } = data;
    
    if (!to || !from || !offer) {
      socket.emit('call-error', { error: 'Invalid call data' });
      return;
    }
    
    console.log(`📞 Call: ${from} -> ${to}`);
    
    const recipient = users.get(to);
    
    if (recipient) {
      io.to(recipient.socketId).emit('incoming-call', {
        from: from,
        offer: offer
      });
      console.log(`  ✅ Forwarded to ${to}`);
    } else {
      socket.emit('user-offline', { to: to });
      console.log(`  ❌ User ${to} offline`);
    }
  });
  
  // Renegotiation offer (for adding/removing video during call)
  socket.on('renegotiate', (data) => {
    const { to, from, offer } = data;
    
    if (!to || !offer) return;
    
    console.log(`🔄 Renegotiation: ${from} -> ${to}`);
    
    const recipient = users.get(to);
    
    if (recipient) {
      io.to(recipient.socketId).emit('renegotiate', {
        from: from,
        offer: offer
      });
      console.log(`  ✅ Renegotiation forwarded to ${to}`);
    }
  });
  
  // Answer call (receiver -> server -> caller)
  socket.on('answer-call', (data) => {
    const { to, from, answer } = data;
    
    if (!to || !answer) {
      return;
    }
    
    console.log(`✅ Answer: ${from} -> ${to}`);
    
    const caller = users.get(to);
    
    if (caller) {
      io.to(caller.socketId).emit('call-answered', {
        from: from,
        answer: answer
      });
    }
  });
  
  // ICE candidate exchange
  socket.on('ice-candidate', (data) => {
    const { to, from, candidate } = data;
    
    if (!to || !candidate) {
      return;
    }
    
    const recipient = users.get(to);
    
    if (recipient) {
      io.to(recipient.socketId).emit('ice-candidate', {
        from: from || socket.userId,
        candidate: candidate
      });
    }
  });
  
  // End call
  socket.on('end-call', (data) => {
    const { to } = data;
    
    if (!to) return;
    
    console.log(`📴 End call: ${socket.userId} -> ${to}`);
    
    const recipient = users.get(to);
    
    if (recipient) {
      io.to(recipient.socketId).emit('call-ended', {
        from: socket.userId
      });
    }
  });
  
  // Decline call
  socket.on('decline-call', (data) => {
    const { to } = data;
    
    if (!to) return;
    
    const recipient = users.get(to);
    
    if (recipient) {
      io.to(recipient.socketId).emit('call-declined', {
        from: socket.userId
      });
    }
  });
  
  // ============================================================
  // DISCONNECT
  // ============================================================
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Disconnected: ${socket.id} (${reason})`);
    
    if (socket.userId) {
      users.delete(socket.userId);
      console.log(`  User ${socket.userId} removed (total: ${users.size})`);
    }
  });
});

// ============================================================
// CLEANUP STALE USERS (every 5 minutes)
// ============================================================
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
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

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`   Twilio configured: ${!!process.env.TWILIO_ACCOUNT_SID}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  
  // Notify all connected users
  io.emit('server-shutdown', { message: 'Server restarting' });
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
