require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createServer } = require('http');
const { Server } = require('socket.io');

console.log('CWD:', process.cwd());
console.log('.env file exists:', fs.existsSync('.env'));

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'luxehotel2026';

// Supabase client config from env
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

console.log('SUPABASE_URL loaded:', SUPABASE_URL ? 'YES' : 'NO');
console.log('SUPABASE_ANON_KEY loaded:', SUPABASE_ANON_KEY ? 'YES' : 'NO');
console.log('SUPABASE_URL value:', process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY length:', process.env.SUPABASE_ANON_KEY ? process.env.SUPABASE_ANON_KEY.length : 0);

// Database (PostgreSQL / Supabase)
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Set it to your Supabase/Postgres URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  if (process.env.INIT_DB !== 'true') return;
  try {
    const sql = await fs.promises.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Database schema initialized.');
  } catch (err) {
    console.error('Error initializing database schema:', err);
  }
}

initDb().catch(console.error);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve HTML files from root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/department_dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'department_dashboard.html')));
app.get('/director_dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'director_dashboard.html')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for voice uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Frontend config endpoint (pass safe env vars)
app.get('/api/config', (req, res) => {
  console.log('/api/config called');
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return res.status(500).json({ error: 'Supabase config is missing on server' });
  }
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// Create new request (from guest interface)
app.post('/api/requests', upload.single('voice'), async (req, res) => {
  console.log('POST /api/requests called');
  console.log('Body:', req.body);
  console.log('File:', req.file);

  const { roomNumber, service, requestText } = req.body;
  const voiceUrl = req.file ? `/uploads/${req.file.filename}` : null;

  if (!roomNumber || !service || !requestText) {
    console.log('Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const insert = `
      INSERT INTO requests (room_number, service, request_text, voice_url)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    console.log('Executing insert:', [roomNumber, service, requestText, voiceUrl]);
    const { rows } = await pool.query(insert, [roomNumber, service, requestText, voiceUrl]);
    const newRequest = rows[0];

    console.log('Insert successful:', newRequest);
    io.emit('newRequest', newRequest);
    res.status(201).json(newRequest);
  } catch (err) {
    console.error('Error creating request:', err);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// Get all requests (for director)
app.get('/api/requests', async (req, res) => {
  try {
    const sql = `SELECT * FROM requests ORDER BY created_at DESC`;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching requests:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Get requests for specific department
app.get('/api/requests/:department', async (req, res) => {
  const department = req.params.department;

  const deptToServices = {
    'Maintenance': ['maintenance', 'report'],
    'Housekeeping': ['housekeeping', 'towels', 'donotdisturb'],
    'Room Service': ['roomservice'],
    'Concierge': ['concierge'],
    'Laundry': ['laundry']
  };

  const services = deptToServices[department];
  if (!services) {
    return res.status(400).json({ error: 'Invalid department' });
  }

  try {
    const placeholders = services.map((_, idx) => `$${idx + 1}`).join(',');
    const sql = `SELECT * FROM requests WHERE service IN (${placeholders}) ORDER BY created_at DESC`;
    const { rows } = await pool.query(sql, services);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching department requests:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Update request status
app.put('/api/requests/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['pending', 'in-progress', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const sql = `
      UPDATE requests
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id
    `;
    const { rowCount } = await pool.query(sql, [status, id]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    io.emit('statusUpdate', { id: parseInt(id), status });

    res.json({ id: parseInt(id), status });
  } catch (err) {
    console.error('Error updating request:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// Department login
app.post('/api/auth/department', async (req, res) => {
  const { department, password } = req.body;

  if (!department || !password) {
    return res.status(400).json({ error: 'Department and password required' });
  }

  try {
    const sql = `SELECT * FROM departments WHERE name = $1`;
    const { rows } = await pool.query(sql, [department]);
    const row = rows[0];

    if (!row) {
      return res.status(401).json({ error: 'Invalid department' });
    }

    // For demo, use plain text passwords (in production, use hashed)
    const isValidPassword = password === getPlainPassword(department);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ type: 'department', department: row.name }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, department: row.name });
  } catch (err) {
    console.error('Error fetching department:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Director login
app.post('/api/auth/director', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const sql = `SELECT * FROM director WHERE username = $1`;
    const { rows } = await pool.query(sql, [username]);
    const row = rows[0];

    if (!row) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // For demo, use plain text password
    const isValidPassword = password === 'pearl';

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ type: 'director', username: row.username }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, username: row.username });
  } catch (err) {
    console.error('Error fetching director:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Helper function for demo passwords
function getPlainPassword(department) {
  const passwords = {
    'Maintenance': 'wrench',
    'Housekeeping': 'broom',
    'Room Service': 'plate',
    'Concierge': 'bell',
    'Laundry': 'shirt'
  };
  return passwords[department];
}

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Start server
server.listen(PORT, () => {
  console.log(`LUXE Hotel Services Backend running on port ${PORT}`);
  console.log(`Socket.io enabled for real-time updates`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(0);
  });
});