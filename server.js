// server.js - Signaling Server

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Настройка Socket.io с CORS
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// Храним активных пользователей
const users = new Map();

// Простой healthcheck endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Voice Signaling Server',
    users: users.size,
    timestamp: new Date().toISOString()
  });
});

// Статистика
app.get('/stats', (req, res) => {
  res.json({
    activeUsers: users.size,
    connectedSockets: io.sockets.sockets.size
  });
});

// Socket.io события
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Регистрация пользователя
  socket.on('register', (userId) => {
    console.log(`User ${userId} registered with socket ${socket.id}`);
    
    users.set(userId, socket.id);
    socket.userId = userId;
    
    socket.emit('registered', { 
      userId: userId,
      socketId: socket.id 
    });
  });
  
  // Проверка онлайн статуса
  socket.on('check-user', (targetUserId, callback) => {
    const isOnline = users.has(targetUserId);
    console.log(`Checking if ${targetUserId} is online: ${isOnline}`);
    
    if (callback) {
      callback({ online: isOnline });
    }
  });
  
  // Инициация звонка
  socket.on('call-user', (data) => {
    const { to, from, offer } = data;
    
    console.log(`Call from ${from} to ${to}`);
    
    const recipientSocketId = users.get(to);
    
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('incoming-call', {
        from: from,
        offer: offer
      });
      
      console.log(`Call forwarded to ${to}`);
    } else {
      socket.emit('call-error', {
        to: to,
        error: 'User not online'
      });
      
      console.log(`User ${to} not found`);
    }
  });
  
  // Ответ на звонок
  socket.on('answer-call', (data) => {
    const { to, from, answer } = data;
    
    console.log(`Answer from ${from} to ${to}`);
    
    const callerSocketId = users.get(to);
    
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-answered', {
        from: from,
        answer: answer
      });
      
      console.log(`Answer forwarded to ${to}`);
    }
  });
  
  // Обмен ICE candidates
  socket.on('ice-candidate', (data) => {
    const { to, candidate } = data;
    
    const recipientSocketId = users.get(to);
    
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('ice-candidate', {
        from: socket.userId,
        candidate: candidate
      });
    }
  });
  
  // Завершение звонка
  socket.on('end-call', (data) => {
    const { to } = data;
    
    const recipientSocketId = users.get(to);
    
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call-ended', {
        from: socket.userId
      });
    }
  });
  
  // Отключение
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    
    if (socket.userId) {
      users.delete(socket.userId);
      console.log(`User ${socket.userId} removed`);
    }
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
