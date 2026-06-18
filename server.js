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
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'audio';

console.log('SUPABASE_URL loaded:', SUPABASE_URL ? 'YES' : 'NO');
console.log('SUPABASE_ANON_KEY loaded:', SUPABASE_ANON_KEY ? 'YES' : 'NO');
console.log('SUPABASE_SERVICE_ROLE_KEY loaded:', SUPABASE_SERVICE_ROLE_KEY ? 'YES' : 'NO');
console.log('SUPABASE_STORAGE_BUCKET:', SUPABASE_STORAGE_BUCKET);
console.log('SUPABASE_URL value:', process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY length:', process.env.SUPABASE_ANON_KEY ? process.env.SUPABASE_ANON_KEY.length : 0);

// Database (PostgreSQL / Supabase)
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (DATABASE_URL) {
  console.log('DATABASE_URL loaded: YES');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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
} else {
  console.warn('DATABASE_URL is not set. Skipping postgres pool initialization.');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use((req, res, next) => {
  if (req.path.includes('//')) {
    const normalizedUrl = req.originalUrl.replace(/\/\/+/, '/');
    return res.redirect(301, normalizedUrl);
  }
  next();
});
app.use(express.static('public'));

// Serve root-level static files needed by the UI
app.get('/api-config.js', (req, res) => res.sendFile(path.join(__dirname, 'api-config.js')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve HTML files from root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/department_dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'department_dashboard.html')));
app.get('/director_dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'director_dashboard.html')));
app.get('/request.html', (req, res) => res.sendFile(path.join(__dirname, 'request.html')));
app.get('/qr-generator.html', (req, res) => res.sendFile(path.join(__dirname, 'qr-generator.html')));

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

// Supabase REST API helper functions
async function supabaseInsert(table, data) {
  const isUsingServiceRole = Boolean(SUPABASE_SERVICE_ROLE_KEY);
  const authKey = isUsingServiceRole ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': authKey,
      'Authorization': `Bearer ${authKey}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase insert failed: ${error}`);
  }

  return response.json();
}

async function supabaseSelect(table, filters = {}) {
  const params = new URLSearchParams(filters).toString();
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase select failed: ${error}`);
  }
  
  return response.json();
}

async function supabaseDelete(table, filterQuery) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Service role key required for delete');
  const url = `${SUPABASE_URL}/rest/v1/${table}${filterQuery ? '?' + filterQuery : ''}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer': 'return=representation'
    }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase delete failed: ${error}`);
  }
  return response.json();
}

async function supabaseStorageUpload(bucket, objectPath, fileBuffer, contentType = 'application/octet-stream') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase storage is not configured');
  }
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(objectPath)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType
    },
    body: fileBuffer
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase storage upload failed: ${error}`);
  }
  return response.json();
}

