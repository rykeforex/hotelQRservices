const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Listen for client-side events
  socket.on('requestCreated', (newRequest) => {
    console.log('Request created via Supabase:', newRequest);
    socket.broadcast.emit('newRequest', newRequest);
  });

  socket.on('statusUpdated', (update) => {
    console.log('Status updated via Supabase:', update);
    socket.broadcast.emit('statusUpdate', update);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
  console.log(`Real-time updates enabled for Supabase operations`);
});