require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const dns = require('dns');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createServer } = require('http');
const { Server } = require('socket.io');

dns.setDefaultResultOrder('ipv4first');


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
const SMTP_HOST = process.env.SMTP_HOST || process.env.BREVO_SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || process.env.BREVO_SMTP_PORT || '587', 10);
const SMTP_SECURE = String(process.env.SMTP_SECURE || process.env.BREVO_SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || process.env.BREVO_SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || process.env.BREVO_SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.BREVO_SMTP_FROM || 'no-reply@luxehotel.com';

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

  async function ensureVerificationColumns() {
    if (!pool) return;
    await pool.query(`
      ALTER TABLE hotel_admin_users
      ADD COLUMN IF NOT EXISTS verification_token TEXT,
      ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    `);
  }

  initDb().catch(console.error);
  ensureVerificationColumns().catch(console.error);
} else {
  console.warn('DATABASE_URL is not set. Skipping postgres pool initialization.');
}

// Middleware
const allowedCorsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['*'];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins[0] === '*' || allowedCorsOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn('CORS origin denied:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Hotel-Id'],
  exposedHeaders: ['Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
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
app.get('/hotel_admin.html', (req, res) => res.sendFile(path.join(__dirname, 'hotel_admin.html')));
app.get('/request.html', (req, res) => res.sendFile(path.join(__dirname, 'request.html')));
app.get('/qr-generator.html', (req, res) => res.sendFile(path.join(__dirname, 'qr-generator.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));

// Use memory storage for uploads to avoid persisting files in the repository
const upload = multer({ storage: multer.memoryStorage() });

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinHotel', (hotelId) => {
    try {
      if (hotelId) {
        const rid = `hotel_${hotelId}`;
        socket.join(rid);
        console.log(`Socket ${socket.id} joined room ${rid}`);
      }
    } catch (e) { console.warn('joinHotel failed', e); }
  });

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

async function supabaseGetSignedUrl(bucket, objectPath, expiresInSec = 60*60) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service role key is not configured for signing URLs');
  }
  const base = SUPABASE_URL.replace(/\/$/, '');
  const signUrl = `${base}/storage/v1/object/sign/${bucket}/${encodeURIComponent(objectPath)}`;
  const resp = await fetch(signUrl, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: expiresInSec })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<no body>');
    throw new Error(`Failed to get signed URL: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  // data.signedURL may be a relative path (e.g. "/object/sign/...?..."), make it absolute
  const rel = data.signedURL || data.signed_url || data.signedUrl || data?.signedURL;
  if (!rel) return null;
  if (rel.startsWith('http')) return rel;
  return `${base}/storage/v1${rel}`;
}

function parseHotelIdFromRequest(req) {
  const rawHotelId = req.body?.hotelId ?? req.body?.hotel_id ?? req.query?.hotelId ?? req.query?.hotel_id ?? req.headers['x-hotel-id'];
  const hotelId = parseInt(String(rawHotelId || '').trim(), 10);
  return Number.isInteger(hotelId) && hotelId > 0 ? hotelId : null;
}

function buildVerificationUrl(req, token) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || 'localhost:3000';
  return `${protocol}://${host}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail(to, verifyUrl, hotelName) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[EMAIL] SMTP not configured. Verification email not sent. To=${to} Link=${verifyUrl}`);
    return { ok: true, skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  const info = await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: `Verify your ${hotelName} admin account`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1c1a17;">
        <h2>Verify your hotel admin account</h2>
        <p>Hello,</p>
        <p>Your account for <strong>${hotelName}</strong> has been created. Please verify your email address to activate the account.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 16px;background:#C9A84C;color:#fff;text-decoration:none;border-radius:999px;">Verify Email</a></p>
        <p>If the button does not work, copy and paste this link into your browser:</p>
        <p>${verifyUrl}</p>
      </div>
    `
  });

  console.log(`[EMAIL] Verification email sent to ${to}: ${info.messageId}`);
  return { ok: true, skipped: false, messageId: info.messageId };
}

async function insertRequestViaDatabase(requestData) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const columns = ['room_number', 'service', 'request_text', 'status', 'voice_url', 'created_at', 'updated_at'];
  const values = [
    requestData.room_number,
    requestData.service,
    requestData.request_text,
    requestData.status,
    requestData.voice_url,
    requestData.created_at,
    requestData.created_at
  ];

  if (requestData.hotel_id) {
    columns.unshift('hotel_id');
    values.unshift(requestData.hotel_id);
  }

  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  const result = await pool.query(
    `INSERT INTO requests (${columns.join(', ')})
     VALUES (${placeholders})
     RETURNING id, hotel_id, room_number, service, request_text, status, voice_url, created_at, updated_at`,
    values
  );

  return result.rows[0];
}

// Create new request (from guest interface)
app.post('/api/requests', upload.single('voice'), async (req, res) => {
  console.log('POST /api/requests called');
  console.log('Body:', req.body);
  console.log('File:', req.file);

  const hotelId = parseHotelIdFromRequest(req);
  if (!hotelId) {
    console.log('hotelId missing in request body/query/header');
    return res.status(400).json({ error: 'hotelId is required' });
  }
  const { roomNumber, service, requestText } = req.body;
  let voiceUrl = null;

  if (!roomNumber || !service || !requestText) {
    console.log('Missing required fields');
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (req.file) {
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      // create a reasonably unique object path
      const safeName = (req.file.originalname || 'voice').replace(/[^a-zA-Z0-9._-]/g, '-');
      const objectPath = `voice-${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
      try {
        const fileBuffer = req.file.buffer;
        await supabaseStorageUpload(SUPABASE_STORAGE_BUCKET, objectPath, fileBuffer, req.file.mimetype || 'audio/webm');
        voiceUrl = getSupabaseStoragePublicUrl(SUPABASE_STORAGE_BUCKET, objectPath);
        console.log('Uploaded voice file to Supabase storage:', voiceUrl);
      } catch (storageErr) {
        console.error('Supabase storage upload failed; discarding uploaded file buffer:', storageErr.message);
        // Do not persist to disk or return local URLs - drop the voice
        voiceUrl = null;
      }
    } else {
      console.warn('Supabase storage not configured (SUPABASE_SERVICE_ROLE_KEY missing). Discarding uploaded file buffer to avoid saving in repo.');
      // intentionally drop the uploaded buffer and do not save locally
      voiceUrl = null;
    }
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
    if (hotelId) {
      requestData.hotel_id = hotelId;
    }

    console.log('Inserting via Supabase REST API:', requestData);
    let newRequest;

    try {
      newRequest = await supabaseInsert('requests', requestData);
      if (Array.isArray(newRequest)) {
        newRequest = newRequest[0] || null;
      }
    } catch (supabaseErr) {
      console.error('Supabase insert failed, trying database fallback:', supabaseErr.message);
      newRequest = await insertRequestViaDatabase(requestData);
    }

    console.log('Insert successful:', newRequest);

    // Sign voice URL if present before broadcasting/returning
    if (newRequest && newRequest.voice_url && typeof newRequest.voice_url === 'string') {
      try {
        if (newRequest.voice_url.includes('/storage/v1/object/public/')) {
          // Extract object path after bucket name
          const marker = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
          const idx = newRequest.voice_url.indexOf(marker);
          if (idx !== -1) {
            const objectPath = decodeURIComponent(newRequest.voice_url.slice(idx + marker.length));
            if (SUPABASE_SERVICE_ROLE_KEY) {
              const signed = await supabaseGetSignedUrl(SUPABASE_STORAGE_BUCKET, objectPath);
              newRequest.voice_url = signed || null;
            } else {
              newRequest.voice_url = null;
            }
          }
        }
      } catch (e) {
        console.error('Failed to sign voice URL for broadcast:', e.message);
        newRequest.voice_url = null;
      }
    }

    if (newRequest && newRequest.hotel_id) {
      io.to(`hotel_${newRequest.hotel_id}`).emit('newRequest', newRequest);
    } else {
      io.emit('newRequest', newRequest);
    }
    res.status(201).json(newRequest);
  } catch (err) {
    console.error('Error creating request:', err);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// Get all requests (for director)
app.get('/api/requests', async (req, res) => {
  try {
    const hotelId = parseHotelIdFromRequest(req);
    if (!hotelId) return res.status(400).json({ error: 'hotelId is required' });
    const filters = { order: 'created_at.desc', hotel_id: `eq.${hotelId}` };
    const rows = await supabaseSelect('requests', filters);
    // Sanitize any legacy local upload URLs so dashboards don't pull from repo
    const sanitized = await Promise.all((rows || []).map(async (r) => {
      if (!r || !r.voice_url) return r;
      try {
        if (typeof r.voice_url === 'string' && r.voice_url.startsWith('/uploads')) {
          r.voice_url = null;
        } else if (typeof r.voice_url === 'string' && r.voice_url.includes('/storage/v1/object/public/')) {
          // Extract object path portion after the bucket
          const marker = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
          const idx = r.voice_url.indexOf(marker);
          if (idx !== -1) {
            const objectPath = decodeURIComponent(r.voice_url.slice(idx + marker.length));
            if (SUPABASE_SERVICE_ROLE_KEY) {
              try {
                const signed = await supabaseGetSignedUrl(SUPABASE_STORAGE_BUCKET, objectPath);
                r.voice_url = signed || null;
              } catch (e) {
                console.error('Failed to sign existing object URL:', e.message);
                r.voice_url = null;
              }
            } else {
              r.voice_url = null;
            }
          } else {
            r.voice_url = null;
          }
        }
      } catch (e) {
        r.voice_url = null;
      }
      return r;
    }));
    res.json(sanitized);
  } catch (err) {
    console.error('Error fetching requests:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Get requests for specific department
app.get('/api/requests/:department', async (req, res) => {
  const department = req.params.department;
  const hotelId = parseHotelIdFromRequest(req);
  if (!hotelId) return res.status(400).json({ error: 'hotelId is required' });

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
    const filters = { order: 'created_at.desc' };
    if (hotelId) filters.hotel_id = `eq.${hotelId}`;
    const allRequests = await supabaseSelect('requests', filters);
    const filtered = allRequests.filter(r => services.includes(r.service));
    // Sanitize legacy local upload URLs and sign storage URLs
    const sanitized = await Promise.all((filtered || []).map(async (r) => {
      if (!r || !r.voice_url) return r;
      try {
        if (typeof r.voice_url === 'string' && r.voice_url.startsWith('/uploads')) {
          r.voice_url = null;
        } else if (typeof r.voice_url === 'string' && r.voice_url.includes('/storage/v1/object/public/')) {
          const marker = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
          const idx = r.voice_url.indexOf(marker);
          if (idx !== -1) {
            const objectPath = decodeURIComponent(r.voice_url.slice(idx + marker.length));
            if (SUPABASE_SERVICE_ROLE_KEY) {
              try {
                const signed = await supabaseGetSignedUrl(SUPABASE_STORAGE_BUCKET, objectPath);
                r.voice_url = signed || null;
              } catch (e) {
                console.error('Failed to sign existing object URL:', e.message);
                r.voice_url = null;
              }
            } else {
              r.voice_url = null;
            }
          } else {
            r.voice_url = null;
          }
        }
      } catch (e) {
        r.voice_url = null;
      }
      return r;
    }));
    res.json(sanitized);
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
    const supabaseAuthKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    const useServiceRole = !!SUPABASE_SERVICE_ROLE_KEY;

    // Use Supabase REST API to update with service role privileges when available
    const hotelId = parseHotelIdFromRequest(req);
    if (!hotelId) return res.status(400).json({ error: 'hotelId is required' });
    const requestPatchUrl = `${SUPABASE_URL}/rest/v1/requests?id=eq.${id}${hotelId ? `&hotel_id=eq.${hotelId}` : ''}`;
  const response = await fetch(requestPatchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAuthKey,
        'Authorization': `Bearer ${supabaseAuthKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[STATUS_UPDATE] Supabase update failed:', response.status, errorText);
      return res.status(500).json({ error: 'Failed to update request', details: errorText });
    }

    const updated = await response.json();
    if (!Array.isArray(updated) || updated.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const hotelIdForUpdate = updated[0]?.hotel_id || null;
    console.log(`[STATUS_UPDATE] Request ${id} updated to ${status} using ${useServiceRole ? 'SERVICE_ROLE' : 'ANON'} key`);
    if (hotelIdForUpdate) {
      io.to(`hotel_${hotelIdForUpdate}`).emit('statusUpdate', { id: parseInt(id), status, hotel_id: hotelIdForUpdate });
    } else {
      io.emit('statusUpdate', { id: parseInt(id), status, hotel_id: hotelIdForUpdate });
    }
    res.json({ id: parseInt(id), status, hotel_id: hotelIdForUpdate });
  } catch (err) {
    console.error('[STATUS_UPDATE] Error updating request:', err);
    res.status(500).json({ error: 'Failed to update request', details: err.message });
  }
});

// Department login
app.post('/api/auth/department', async (req, res) => {
  const hotelId = parseHotelIdFromRequest(req);
  const { department, password } = req.body;

  if (!department || !password) {
    return res.status(400).json({ error: 'Department and password required' });
  }

  try {
    const filters = { name: `eq.${department}` };
    if (hotelId) filters.hotel_id = `eq.${hotelId}`;
    const departments = await supabaseSelect('departments', filters);
    const row = departments[0];

    if (!row) {
      return res.status(401).json({ error: 'Invalid department or password' });
    }

    if (!row.password_hash) {
      return res.status(501).json({ error: 'Department authentication is not configured. Use a hashed password in password_hash.' });
    }
    const isValidPassword = await bcrypt.compare(password, row.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid department or password' });
    }

    const token = jwt.sign({ type: 'department', department: row.name }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, department: row.name });
  } catch (err) {
    console.error('Error authenticating department:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  if (!requireDatabase(res)) return;

  await ensureVerificationColumns().catch(() => {});

  const { hotelName, fullName, email, password, confirmPassword } = req.body;
  const trimmedHotelName = String(hotelName || '').trim();
  const trimmedFullName = String(fullName || '').trim();
  const trimmedEmail = String(email || '').trim().toLowerCase();

  if (!trimmedHotelName || !trimmedFullName || !trimmedEmail || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Hotel name, full name, email, and password are required.' });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  if (String(password) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingUser = await client.query(
      `SELECT id FROM hotel_admin_users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
      [trimmedEmail]
    );
    if (existingUser.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hotelResult = await client.query(
      `INSERT INTO hotels (name, contact_email, timezone, language, date_format, created_at, updated_at)
       VALUES ($1, $2, 'UTC', 'en', 'MMM D, YYYY', NOW(), NOW())
       RETURNING id, name`,
      [trimmedHotelName, trimmedEmail]
    );
    const hotel = hotelResult.rows[0];

    const roleResult = await client.query(
      `SELECT id FROM hotel_admin_roles WHERE hotel_id = $1 AND LOWER(name) = LOWER('Hotel Admin') LIMIT 1`,
      [hotel.id]
    );
    let roleId = roleResult.rows[0]?.id || null;
    if (!roleId) {
      const newRole = await client.query(
        `INSERT INTO hotel_admin_roles (hotel_id, name, description, permissions, created_at, updated_at)
         VALUES ($1, 'Hotel Admin', 'Full administrative access', '{"View Requests": true, "Complete Requests": true, "Edit Requests": true, "Delete Requests": true, "Export Reports": true, "Manage Staff": true, "Manage Departments": true, "View Analytics": true, "Manage Settings": true}'::jsonb, NOW(), NOW())
         RETURNING id`,
        [hotel.id]
      );
      roleId = newRole.rows[0].id;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationUrl = buildVerificationUrl(req, verificationToken);
    const userResult = await client.query(
      `INSERT INTO hotel_admin_users (
         hotel_id, role_id, full_name, employee_id, email, password_hash, account_status, employment_status, verification_token, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_verification', 'active', $7, NOW(), NOW())
       RETURNING id, hotel_id, full_name, email`,
      [hotel.id, roleId, trimmedFullName, `ADM-${Date.now()}`, trimmedEmail, hashedPassword, verificationToken]
    );
    const createdUser = userResult.rows[0];

    await client.query('COMMIT');
    await writeHotelAudit(hotel.id, createdUser.id, 'registered_hotel', 'hotel', hotel.id, req);

    const emailResult = await sendVerificationEmail(trimmedEmail, verificationUrl, trimmedHotelName);
    console.log('Verification link for new signup:', verificationUrl);

    res.status(201).json({
      ok: true,
      requiresVerification: true,
      message: emailResult.skipped
        ? 'Account created. Please verify your email before signing in. The verification link was prepared locally because SMTP is not configured yet.'
        : 'Account created. Please verify your email before signing in.',
      verificationUrl,
      user: {
        id: createdUser.id,
        hotelId: hotel.id,
        fullName: createdUser.full_name,
        email: createdUser.email,
        hotelName: hotel.name
      },
      role: 'hotel_admin'
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Hotel registration failed:', err);
    res.status(500).json({ error: 'Hotel registration failed. Please try again.' });
  } finally {
    client.release();
  }
});

app.get('/api/auth/verify-email', async (req, res) => {
  if (!requireDatabase(res)) return;
  await ensureVerificationColumns().catch(() => {});
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).send('<h2>Invalid verification link.</h2><p>The verification token is missing.</p>');
  }

  try {
    const result = await pool.query(
      `SELECT id, email, account_status FROM hotel_admin_users WHERE verification_token = $1 LIMIT 1`,
      [token]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).send('<h2>Verification failed.</h2><p>This link is invalid or has already been used.</p>');
    }

    await pool.query(
      `UPDATE hotel_admin_users
       SET account_status = 'active', email_verified_at = NOW(), verification_token = NULL
       WHERE id = $1`,
      [user.id]
    );

    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Email Verified</title><style>body{font-family:Arial,sans-serif;padding:40px;line-height:1.5}h2{color:#2f7d32}</style></head><body><h2>Email verified successfully.</h2><p>Your hotel admin account is now active. You can sign in.</p><p><a href="/">Go to sign in</a></p></body></html>`);
  } catch (err) {
    console.error('Email verification failed:', err);
    res.status(500).send('<h2>Verification failed.</h2><p>Please try again later.</p>');
  }
});

// Director login
app.post('/api/auth/director', async (req, res) => {
  const hotelId = parseHotelIdFromRequest(req);
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const filters = { username: `eq.${username}` };
    if (hotelId) filters.hotel_id = `eq.${hotelId}`;
    const directors = await supabaseSelect('director', filters);
    const row = directors[0];

    if (!row) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!row.password_hash) {
      return res.status(501).json({ error: 'Director authentication is not configured. Use a hashed password in password_hash.' });
    }

    const isValidPassword = await bcrypt.compare(password, row.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ type: 'director', username: row.username }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, username: row.username });
  } catch (err) {
    console.error('Error fetching director:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

function requireDatabase(res) {
  if (!pool) {
    res.status(503).json({ error: 'Database is not configured' });
    return false;
  }
  return true;
}

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim();
}

async function writeHotelAudit(hotelId, actorId, action, targetType, targetId, req, metadata = {}) {
  if (!pool || !hotelId) return;
  try {
    await pool.query(
      `INSERT INTO hotel_admin_audit_logs
       (hotel_id, actor_user_id, action, target_type, target_id, ip_address, device, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [
        hotelId,
        actorId || null,
        action,
        targetType || null,
        targetId ? String(targetId) : null,
        getClientIp(req),
        req.headers['user-agent'] || 'Unknown device',
        metadata
      ]
    );
  } catch (err) {
    console.error('Hotel audit write failed:', err.message);
  }
}

async function requireHotelAdmin(req, res, next) {
  if (!requireDatabase(res)) return;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'hotel_admin') return res.status(403).json({ error: 'Hotel admin access required' });

    const result = await pool.query(
      `SELECT u.id, u.hotel_id, u.full_name, u.email, u.role_id, u.account_status, h.name AS hotel_name
       FROM hotel_admin_users u
       JOIN hotels h ON h.id = u.hotel_id
       WHERE u.id = $1 AND u.hotel_id = $2 AND u.deleted_at IS NULL`,
      [payload.userId, payload.hotelId]
    );
    const user = result.rows[0];
    if (!user || user.account_status !== 'active') return res.status(401).json({ error: 'Account is not active' });

    req.hotelAdmin = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function mapUserRow(row) {
  return {
    id: row.id,
    profilePhotoUrl: row.profile_photo_url,
    fullName: row.full_name,
    employeeId: row.employee_id,
    departmentId: row.department_id,
    department: row.department_name,
    roleId: row.role_id,
    role: row.role_name,
    email: row.email,
    phone: row.phone,
    shiftId: row.shift_id,
    shift: row.shift_name,
    employmentStatus: row.employment_status,
    accountStatus: row.account_status,
    lastLogin: row.last_login_at,
    createdDate: row.created_at,
    isOnline: Boolean(row.is_online),
    forcePasswordReset: Boolean(row.force_password_reset)
  };
}

function mapRoleRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: row.permissions || {},
    users: Number(row.users || 0),
    createdAt: row.created_at
  };
}

function mapDepartmentRow(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    managerId: row.manager_id,
    manager: row.manager_name,
    staff: Number(row.staff || 0),
    pendingRequests: Number(row.pending_requests || 0),
    completedToday: Number(row.completed_today || 0),
    averageCompletionMinutes: Number(row.average_completion_minutes || 0),
    createdAt: row.created_at
  };
}

app.post('/api/auth/hotel-admin', async (req, res) => {
  if (!requireDatabase(res)) return;
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.hotel_id, u.full_name, u.email, u.password_hash, u.account_status, u.failed_login_attempts, h.name AS hotel_name
       FROM hotel_admin_users u
       JOIN hotels h ON h.id = u.hotel_id
       WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL
       LIMIT 1`,
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.account_status === 'pending_verification') {
      return res.status(403).json({ error: 'Please verify your email before signing in.' });
    }
    if (user.account_status === 'locked' || user.account_status === 'suspended') {
      await writeHotelAudit(user.hotel_id, user.id, 'blocked_login', 'user', user.id, req);
      return res.status(423).json({ error: 'Account is not active' });
    }

    const valid = await bcrypt.compare(password, user.password_hash || '');
    if (!valid) {
      const failed = Number(user.failed_login_attempts || 0) + 1;
      const nextStatus = failed >= 5 ? 'locked' : user.account_status;
      await pool.query(
        `UPDATE hotel_admin_users
         SET failed_login_attempts = $1, account_status = $2, locked_at = CASE WHEN $2 = 'locked' THEN NOW() ELSE locked_at END
         WHERE id = $3`,
        [failed, nextStatus, user.id]
      );
      await writeHotelAudit(user.hotel_id, user.id, 'failed_login', 'user', user.id, req, { failedAttempts: failed });
      return res.status(401).json({ error: failed >= 5 ? 'Account locked after failed attempts' : 'Invalid credentials' });
    }

    await pool.query(
      `UPDATE hotel_admin_users
       SET failed_login_attempts = 0, last_login_at = NOW(), last_seen_at = NOW(), is_online = TRUE
       WHERE id = $1`,
      [user.id]
    );
    await writeHotelAudit(user.hotel_id, user.id, 'login', 'user', user.id, req);

    const token = jwt.sign(
      { type: 'hotel_admin', userId: user.id, hotelId: user.hotel_id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({
      token,
      user: { id: user.id, hotelId: user.hotel_id, fullName: user.full_name, email: user.email, hotelName: user.hotel_name }
    });
  } catch (err) {
    console.error('Hotel admin login failed:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  if (pool) {
    try {
      const adminResult = await pool.query(
        `SELECT u.id, u.hotel_id, u.full_name, u.email, u.password_hash, u.account_status, u.failed_login_attempts, h.name AS hotel_name
         FROM hotel_admin_users u
         JOIN hotels h ON h.id = u.hotel_id
         WHERE (LOWER(u.email) = LOWER($1) OR LOWER(COALESCE(u.employee_id,'')) = LOWER($1))
           AND u.deleted_at IS NULL
         LIMIT 1`,
        [username]
      );
      const admin = adminResult.rows[0];
      if (admin) {
        if (admin.account_status === 'pending_verification') {
          return res.status(403).json({ error: 'Please verify your email before signing in.' });
        }
        if (admin.account_status === 'locked' || admin.account_status === 'suspended') {
          await writeHotelAudit(admin.hotel_id, admin.id, 'blocked_login', 'user', admin.id, req);
          return res.status(423).json({ error: 'Account is not active' });
        }

        const validAdminPassword = await bcrypt.compare(password, admin.password_hash || '');
        if (!validAdminPassword) {
          const failed = Number(admin.failed_login_attempts || 0) + 1;
          const nextStatus = failed >= 5 ? 'locked' : admin.account_status;
          await pool.query(
            `UPDATE hotel_admin_users
             SET failed_login_attempts = $1, account_status = $2, locked_at = CASE WHEN $2 = 'locked' THEN NOW() ELSE locked_at END
             WHERE id = $3`,
            [failed, nextStatus, admin.id]
          );
          await writeHotelAudit(admin.hotel_id, admin.id, 'failed_login', 'user', admin.id, req, { failedAttempts: failed });
          return res.status(401).json({ error: failed >= 5 ? 'Account locked after failed attempts' : 'Invalid credentials' });
        }

        await pool.query(
          `UPDATE hotel_admin_users
           SET failed_login_attempts = 0, last_login_at = NOW(), last_seen_at = NOW(), is_online = TRUE
           WHERE id = $1`,
          [admin.id]
        );
        await writeHotelAudit(admin.hotel_id, admin.id, 'login', 'user', admin.id, req);

        const token = jwt.sign(
          { type: 'hotel_admin', userId: admin.id, hotelId: admin.hotel_id },
          JWT_SECRET,
          { expiresIn: '8h' }
        );
        return res.json({
          role: 'hotel_admin',
          redirectUrl: 'hotel_admin.html',
          token,
          user: {
            id: admin.id,
            hotelId: admin.hotel_id,
            fullName: admin.full_name,
            email: admin.email,
            hotelName: admin.hotel_name
          }
        });
      }
    } catch (err) {
      console.error('Unified hotel admin login failed:', err);
      return res.status(500).json({ error: 'Authentication failed' });
    }
  }

  try {
    const hotelId = parseHotelIdFromRequest(req);
    const filters = { username: `eq.${username}` };
    if (hotelId) filters.hotel_id = `eq.${hotelId}`;
    const directors = await supabaseSelect('director', filters);
    const row = directors[0];
    if (row && row.password_hash) {
      const isValid = await bcrypt.compare(password, row.password_hash);
      if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign({ type: 'director', username: row.username, hotelId: row.hotel_id || hotelId }, JWT_SECRET, { expiresIn: '8h' });
      return res.json({
        role: 'director',
        redirectUrl: 'director_dashboard.html',
        token,
        user: { username: row.username, fullName: row.full_name || row.username, hotelId: row.hotel_id || hotelId }
      });
    }
  } catch (err) {
    console.warn('Unified director lookup failed:', err.message || err);
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/auth/hotel-admin/logout', requireHotelAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE hotel_admin_users SET is_online = FALSE, last_seen_at = NOW() WHERE id = $1', [req.hotelAdmin.id]);
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'logout', 'user', req.hotelAdmin.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.post('/api/auth/hotel-admin/password-reset', async (req, res) => {
  if (!requireDatabase(res)) return;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query('SELECT id, hotel_id FROM hotel_admin_users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL', [email]);
    const user = result.rows[0];
    if (user) {
      await pool.query(
        `INSERT INTO hotel_admin_password_resets (hotel_id, user_id, email, status, created_at)
         VALUES ($1,$2,$3,'pending',NOW())`,
        [user.hotel_id, user.id, email]
      );
      await writeHotelAudit(user.hotel_id, user.id, 'password_reset_requested', 'user', user.id, req);
    }
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('Hotel admin password reset failed:', err);
    res.status(500).json({ error: 'Password reset request failed' });
  }
});

app.get('/api/hotel-admin/me', requireHotelAdmin, async (req, res) => {
  res.json({ user: req.hotelAdmin });
});

app.get('/api/hotel-admin/dashboard', requireHotelAdmin, async (req, res) => {
  const hotelId = req.hotelAdmin.hotel_id;
  try {
    const [staff, depts, requests, resets, shifts, recentLogins] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_online = TRUE AND account_status = 'active')::int AS online,
          COUNT(*) FILTER (WHERE COALESCE(is_online,FALSE) = FALSE AND account_status = 'active')::int AS offline,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::int AS new_this_month,
          COUNT(*) FILTER (WHERE account_status = 'locked')::int AS locked
         FROM hotel_admin_users WHERE hotel_id = $1 AND deleted_at IS NULL`,
        [hotelId]
      ),
      pool.query(`SELECT COUNT(*)::int AS active FROM hotel_admin_departments WHERE hotel_id = $1 AND status = 'active'`, [hotelId]),
      pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE status IN ('pending','in-progress'))::int AS pending,
          COUNT(*) FILTER (WHERE status = 'completed' AND updated_at::date = CURRENT_DATE)::int AS completed_today,
          COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (WHERE status = 'completed')),0)::int AS avg_response
         FROM requests
         WHERE hotel_id = $1`,
        [hotelId]
      ),
      pool.query(`SELECT COUNT(*)::int AS pending FROM hotel_admin_password_resets WHERE hotel_id = $1 AND status = 'pending'`, [hotelId]),
      pool.query(`SELECT COUNT(*)::int AS active FROM hotel_admin_shifts WHERE hotel_id = $1 AND status = 'active'`, [hotelId]),
      pool.query(
        `SELECT full_name, email, last_login_at FROM hotel_admin_users
         WHERE hotel_id = $1 AND last_login_at IS NOT NULL AND deleted_at IS NULL
         ORDER BY last_login_at DESC LIMIT 6`,
        [hotelId]
      )
    ]);
    const s = staff.rows[0] || {};
    const r = requests.rows[0] || {};
    res.json({
      greetingName: req.hotelAdmin.full_name,
      hotelName: req.hotelAdmin.hotel_name,
      metrics: {
        totalStaff: s.total || 0,
        onlineStaff: s.online || 0,
        offlineStaff: s.offline || 0,
        activeDepartments: depts.rows[0]?.active || 0,
        pendingRequests: Number(r.pending || 0) + Number(resets.rows[0]?.pending || 0),
        requestsCompletedToday: r.completed_today || 0,
        averageResponseTime: `${r.avg_response || 0} min`,
        activeShifts: shifts.rows[0]?.active || 0,
        newUsersThisMonth: s.new_this_month || 0,
        lockedAccounts: s.locked || 0,
        recentLogins: recentLogins.rows.length
      },
      recentLogins: recentLogins.rows
    });
  } catch (err) {
    console.error('Hotel admin dashboard failed:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

app.get('/api/hotel-admin/activity', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.ip_address, a.device, a.created_at,
              u.full_name AS user_name, u.email AS user_email
       FROM hotel_admin_audit_logs a
       LEFT JOIN hotel_admin_users u ON u.id = a.actor_user_id
       WHERE a.hotel_id = $1
       ORDER BY a.created_at DESC
       LIMIT 80`,
      [req.hotelAdmin.hotel_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

app.get('/api/hotel-admin/users', requireHotelAdmin, async (req, res) => {
  const hotelId = req.hotelAdmin.hotel_id;
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '12', 10), 1), 50);
  const offset = (page - 1) * limit;
  const search = `%${String(req.query.search || '').trim()}%`;
  const status = req.query.status ? String(req.query.status) : null;
  const department = req.query.department ? Number(req.query.department) : null;
  try {
    const params = [hotelId, search, status, department, limit, offset];
    const where = `u.hotel_id = $1 AND u.deleted_at IS NULL
      AND ($2 = '%%' OR u.full_name ILIKE $2 OR u.email ILIKE $2 OR u.employee_id ILIKE $2)
      AND ($3::text IS NULL OR u.account_status = $3)
      AND ($4::int IS NULL OR u.department_id = $4)`;
    const data = await pool.query(
      `SELECT u.*, d.name AS department_name, r.name AS role_name, s.name AS shift_name,
              COUNT(*) OVER()::int AS total_count
       FROM hotel_admin_users u
       LEFT JOIN hotel_admin_departments d ON d.id = u.department_id
       LEFT JOIN hotel_admin_roles r ON r.id = u.role_id
       LEFT JOIN hotel_admin_shifts s ON s.id = u.shift_id
       WHERE ${where}
       ORDER BY u.created_at DESC
       LIMIT $5 OFFSET $6`,
      params
    );
    res.json({
      users: data.rows.map(mapUserRow),
      total: data.rows[0]?.total_count || 0,
      page,
      limit
    });
  } catch (err) {
    console.error('Hotel admin users failed:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

app.post('/api/hotel-admin/users', requireHotelAdmin, async (req, res) => {
  const hotelId = req.hotelAdmin.hotel_id;
  const { fullName, employeeId, departmentId, roleId, email, phone, shiftId, employmentStatus, accountStatus, password, profilePhotoUrl } = req.body;
  if (!fullName || !email || !password) return res.status(400).json({ error: 'Full name, email and password are required' });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO hotel_admin_users
       (hotel_id, full_name, employee_id, department_id, role_id, email, phone, shift_id, employment_status, account_status, password_hash, profile_photo_url, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,LOWER($6),$7,$8,$9,$10,$11,$12,NOW(),NOW())
       RETURNING *`,
      [hotelId, fullName, employeeId || null, departmentId || null, roleId || null, email, phone || null, shiftId || null, employmentStatus || 'active', accountStatus || 'active', passwordHash, profilePhotoUrl || null]
    );
    await writeHotelAudit(hotelId, req.hotelAdmin.id, 'user_created', 'user', result.rows[0].id, req, { email });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    const message = err.code === '23505' ? 'A user with that email or employee ID already exists' : 'Failed to create user';
    res.status(err.code === '23505' ? 409 : 500).json({ error: message });
  }
});

app.get('/api/hotel-admin/users/:id', requireHotelAdmin, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT u.*, d.name AS department_name, r.name AS role_name, s.name AS shift_name
       FROM hotel_admin_users u
       LEFT JOIN hotel_admin_departments d ON d.id = u.department_id
       LEFT JOIN hotel_admin_roles r ON r.id = u.role_id
       LEFT JOIN hotel_admin_shifts s ON s.id = u.shift_id
       WHERE u.id = $1 AND u.hotel_id = $2 AND u.deleted_at IS NULL`,
      [req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const activity = await pool.query(
      `SELECT action, target_type, ip_address, device, created_at
       FROM hotel_admin_audit_logs
       WHERE hotel_id = $1 AND (actor_user_id = $2 OR target_id = $3)
       ORDER BY created_at DESC LIMIT 50`,
      [req.hotelAdmin.hotel_id, req.params.id, String(req.params.id)]
    );
    res.json({ user: mapUserRow(userResult.rows[0]), activity: activity.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user profile' });
  }
});

app.put('/api/hotel-admin/users/:id', requireHotelAdmin, async (req, res) => {
  const { fullName, employeeId, departmentId, roleId, email, phone, shiftId, employmentStatus, profilePhotoUrl } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotel_admin_users
       SET full_name = COALESCE($1, full_name),
           employee_id = $2,
           department_id = $3,
           role_id = $4,
           email = COALESCE(LOWER($5), email),
           phone = $6,
           shift_id = $7,
           employment_status = COALESCE($8, employment_status),
           profile_photo_url = $9,
           updated_at = NOW()
       WHERE id = $10 AND hotel_id = $11 AND deleted_at IS NULL
       RETURNING *`,
      [fullName || null, employeeId || null, departmentId || null, roleId || null, email || null, phone || null, shiftId || null, employmentStatus || null, profilePhotoUrl || null, req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'profile_updated', 'user', req.params.id, req);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.post('/api/hotel-admin/users/:id/action', requireHotelAdmin, async (req, res) => {
  const actions = {
    suspend: { account_status: 'suspended' },
    activate: { account_status: 'active', failed_login_attempts: 0, locked_at: null },
    lock: { account_status: 'locked', locked_at: new Date() },
    unlock: { account_status: 'active', failed_login_attempts: 0, locked_at: null },
    force_password_reset: { force_password_reset: true }
  };
  const patch = actions[req.body.action];
  if (!patch) return res.status(400).json({ error: 'Invalid user action' });
  try {
    const keys = Object.keys(patch);
    const setSql = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const values = keys.map(key => patch[key]);
    const result = await pool.query(
      `UPDATE hotel_admin_users SET ${setSql}, updated_at = NOW()
       WHERE id = $${values.length + 1} AND hotel_id = $${values.length + 2} AND deleted_at IS NULL
       RETURNING id, account_status, force_password_reset`,
      [...values, req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, req.body.action, 'user', req.params.id, req);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update account' });
  }
});

app.delete('/api/hotel-admin/users/:id', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE hotel_admin_users SET deleted_at = NOW(), account_status = 'deleted'
       WHERE id = $1 AND hotel_id = $2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'user_deleted', 'user', req.params.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/hotel-admin/roles', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, COUNT(u.id)::int AS users
       FROM hotel_admin_roles r
       LEFT JOIN hotel_admin_users u ON u.role_id = r.id AND u.deleted_at IS NULL
       WHERE r.hotel_id = $1
       GROUP BY r.id
       ORDER BY r.name`,
      [req.hotelAdmin.hotel_id]
    );
    res.json(result.rows.map(mapRoleRow));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

app.post('/api/hotel-admin/roles', requireHotelAdmin, async (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name) return res.status(400).json({ error: 'Role name required' });
  try {
    const result = await pool.query(
      `INSERT INTO hotel_admin_roles (hotel_id, name, description, permissions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW()) RETURNING *`,
      [req.hotelAdmin.hotel_id, name, description || null, permissions || {}]
    );
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'role_created', 'role', result.rows[0].id, req);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create role' });
  }
});

app.put('/api/hotel-admin/roles/:id', requireHotelAdmin, async (req, res) => {
  const { name, description, permissions } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotel_admin_roles SET name = COALESCE($1,name), description = $2, permissions = COALESCE($3,permissions), updated_at = NOW()
       WHERE id = $4 AND hotel_id = $5 RETURNING *`,
      [name || null, description || null, permissions || null, req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Role not found' });
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'role_updated', 'role', req.params.id, req);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

app.delete('/api/hotel-admin/roles/:id', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM hotel_admin_roles WHERE id = $1 AND hotel_id = $2 RETURNING id', [req.params.id, req.hotelAdmin.hotel_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Role not found' });
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'role_deleted', 'role', req.params.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete role' });
  }
});

app.get('/api/hotel-admin/departments', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, m.full_name AS manager_name, COUNT(u.id)::int AS staff,
              0::int AS pending_requests, 0::int AS completed_today, 0::int AS average_completion_minutes
       FROM hotel_admin_departments d
       LEFT JOIN hotel_admin_users m ON m.id = d.manager_id
       LEFT JOIN hotel_admin_users u ON u.department_id = d.id AND u.deleted_at IS NULL
       WHERE d.hotel_id = $1
       GROUP BY d.id, m.full_name
       ORDER BY d.name`,
      [req.hotelAdmin.hotel_id]
    );
    res.json(result.rows.map(mapDepartmentRow));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load departments' });
  }
});

app.post('/api/hotel-admin/departments', requireHotelAdmin, async (req, res) => {
  const { name, managerId } = req.body;
  if (!name) return res.status(400).json({ error: 'Department name required' });
  try {
    const result = await pool.query(
      `INSERT INTO hotel_admin_departments (hotel_id, name, manager_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,'active',NOW(),NOW()) RETURNING *`,
      [req.hotelAdmin.hotel_id, name, managerId || null]
    );
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'department_created', 'department', result.rows[0].id, req);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create department' });
  }
});

app.put('/api/hotel-admin/departments/:id', requireHotelAdmin, async (req, res) => {
  const { name, managerId, status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotel_admin_departments SET name = COALESCE($1,name), manager_id = $2, status = COALESCE($3,status), updated_at = NOW()
       WHERE id = $4 AND hotel_id = $5 RETURNING *`,
      [name || null, managerId || null, status || null, req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Department not found' });
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'department_updated', 'department', req.params.id, req);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update department' });
  }
});

app.post('/api/hotel-admin/departments/:id/staff', requireHotelAdmin, async (req, res) => {
  const staffIds = Array.isArray(req.body.staffIds) ? req.body.staffIds : [];
  try {
    await pool.query(
      `UPDATE hotel_admin_users SET department_id = $1, updated_at = NOW()
       WHERE hotel_id = $2 AND id = ANY($3::int[]) AND deleted_at IS NULL`,
      [req.params.id, req.hotelAdmin.hotel_id, staffIds]
    );
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'department_staff_assigned', 'department', req.params.id, req, { staffIds });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign staff' });
  }
});

app.get('/api/hotel-admin/performance', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.full_name, d.name AS department_name, u.is_online,
              COUNT(a.id) FILTER (WHERE a.action IN ('request_completed','complete_requests'))::int AS completed_requests,
              0::int AS average_completion_time,
              COUNT(a.id) FILTER (WHERE a.action ILIKE '%escalat%')::int AS escalated_requests,
              NULL::numeric AS customer_satisfaction_score,
              0::int AS late_requests,
              CASE WHEN u.is_online THEN 'Present' ELSE 'Offline' END AS attendance_status,
              CASE
                WHEN COUNT(a.id) FILTER (WHERE a.action IN ('request_completed','complete_requests')) >= 20 THEN 'Excellent'
                WHEN COUNT(a.id) FILTER (WHERE a.action IN ('request_completed','complete_requests')) >= 10 THEN 'Strong'
                WHEN u.is_online THEN 'Active'
                ELSE 'Unrated'
              END AS performance_rating
       FROM hotel_admin_users u
       LEFT JOIN hotel_admin_departments d ON d.id = u.department_id
       LEFT JOIN hotel_admin_audit_logs a ON a.actor_user_id = u.id AND a.created_at >= NOW() - INTERVAL '30 days'
       WHERE u.hotel_id = $1 AND u.deleted_at IS NULL
       GROUP BY u.id, d.name
       ORDER BY completed_requests DESC, u.full_name`,
      [req.hotelAdmin.hotel_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

app.get('/api/hotel-admin/shifts', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, COUNT(u.id)::int AS staff_count
       FROM hotel_admin_shifts s
       LEFT JOIN hotel_admin_users u ON u.shift_id = s.id AND u.deleted_at IS NULL
       WHERE s.hotel_id = $1
       GROUP BY s.id
       ORDER BY s.start_time NULLS LAST, s.name`,
      [req.hotelAdmin.hotel_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load shifts' });
  }
});

app.post('/api/hotel-admin/shifts', requireHotelAdmin, async (req, res) => {
  const { name, startTime, endTime, status } = req.body;
  if (!name) return res.status(400).json({ error: 'Shift name required' });
  try {
    const result = await pool.query(
      `INSERT INTO hotel_admin_shifts (hotel_id, name, start_time, end_time, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING *`,
      [req.hotelAdmin.hotel_id, name, startTime || null, endTime || null, status || 'active']
    );
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'shift_created', 'shift', result.rows[0].id, req);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

app.put('/api/hotel-admin/shifts/:id', requireHotelAdmin, async (req, res) => {
  const { name, startTime, endTime, status, staffIds } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotel_admin_shifts SET name = COALESCE($1,name), start_time = $2, end_time = $3, status = COALESCE($4,status), updated_at = NOW()
       WHERE id = $5 AND hotel_id = $6 RETURNING *`,
      [name || null, startTime || null, endTime || null, status || null, req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Shift not found' });
    if (Array.isArray(staffIds)) {
      await pool.query(
        `UPDATE hotel_admin_users SET shift_id = $1, updated_at = NOW()
         WHERE hotel_id = $2 AND id = ANY($3::int[]) AND deleted_at IS NULL`,
        [req.params.id, req.hotelAdmin.hotel_id, staffIds]
      );
    }
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'shift_updated', 'shift', req.params.id, req);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

app.get('/api/hotel-admin/audit-logs', requireHotelAdmin, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
  try {
    const result = await pool.query(
      `SELECT a.*, u.full_name AS user_name, COUNT(*) OVER()::int AS total_count
       FROM hotel_admin_audit_logs a
       LEFT JOIN hotel_admin_users u ON u.id = a.actor_user_id
       WHERE a.hotel_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.hotelAdmin.hotel_id, limit, (page - 1) * limit]
    );
    res.json({ logs: result.rows, total: result.rows[0]?.total_count || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

app.get('/api/hotel-admin/notifications', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM hotel_admin_notifications WHERE hotel_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.hotelAdmin.hotel_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

app.post('/api/hotel-admin/notifications', requireHotelAdmin, async (req, res) => {
  const { title, message, type, departmentId } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  try {
    const result = await pool.query(
      `INSERT INTO hotel_admin_notifications
       (hotel_id, sender_user_id, department_id, type, title, message, delivery_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',NOW()) RETURNING *`,
      [req.hotelAdmin.hotel_id, req.hotelAdmin.id, departmentId || null, type || 'announcement', title, message]
    );
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'notification_sent', 'notification', result.rows[0].id, req);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.get('/api/hotel-admin/reports', requireHotelAdmin, async (req, res) => {
  try {
    const [users, depts, perf] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM hotel_admin_users WHERE hotel_id = $1 AND deleted_at IS NULL`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT COUNT(*)::int AS total FROM hotel_admin_departments WHERE hotel_id = $1`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT COUNT(*)::int AS total FROM hotel_admin_audit_logs WHERE hotel_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`, [req.hotelAdmin.hotel_id])
    ]);
    res.json({
      staffPerformance: { records: users.rows[0]?.total || 0 },
      departmentPerformance: { records: depts.rows[0]?.total || 0 },
      userActivity: { records: perf.rows[0]?.total || 0 },
      requestSummary: { records: 0 },
      completionRates: { records: 0 }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

app.get('/api/hotel-admin/reports/export', requireHotelAdmin, async (req, res) => {
  const type = String(req.query.type || 'user_activity');
  const format = String(req.query.format || 'csv').toLowerCase();
  try {
    const result = await pool.query(
      `SELECT a.created_at, COALESCE(u.full_name,'System') AS user_name, a.action, a.ip_address, a.device
       FROM hotel_admin_audit_logs a
       LEFT JOIN hotel_admin_users u ON u.id = a.actor_user_id
       WHERE a.hotel_id = $1
       ORDER BY a.created_at DESC LIMIT 1000`,
      [req.hotelAdmin.hotel_id]
    );
    const rows = result.rows;
    if (format === 'json') return res.json({ type, rows });
    const headers = ['Timestamp', 'User', 'Action', 'IP Address', 'Device'];
    const csv = [headers.join(','), ...rows.map(row => headers.map(header => {
      const key = header === 'Timestamp' ? 'created_at' : header === 'User' ? 'user_name' : header === 'Action' ? 'action' : header === 'IP Address' ? 'ip_address' : 'device';
      return `"${String(row[key] || '').replace(/"/g, '""')}"`;
    }).join(','))].join('\n');
    res.setHeader('Content-Type', format === 'excel' ? 'application/vnd.ms-excel' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}.${format === 'excel' ? 'xls' : 'csv'}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export report' });
  }
});

app.get('/api/hotel-admin/settings', requireHotelAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hotels WHERE id = $1', [req.hotelAdmin.hotel_id]);
    const row = result.rows[0];
    res.json({
      hotelName: row.name,
      hotelLogoUrl: row.logo_url,
      hotelAddress: row.address,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      timezone: row.timezone,
      language: row.language,
      dateFormat: row.date_format,
      brandColors: row.brand_colors || {},
      emailSettings: row.email_settings || {},
      notificationPreferences: row.notification_preferences || {}
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.put('/api/hotel-admin/settings', requireHotelAdmin, async (req, res) => {
  const { hotelName, hotelLogoUrl, hotelAddress, contactEmail, contactPhone, timezone, language, dateFormat, brandColors, emailSettings, notificationPreferences } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotels SET
        name = COALESCE($1,name),
        logo_url = $2,
        address = $3,
        contact_email = $4,
        contact_phone = $5,
        timezone = COALESCE($6,timezone),
        language = COALESCE($7,language),
        date_format = COALESCE($8,date_format),
        brand_colors = COALESCE($9,brand_colors),
        email_settings = COALESCE($10,email_settings),
        notification_preferences = COALESCE($11,notification_preferences),
        updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [hotelName || null, hotelLogoUrl || null, hotelAddress || null, contactEmail || null, contactPhone || null, timezone || null, language || null, dateFormat || null, brandColors || null, emailSettings || null, notificationPreferences || null, req.hotelAdmin.hotel_id]
    );
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'hotel_settings_updated', 'hotel', req.hotelAdmin.hotel_id, req);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.get('/api/hotel-admin/security', requireHotelAdmin, async (req, res) => {
  try {
    const [failed, locked, passwordChanges, suspicious, devices, ips] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM hotel_admin_audit_logs WHERE hotel_id = $1 AND action = 'failed_login' AND created_at >= NOW() - INTERVAL '24 hours'`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT id, full_name, email, locked_at FROM hotel_admin_users WHERE hotel_id = $1 AND account_status = 'locked' AND deleted_at IS NULL`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT a.created_at, u.full_name FROM hotel_admin_audit_logs a LEFT JOIN hotel_admin_users u ON u.id = a.actor_user_id WHERE a.hotel_id = $1 AND a.action ILIKE '%password%' ORDER BY a.created_at DESC LIMIT 10`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT * FROM hotel_admin_audit_logs WHERE hotel_id = $1 AND action IN ('failed_login','blocked_login') ORDER BY created_at DESC LIMIT 20`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT device, MAX(created_at) AS last_seen, COUNT(*)::int AS events FROM hotel_admin_audit_logs WHERE hotel_id = $1 AND device IS NOT NULL GROUP BY device ORDER BY last_seen DESC LIMIT 10`, [req.hotelAdmin.hotel_id]),
      pool.query(`SELECT ip_address, MAX(created_at) AS last_seen, COUNT(*)::int AS events FROM hotel_admin_audit_logs WHERE hotel_id = $1 AND ip_address IS NOT NULL GROUP BY ip_address ORDER BY last_seen DESC LIMIT 10`, [req.hotelAdmin.hotel_id])
    ]);
    res.json({
      failedLoginAttempts: failed.rows[0]?.count || 0,
      lockedAccounts: locked.rows,
      recentPasswordChanges: passwordChanges.rows,
      suspiciousActivity: suspicious.rows,
      recentDevices: devices.rows,
      recentIpAddresses: ips.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load security center' });
  }
});

app.get('/api/hotel-admin/search', requireHotelAdmin, async (req, res) => {
  const term = `%${String(req.query.q || '').trim()}%`;
  if (term === '%%') return res.json({ users: [], departments: [], roles: [], logs: [], reports: [] });
  try {
    const [users, departments, roles, logs] = await Promise.all([
      pool.query(`SELECT id, full_name AS label, email AS detail FROM hotel_admin_users WHERE hotel_id = $1 AND deleted_at IS NULL AND (full_name ILIKE $2 OR email ILIKE $2 OR employee_id ILIKE $2) LIMIT 8`, [req.hotelAdmin.hotel_id, term]),
      pool.query(`SELECT id, name AS label, status AS detail FROM hotel_admin_departments WHERE hotel_id = $1 AND name ILIKE $2 LIMIT 8`, [req.hotelAdmin.hotel_id, term]),
      pool.query(`SELECT id, name AS label, description AS detail FROM hotel_admin_roles WHERE hotel_id = $1 AND name ILIKE $2 LIMIT 8`, [req.hotelAdmin.hotel_id, term]),
      pool.query(`SELECT id, action AS label, created_at::text AS detail FROM hotel_admin_audit_logs WHERE hotel_id = $1 AND action ILIKE $2 LIMIT 8`, [req.hotelAdmin.hotel_id, term])
    ]);
    const reports = ['staff performance', 'department performance', 'user activity', 'request summary', 'completion rates']
      .filter(name => name.includes(term.replace(/%/g, '').toLowerCase()))
      .map((name, index) => ({ id: index + 1, label: name, detail: 'Report' }));
    res.json({ users: users.rows, departments: departments.rows, roles: roles.rows, logs: logs.rows, reports });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Note: uploads are stored directly to Supabase storage; do not serve a local uploads directory.

// Start server
server.listen(PORT, () => {
  console.log(`LUXE Hotel Services Backend running on port ${PORT}`);
  console.log(`Socket.io enabled for real-time updates`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  try {
    if (pool) {
      await pool.end();
      console.log('Database pool closed.');
    }
  } catch (err) {
    console.error('Error closing database pool:', err.message);
  }
  process.exit(0);
});

// Password reset requests: persist to DB when available, otherwise fallback to in-memory
let passwordResetRequests = [];

app.post('/api/password_resets', async (req, res) => {
  const hotelId = parseHotelIdFromRequest(req);
  const { dept } = req.body;
  if (!dept) return res.status(400).json({ error: 'Department required' });

  // Prefer Supabase REST API when configured
  if (SUPABASE_URL) {
    try {
      const payload = { dept, status: 'pending', created_at: new Date().toISOString() };
      if (hotelId) payload.hotel_id = hotelId;
      const inserted = await supabaseInsert('password_resets', payload);
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      const out = { id: row.id, dept: row.dept, time: row.created_at, hotel_id: row.hotel_id };
      if (out.hotel_id) io.to(`hotel_${out.hotel_id}`).emit('passwordReset', out);
      else io.emit('passwordReset', out);
      return res.status(201).json(out);
    } catch (err) {
      console.error('Supabase insert password_reset failed:', err);
      // fall through to pool or memory
    }
  }

  if (pool) {
    try {
      const query = hotelId
        ? 'INSERT INTO password_resets (hotel_id, dept, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, dept, status, created_at'
        : 'INSERT INTO password_resets (dept, status, created_at) VALUES ($1, $2, NOW()) RETURNING id, dept, status, created_at';
      const values = hotelId ? [hotelId, dept, 'pending'] : [dept, 'pending'];
      const result = await pool.query(query, values);
      const row = result.rows[0];
      const out = { id: row.id, dept: row.dept, time: row.created_at, hotel_id: hotelId || null };
      if (out.hotel_id) io.to(`hotel_${out.hotel_id}`).emit('passwordReset', out);
      else io.emit('passwordReset', out);
      return res.status(201).json(out);
    } catch (err) {
      console.error('DB insert password_reset failed:', err);
      // fall back to in-memory storage rather than failing completely
    }
  }

  // fallback in-memory
  const entry = { id: Date.now(), dept, time: new Date().toISOString(), status: 'pending' };
  if (hotelId) entry.hotel_id = hotelId;
  passwordResetRequests.unshift(entry);
  if (entry.hotel_id) io.to(`hotel_${entry.hotel_id}`).emit('passwordReset', entry);
  else io.emit('passwordReset', entry);
  res.status(201).json(entry);
});

app.get('/api/password_resets', async (req, res) => {
  const hotelId = parseHotelIdFromRequest(req);
  // Prefer Supabase REST API when configured
  if (SUPABASE_URL) {
    try {
      const filters = { order: 'created_at.desc' };
      if (hotelId) filters.hotel_id = `eq.${hotelId}`;
      const rows = await supabaseSelect('password_resets', filters);
      const out = (rows || []).map(r => ({ id: r.id, dept: r.dept, time: r.created_at, hotel_id: r.hotel_id }));
      return res.json(out);
    } catch (err) {
      console.error('Supabase fetch password_resets failed:', err);
      // fall through to pool or memory
    }
  }

  if (pool) {
    try {
      const query = hotelId
        ? 'SELECT id, dept, status, created_at FROM password_resets WHERE hotel_id = $1 ORDER BY created_at DESC'
        : 'SELECT id, dept, status, created_at FROM password_resets ORDER BY created_at DESC';
      const params = hotelId ? [hotelId] : [];
      const result = await pool.query(query, params);
      const rows = result.rows.map(r => ({ id: r.id, dept: r.dept, time: r.created_at, hotel_id: hotelId || null }));
      return res.json(rows);
    } catch (err) {
      console.error('DB fetch password_resets failed:', err);
      // fall back to in-memory storage instead of failing
    }
  }

  const filtered = hotelId ? passwordResetRequests.filter(r => r.hotel_id === hotelId) : passwordResetRequests;
  return res.json(filtered);
});

app.put('/api/password_resets/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  const hotelId = parseHotelIdFromRequest(req);
  // Prefer Supabase REST API when configured
  if (SUPABASE_URL) {
    try {
      // delete via Supabase REST API using service role key
      const filter = hotelId ? `id=eq.${id}&hotel_id=eq.${hotelId}` : `id=eq.${id}`;
      const deleted = await supabaseDelete('password_resets', filter);
      const removed = Array.isArray(deleted) ? deleted[0] : deleted;
      if (removed.hotel_id || hotelId) io.to(`hotel_${removed.hotel_id || hotelId}`).emit('passwordResetApproved', { id: removed.id, dept: removed.dept, hotel_id: removed.hotel_id || hotelId || null });
      else io.emit('passwordResetApproved', { id: removed.id, dept: removed.dept, hotel_id: removed.hotel_id || hotelId || null });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Supabase delete password_reset failed:', err);
      // fall through to pool or memory
    }
  }

  if (pool) {
    try {
      const query = hotelId
        ? 'DELETE FROM password_resets WHERE id = $1 AND hotel_id = $2 RETURNING id, dept'
        : 'DELETE FROM password_resets WHERE id = $1 RETURNING id, dept';
      const params = hotelId ? [id, hotelId] : [id];
      const result = await pool.query(query, params);
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      const removed = result.rows[0];
      if (hotelId) io.to(`hotel_${hotelId}`).emit('passwordResetApproved', { id: removed.id, dept: removed.dept, hotel_id: hotelId || null });
      else io.emit('passwordResetApproved', { id: removed.id, dept: removed.dept, hotel_id: hotelId || null });
      return res.json({ ok: true });
    } catch (err) {
      console.error('DB delete password_reset failed:', err);
      // fall back to in-memory storage instead of failing
    }
  }

  const idx = passwordResetRequests.findIndex(p => p.id === id && (!hotelId || p.hotel_id === hotelId));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const removed = passwordResetRequests.splice(idx, 1)[0];
  if (removed.hotel_id) io.to(`hotel_${removed.hotel_id}`).emit('passwordResetApproved', { id: removed.id, dept: removed.dept, hotel_id: removed.hotel_id });
  else io.emit('passwordResetApproved', { id: removed.id, dept: removed.dept });
  res.json({ ok: true });
});