function getSupabaseStoragePublicUrl(bucket, objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(objectPath)}`;
}

async function insertRequestViaDatabase(requestData) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const result = await pool.query(
    `INSERT INTO requests (room_number, service, request_text, status, voice_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, room_number, service, request_text, status, voice_url, created_at, updated_at`,
    [
      requestData.room_number,
      requestData.service,
      requestData.request_text,
      requestData.status,
      requestData.voice_url,
      requestData.created_at,
      requestData.created_at
    ]
  );

  return result.rows[0];
}

// Create new request (from guest interface)
app.post('/api/requests', upload.single('voice'), async (req, res) => {
  console.log('POST /api/requests called');
  console.log('Body:', req.body);
  console.log('File:', req.file);

  const { roomNumber, service, requestText } = req.body;
  let voiceUrl = req.file ? `/uploads/${req.file.filename}` : null;

  if (!roomNumber || !service || !requestText) {
    console.log('Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (req.file && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const objectPath = req.file.filename;
    try {
      const fileBuffer = await fs.promises.readFile(req.file.path);
      await supabaseStorageUpload(SUPABASE_STORAGE_BUCKET, objectPath, fileBuffer, req.file.mimetype || 'audio/webm');
      voiceUrl = getSupabaseStoragePublicUrl(SUPABASE_STORAGE_BUCKET, objectPath);
      fs.unlink(req.file.path, () => {});
      console.log('Uploaded voice file to Supabase storage:', voiceUrl);
    } catch (storageErr) {
      console.error('Supabase storage upload failed, using local upload fallback:', storageErr.message);
      voiceUrl = `/uploads/${req.file.filename}`;
    }
  } else if (req.file) {
    console.warn('Supabase storage upload skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured. Using local uploads.');
  }

  try {
    const requestData = {
      room_number: roomNumber,
      service: service,
      request_text: requestText,
      voice_url: voiceUrl,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    console.log('Inserting via Supabase REST API:', requestData);
    let newRequest;

    try {
      newRequest = await supabaseInsert('requests', requestData);
    } catch (supabaseErr) {
      console.error('Supabase insert failed, trying database fallback:', supabaseErr.message);
      newRequest = await insertRequestViaDatabase(requestData);
    }

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
    const rows = await supabaseSelect('requests', { order: 'created_at.desc' });
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
    // Use Supabase REST API with filter
    const allRequests = await supabaseSelect('requests', { order: 'created_at.desc' });
    const filtered = allRequests.filter(r => services.includes(r.service));
    res.json(filtered);
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
    // Use Supabase REST API to update with server-side auth when available
    const updateKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    if (!updateKey) {
      throw new Error('Missing Supabase auth key for status update');
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/requests?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': updateKey,
        'Authorization': `Bearer ${updateKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });

    if (!response.ok) {
      throw new Error('Failed to update request');
    }

    const updated = await response.json();
    if (!updated.length) {
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
    // Use Supabase REST API if configured
    let departments = [];
    let row = null;

    try {
      departments = await supabaseSelect('departments', { name: `eq.${department}` });
      row = departments[0];
    } catch (err) {
      console.warn('Supabase departments lookup failed, falling back to demo auth:', err.message || err);
    }

    const demoPassword = getPlainPassword(department);
    if (!row && !demoPassword) {
      return res.status(401).json({ error: 'Invalid department' });
    }

    // For demo, use plain text passwords (in production, use hashed)
    const isValidPassword = password === demoPassword;

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const departmentName = row?.name || department;
    const token = jwt.sign({ type: 'department', department: departmentName }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, department: departmentName });
  } catch (err) {
    console.error('Error authenticating department:', err);
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
    // Use Supabase REST API
    const directors = await supabaseSelect('director', { username: `eq.${username}` });
    const row = directors[0];

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

// Password reset requests: persist to DB when available, otherwise fallback to in-memory
let passwordResetRequests = [];

app.post('/api/password_resets', async (req, res) => {
  const { dept } = req.body;
  if (!dept) return res.status(400).json({ error: 'Department required' });

  // Prefer Supabase REST API when configured
  if (SUPABASE_URL) {
    try {
      const inserted = await supabaseInsert('password_resets', { dept, status: 'pending', created_at: new Date().toISOString() });
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      const out = { id: row.id, dept: row.dept, time: row.created_at };
      io.emit('passwordReset', out);
      return res.status(201).json(out);
    } catch (err) {
      console.error('Supabase insert password_reset failed:', err);
      // fall through to pool or memory
    }
  }

  if (pool) {
    try {
      const result = await pool.query(
        'INSERT INTO password_resets (dept, status, created_at) VALUES ($1, $2, NOW()) RETURNING id, dept, status, created_at',
        [dept, 'pending']
      );
      const row = result.rows[0];
      const out = { id: row.id, dept: row.dept, time: row.created_at };
      io.emit('passwordReset', out);
      return res.status(201).json(out);
    } catch (err) {
      console.error('DB insert password_reset failed:', err);
      // fall back to in-memory storage rather than failing completely
    }
  }

  // fallback in-memory
  const entry = { id: Date.now(), dept, time: new Date().toISOString(), status: 'pending' };
  passwordResetRequests.unshift(entry);
  io.emit('passwordReset', entry);
  res.status(201).json(entry);
});

app.get('/api/password_resets', async (req, res) => {
  // Prefer Supabase REST API when configured
  if (SUPABASE_URL) {
    try {
      const rows = await supabaseSelect('password_resets', { order: 'created_at.desc' });
      const out = (rows || []).map(r => ({ id: r.id, dept: r.dept, time: r.created_at }));
      return res.json(out);
    } catch (err) {
      console.error('Supabase fetch password_resets failed:', err);
      // fall through to pool or memory
    }
  }

  if (pool) {
    try {
      const result = await pool.query('SELECT id, dept, status, created_at FROM password_resets ORDER BY created_at DESC');
      const rows = result.rows.map(r => ({ id: r.id, dept: r.dept, time: r.created_at }));
      return res.json(rows);
    } catch (err) {
      console.error('DB fetch password_resets failed:', err);
      // fall back to in-memory storage instead of failing
    }
  }

  return res.json(passwordResetRequests);
});

app.put('/api/password_resets/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  // Prefer Supabase REST API when configured
  if (SUPABASE_URL) {
    try {
      // delete via Supabase REST API using service role key
      const deleted = await supabaseDelete('password_resets', `id=eq.${id}`);
      const removed = Array.isArray(deleted) ? deleted[0] : deleted;
      io.emit('passwordResetApproved', { id: removed.id, dept: removed.dept });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Supabase delete password_reset failed:', err);
      // fall through to pool or memory
    }
  }

  if (pool) {
    try {
      const result = await pool.query('DELETE FROM password_resets WHERE id = $1 RETURNING id, dept', [id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      const removed = result.rows[0];
      io.emit('passwordResetApproved', { id: removed.id, dept: removed.dept });
      return res.json({ ok: true });
    } catch (err) {
      console.error('DB delete password_reset failed:', err);
      // fall back to in-memory storage instead of failing
    }
  }

  const idx = passwordResetRequests.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const removed = passwordResetRequests.splice(idx, 1)[0];
  io.emit('passwordResetApproved', { id: removed.id, dept: removed.dept });
  res.json({ ok: true });
});