require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createServer } = require('http');
const { Server } = require('socket.io');

dns.setDefaultResultOrder('ipv4first');

async function createPgPool(connectionString, ipv4HostOverride) {
  const url = new URL(connectionString);
  const config = {
    user: url.username || undefined,
    password: url.password || undefined,
    database: url.pathname ? url.pathname.substring(1) : undefined,
    port: parseInt(url.port || '5432', 10),
    ssl: { rejectUnauthorized: false }
  };

  const hostname = url.hostname;
  let resolvedHost = hostname;

  if (ipv4HostOverride) {
    resolvedHost = ipv4HostOverride;
    console.log(`Using IPv4 override for database host: ${resolvedHost}`);
  } else {
    try {
      const addresses = await dns.promises.resolve4(hostname);
      if (addresses && addresses.length > 0) {
        resolvedHost = addresses[0];
        console.log(`Resolved database host to IPv4 address: ${resolvedHost}`);
      } else {
        console.warn(`No IPv4 A records found for ${hostname}; falling back to original hostname.`);
      }
    } catch (lookupErr) {
      if (lookupErr.code === 'ENODATA' || lookupErr.code === 'ENOTFOUND' || lookupErr.code === 'EAI_AGAIN') {
        console.warn(`No IPv4 A records found for ${hostname}; this host may be IPv6-only.`);
      } else {
        console.warn(`IPv4 DNS lookup failed for ${hostname}, using original host: ${lookupErr.code || lookupErr.message}`);
      }
    }
  }

  config.host = resolvedHost;
  return new Pool(config);
}


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
// Public URL of the frontend (Vercel). Supabase email links (verify / reset) send people back here.
const FRONTEND_URL = String(process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://hotel-q-rservices.vercel.app').replace(/\/$/, '');

// Supabase client config from env
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'audio';

const supabaseAnon = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;
const supabaseService = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

console.log('SUPABASE_URL loaded:', SUPABASE_URL ? 'YES' : 'NO');
console.log('SUPABASE_ANON_KEY loaded:', SUPABASE_ANON_KEY ? 'YES' : 'NO');
console.log('SUPABASE_SERVICE_ROLE_KEY loaded:', SUPABASE_SERVICE_ROLE_KEY ? 'YES' : 'NO');
console.log('SUPABASE_STORAGE_BUCKET:', SUPABASE_STORAGE_BUCKET);
console.log('SUPABASE_URL value:', process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY length:', process.env.SUPABASE_ANON_KEY ? process.env.SUPABASE_ANON_KEY.length : 0);

// Database (PostgreSQL / Supabase)
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_HOST_IPV4 = process.env.DATABASE_HOST_IPV4 || '';
let pool = null;

async function initDatabase() {
  if (!DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Skipping postgres pool initialization.');
    return;
  }

  console.log('DATABASE_URL loaded: YES');
  if (DATABASE_HOST_IPV4) {
    console.log('DATABASE_HOST_IPV4 loaded: YES');
  }

  // If no explicit IPv4 override is provided, check whether the DB hostname has IPv4 A records.
  try {
    const dbUrl = new URL(DATABASE_URL);
    const dbHost = dbUrl.hostname;
    let hasA = false;
    try {
      const addrs = await dns.promises.resolve4(dbHost);
      hasA = Array.isArray(addrs) && addrs.length > 0;
    } catch (e) {
      // resolve4 may throw when no A records exist
      hasA = false;
    }
    if (!hasA && !DATABASE_HOST_IPV4) {
      console.warn(`Database host ${dbHost} has no IPv4 A records and no DATABASE_HOST_IPV4 override provided; skipping Postgres pool creation.`);
      pool = null;
      return;
    }

    pool = await createPgPool(DATABASE_URL, DATABASE_HOST_IPV4);
    console.log('Postgres pool created successfully.');
  } catch (err) {
    console.error('Failed to create Postgres pool:', err);
    pool = null;
    return;
  }

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
    try {
      await pool.query(`
        ALTER TABLE hotel_admin_users
        ADD COLUMN IF NOT EXISTS verification_token TEXT,
        ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS auth_user_id UUID;
      ALTER TABLE hotel_admin_users ALTER COLUMN password_hash DROP NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS hotel_admin_users_auth_user_id_key ON hotel_admin_users (auth_user_id);
      `);
      console.log('Verified verification columns exist.');
    } catch (err) {
      console.error('Error ensuring verification columns:', err);
    }
  }

  await initDb();
  await ensureVerificationColumns();
}

initDatabase().catch(console.error);

// Ensure verification columns are available (callable from routes)
async function ensureVerificationColumns() {
  if (!pool) return;
  try {
    await pool.query(`
      ALTER TABLE hotel_admin_users
      ADD COLUMN IF NOT EXISTS verification_token TEXT,
      ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS auth_user_id UUID;
      ALTER TABLE hotel_admin_users ALTER COLUMN password_hash DROP NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS hotel_admin_users_auth_user_id_key ON hotel_admin_users (auth_user_id);
    `);
    console.log('Verified verification columns exist (global helper).');
  } catch (err) {
    console.error('Error ensuring verification columns (global):', err);
  }
}

// Middleware
const configuredCorsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'https://hotelqrservices-production.up.railway.app',
  'https://hotelqrservices.onrender.com',
  'https://hotel-q-rservices.vercel.app'
];
const allowedCorsOrigins = configuredCorsOrigins.length > 0 ? configuredCorsOrigins : [...defaultCorsOrigins, '*'];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalizedOrigin = origin.toLowerCase();

    if (allowedCorsOrigins.includes('*')) {
      return callback(null, true);
    }

    if (allowedCorsOrigins.includes(origin) || allowedCorsOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    const isLocalDevOrigin = normalizedOrigin.includes('localhost') || normalizedOrigin.includes('127.0.0.1');
    const isRenderOrigin = normalizedOrigin.endsWith('.onrender.com') || normalizedOrigin.endsWith('.render.com');
    const isRailwayOrigin = normalizedOrigin.endsWith('.up.railway.app') || normalizedOrigin.includes('railway.app');
    const isVercelOrigin = normalizedOrigin.endsWith('.vercel.app') || normalizedOrigin.includes('vercel.app');
    const isGitHubPagesOrigin = normalizedOrigin.endsWith('.github.io') || normalizedOrigin.includes('github.io');
    if (isLocalDevOrigin || isRenderOrigin || isRailwayOrigin || isVercelOrigin || isGitHubPagesOrigin) {
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
app.get('/forgot-password.html', (req, res) => res.sendFile(path.join(__dirname, 'forgot-password.html')));
app.get('/reset-password.html', (req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));

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

// Supabase helper functions using official client
function getSupabaseClient(useServiceRole = false) {
  if (useServiceRole && supabaseService) return supabaseService;
  if (supabaseAnon) return supabaseAnon;
  throw new Error('Supabase client is not configured');
}

function parseFilterQuery(filterQuery) {
  const clauses = {};
  if (!filterQuery) return clauses;
  for (const part of filterQuery.split('&')) {
    const [key, value] = part.split('=');
    if (key && value !== undefined) {
      clauses[key] = decodeURIComponent(value);
    }
  }
  return clauses;
}

function applySupabaseFilters(query, filters = {}) {
  let builder = query;
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'order' && typeof value === 'string') {
      const [field, direction] = value.split('.');
      builder = builder.order(field, { ascending: direction !== 'desc' });
      continue;
    }

    if (typeof value === 'string') {
      if (value.startsWith('eq.')) {
        builder = builder.eq(key, value.slice(3));
        continue;
      }
      if (value.startsWith('ilike.')) {
        builder = builder.ilike(key, value.slice(6));
        continue;
      }
      if (value.startsWith('neq.')) {
        builder = builder.neq(key, value.slice(4));
        continue;
      }
      if (value.startsWith('gt.')) {
        builder = builder.gt(key, value.slice(3));
        continue;
      }
      if (value.startsWith('lt.')) {
        builder = builder.lt(key, value.slice(3));
        continue;
      }
    }

    builder = builder.match({ [key]: value });
  }
  return builder;
}

async function supabaseInsert(table, data) {
  const client = getSupabaseClient(Boolean(SUPABASE_SERVICE_ROLE_KEY));
  const { data: result, error } = await client.from(table).insert(data).select();
  if (error) throw error;
  return result;
}

async function supabaseSelect(table, filters = {}) {
  const client = getSupabaseClient(false);
  let query = client.from(table).select('*');
  query = applySupabaseFilters(query, filters);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function supabaseDelete(table, filterQuery) {
  if (!supabaseService) throw new Error('Service role key required for delete');
  const filters = parseFilterQuery(filterQuery);
  let query = supabaseService.from(table).delete();
  query = applySupabaseFilters(query, filters);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function supabaseStorageUpload(bucket, objectPath, fileBuffer, contentType = 'application/octet-stream') {
  if (!supabaseService) {
    throw new Error('Supabase storage is not configured');
  }
  const { data, error } = await supabaseService.storage.from(bucket).upload(objectPath, fileBuffer, {
    contentType,
    upsert: false
  });
  if (error) throw error;
  return data;
}

function getSupabaseStoragePublicUrl(bucket, objectPath) {
  if (!supabaseAnon) {
    return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(objectPath)}`;
  }
  return supabaseAnon.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
}

async function supabaseGetSignedUrl(bucket, objectPath, expiresInSec = 60*60) {
  if (!supabaseService) {
    throw new Error('Supabase service role key is not configured for signing URLs');
  }
  const { data, error } = await supabaseService.storage.from(bucket).createSignedUrl(objectPath, expiresInSec);
  if (error) throw error;
  return data.signedUrl;
}

function parseHotelIdFromRequest(req) {
  const rawHotelId = req.body?.hotelId ?? req.body?.hotel_id ?? req.query?.hotelId ?? req.query?.hotel_id ?? req.headers['x-hotel-id'];
  const hotelId = parseInt(String(rawHotelId || '').trim(), 10);
  return Number.isInteger(hotelId) && hotelId > 0 ? hotelId : null;
}

// ============================================================
// Supabase Auth
// Supabase owns passwords, email verification and password-reset emails.
// This server only validates sessions and maps them to hotel_admin_users rows.
// Configure the email sender in Supabase: Authentication > Emails > SMTP Settings.
// ============================================================
const PASSWORD_PLACEHOLDER = 'SUPABASE_AUTH';

// A fresh client per call so one visitor's session can never leak into another request.
function makeAuthClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' }
  });
}

function authErrorStatus(error) {
  const status = Number(error?.status || 0);
  const msg = String(error?.message || '').toLowerCase();
  if (status === 429 || msg.includes('rate limit')) return 429;
  return status >= 400 && status < 500 ? status : 400;
}

async function dbFindAdmin({ authUserId, identifier }) {
  if (pool) {
    try {
      const byAuth = Boolean(authUserId);
      const cond = byAuth
        ? 'u.auth_user_id = $1'
        : "(LOWER(u.email) = LOWER($1) OR LOWER(COALESCE(u.employee_id,'')) = LOWER($1))";
      const result = await pool.query(
        `SELECT u.id, u.hotel_id, u.full_name, u.email, u.role_id, u.account_status, u.failed_login_attempts,
                u.email_verified_at, u.auth_user_id, h.name AS hotel_name
           FROM hotel_admin_users u
           JOIN hotels h ON h.id = u.hotel_id
          WHERE ${cond} AND u.deleted_at IS NULL
          LIMIT 1`,
        [byAuth ? authUserId : identifier]
      );
      return result.rows[0] || null;
    } catch (err) {
      console.warn('dbFindAdmin via pool failed, trying Supabase client:', err.message || err);
    }
  }

  const db = supabaseService || supabaseAnon;
  if (!db) return null;
  const cols = 'id, hotel_id, full_name, email, role_id, account_status, failed_login_attempts, email_verified_at, auth_user_id';
  let row = null;
  if (authUserId) {
    const { data, error } = await db.from('hotel_admin_users').select(cols).eq('auth_user_id', authUserId).is('deleted_at', null).limit(1);
    if (error) throw error;
    row = data?.[0] || null;
  } else {
    let r = await db.from('hotel_admin_users').select(cols).eq('email', identifier).is('deleted_at', null).limit(1);
    if (r.error) throw r.error;
    row = r.data?.[0] || null;
    if (!row) {
      r = await db.from('hotel_admin_users').select(cols).eq('employee_id', identifier).is('deleted_at', null).limit(1);
      if (r.error) throw r.error;
      row = r.data?.[0] || null;
    }
  }
  if (!row) return null;
  const { data: hotels } = await db.from('hotels').select('name').eq('id', row.hotel_id).limit(1);
  return { ...row, hotel_name: hotels?.[0]?.name || '' };
}

const ADMIN_PATCH_COLUMNS = new Set([
  'failed_login_attempts', 'account_status', 'locked_at', 'last_login_at', 'last_seen_at',
  'is_online', 'email_verified_at', 'auth_user_id', 'force_password_reset'
]);

async function dbUpdateAdmin(id, patch) {
  const keys = Object.keys(patch).filter((k) => ADMIN_PATCH_COLUMNS.has(k));
  if (!keys.length) return;
  if (pool) {
    try {
      const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      await pool.query(
        `UPDATE hotel_admin_users SET ${setSql}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
        [...keys.map((k) => patch[k]), id]
      );
      return;
    } catch (err) {
      console.warn('dbUpdateAdmin via pool failed, trying Supabase client:', err.message || err);
    }
  }
  const db = supabaseService || supabaseAnon;
  if (!db) return;
  const clean = {};
  keys.forEach((k) => { clean[k] = patch[k]; });
  clean.updated_at = new Date().toISOString();
  const { error } = await db.from('hotel_admin_users').update(clean).eq('id', id);
  if (error) console.error('dbUpdateAdmin failed:', error.message);
}

const HOTEL_ADMIN_PERMISSIONS = {
  'View Requests': true, 'Complete Requests': true, 'Edit Requests': true, 'Delete Requests': true,
  'Export Reports': true, 'Manage Staff': true, 'Manage Departments': true, 'View Analytics': true, 'Manage Settings': true
};

// Creates the hotel, its "Hotel Admin" role and the first admin row, linked to the Supabase Auth user.
async function createHotelAndAdmin({ hotelName, fullName, email, authUserId, confirmed }) {
  const status = confirmed ? 'active' : 'pending_verification';
  const verifiedAt = confirmed ? new Date().toISOString() : null;
  const employeeId = `ADM-${Date.now()}`;

  if (pool) {
    let client = null;
    try {
      client = await pool.connect();
    } catch (err) {
      console.warn('Postgres pool connect failed, using Supabase client:', err.message || err);
    }
    if (client) {
      try {
        await client.query('BEGIN');
        const hotelResult = await client.query(
          `INSERT INTO hotels (name, contact_email, timezone, language, date_format, created_at, updated_at)
           VALUES ($1, $2, 'UTC', 'en', 'MMM D, YYYY', NOW(), NOW()) RETURNING id, name`,
          [hotelName, email]
        );
        const hotel = hotelResult.rows[0];
        const roleResult = await client.query(
          `INSERT INTO hotel_admin_roles (hotel_id, name, description, permissions, created_at, updated_at)
           VALUES ($1, 'Hotel Admin', 'Full administrative access', $2::jsonb, NOW(), NOW()) RETURNING id`,
          [hotel.id, JSON.stringify(HOTEL_ADMIN_PERMISSIONS)]
        );
        const userResult = await client.query(
          `INSERT INTO hotel_admin_users
             (hotel_id, role_id, full_name, employee_id, email, password_hash, account_status, employment_status,
              auth_user_id, email_verified_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,NOW(),NOW())
           RETURNING id, hotel_id, full_name, email`,
          [hotel.id, roleResult.rows[0].id, fullName, employeeId, email, PASSWORD_PLACEHOLDER, status, authUserId, verifiedAt]
        );
        await client.query('COMMIT');
        return { hotel, user: userResult.rows[0] };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  }

  const db = supabaseService || supabaseAnon;
  if (!db) throw new Error('No database connection is available');
  const now = new Date().toISOString();

  const { data: hotelRows, error: hotelErr } = await db.from('hotels')
    .insert({ name: hotelName, contact_email: email, timezone: 'UTC', language: 'en', date_format: 'MMM D, YYYY', created_at: now, updated_at: now })
    .select();
  if (hotelErr) throw hotelErr;
  const hotel = hotelRows[0];

  const { data: roleRows, error: roleErr } = await db.from('hotel_admin_roles')
    .insert({ hotel_id: hotel.id, name: 'Hotel Admin', description: 'Full administrative access', permissions: HOTEL_ADMIN_PERMISSIONS, created_at: now, updated_at: now })
    .select();
  if (roleErr) throw roleErr;

  const { data: userRows, error: userErr } = await db.from('hotel_admin_users')
    .insert({
      hotel_id: hotel.id, role_id: roleRows[0].id, full_name: fullName, employee_id: employeeId, email,
      password_hash: PASSWORD_PLACEHOLDER, account_status: status, employment_status: 'active',
      auth_user_id: authUserId, email_verified_at: verifiedAt, created_at: now, updated_at: now
    })
    .select();
  if (userErr) throw userErr;
  const u = userRows[0];
  return { hotel, user: { id: u.id, hotel_id: u.hotel_id, full_name: u.full_name, email: u.email } };
}

async function findAuthUserByEmail(email) {
  if (!supabaseService) return null;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabaseService.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => String(u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

// Checks credentials with Supabase Auth, then applies hotel-level rules (lockout, suspension).
async function authenticateHotelAdmin(identifier, password, req) {
  const row = await dbFindAdmin({ identifier });
  if (!row) return { notFound: true };

  if (row.account_status === 'locked' || row.account_status === 'suspended') {
    await writeHotelAudit(row.hotel_id, row.id, 'blocked_login', 'user', row.id, req);
    return { status: 423, error: 'Account is not active' };
  }
  if (row.account_status === 'deleted') return { status: 401, error: 'Invalid credentials' };

  const { data, error } = await makeAuthClient().auth.signInWithPassword({ email: row.email, password });
  if (error || !data?.session) {
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('not confirmed')) {
      return { status: 403, error: 'Please verify your email before signing in.', code: 'email_not_confirmed' };
    }
    if (authErrorStatus(error) === 429) {
      return { status: 429, error: 'Too many attempts. Please wait a moment and try again.' };
    }
    const failed = Number(row.failed_login_attempts || 0) + 1;
    const locked = failed >= 5;
    await dbUpdateAdmin(row.id, {
      failed_login_attempts: failed,
      account_status: locked ? 'locked' : row.account_status,
      locked_at: locked ? new Date().toISOString() : null
    });
    await writeHotelAudit(row.hotel_id, row.id, 'failed_login', 'user', row.id, req, { failedAttempts: failed });
    if (locked) return { status: 401, error: 'Account locked after failed attempts' };
    return {
      status: 401,
      error: row.auth_user_id
        ? 'Invalid credentials'
        : 'Invalid credentials. If your account was created before the upgrade, use "Forgot password" to set a new password.'
    };
  }

  const now = new Date().toISOString();
  const patch = {
    failed_login_attempts: 0, last_login_at: now, last_seen_at: now, is_online: true,
    email_verified_at: row.email_verified_at || now
  };
  if (!row.auth_user_id) patch.auth_user_id = data.user.id;
  if (row.account_status === 'pending_verification') patch.account_status = 'active';
  await dbUpdateAdmin(row.id, patch);
  await writeHotelAudit(row.hotel_id, row.id, 'login', 'user', row.id, req);

  return {
    ok: true,
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: { id: row.id, hotelId: row.hotel_id, fullName: row.full_name, email: row.email, hotelName: row.hotel_name }
  };
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

    // Use Supabase client to update with service role privileges when available
    const hotelId = parseHotelIdFromRequest(req);
    if (!hotelId) return res.status(400).json({ error: 'hotelId is required' });
    const client = (SUPABASE_SERVICE_ROLE_KEY && supabaseService) ? supabaseService : supabaseAnon;
    if (!client) {
      console.error('[STATUS_UPDATE] Supabase client not configured');
      return res.status(500).json({ error: 'Supabase client is not configured' });
    }

    const { data: updated, error } = await client
      .from('requests')
      .update({ status, updated_at: new Date().toISOString() })
      .match({ id: Number(id), hotel_id: hotelId })
      .select();

    if (error) {
      console.error('[STATUS_UPDATE] Supabase update failed:', error.message || error);
      return res.status(500).json({ error: 'Failed to update request', details: error.message || error });
    }

    if (!Array.isArray(updated) || updated.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const hotelIdForUpdate = updated[0]?.hotel_id || null;
    console.log(`[STATUS_UPDATE] Request ${id} updated to ${status} using ${SUPABASE_SERVICE_ROLE_KEY ? 'SERVICE_ROLE' : 'ANON'} key`);
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
  const { hotelName, fullName, email, password, confirmPassword } = req.body || {};
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
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: 'Authentication is not configured on the server.' });
  }

  const emailRedirectTo = `${FRONTEND_URL}/index.html?verified=1`;

  try {
    const authClient = makeAuthClient();
    const existing = await dbFindAdmin({ identifier: trimmedEmail });
    if (existing) {
      if (existing.account_status === 'pending_verification') {
        await authClient.auth.resend({ type: 'signup', email: existing.email, options: { emailRedirectTo } });
        return res.json({
          ok: true,
          requiresVerification: true,
          emailSent: true,
          message: 'This email is already registered but not verified. We sent a fresh verification email.'
        });
      }
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const { data, error } = await authClient.auth.signUp({
      email: trimmedEmail,
      password: String(password),
      options: { emailRedirectTo, data: { full_name: trimmedFullName, hotel_name: trimmedHotelName } }
    });
    if (error) {
      const status = authErrorStatus(error);
      console.error('Supabase signUp failed:', error.status, error.message);
      if (status === 429) {
        return res.status(429).json({ error: 'Too many verification emails were requested. Please wait a few minutes and try again.' });
      }
      return res.status(status === 422 ? 400 : status).json({ error: error.message || 'Could not create the account.' });
    }

    const authUser = data?.user;
    // Supabase hides duplicate emails by returning a user with no identities.
    if (!authUser || (Array.isArray(authUser.identities) && authUser.identities.length === 0)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const confirmed = Boolean(authUser.email_confirmed_at) || Boolean(data.session);
    let created;
    try {
      created = await createHotelAndAdmin({
        hotelName: trimmedHotelName, fullName: trimmedFullName, email: trimmedEmail, authUserId: authUser.id, confirmed
      });
    } catch (dbErr) {
      console.error('Hotel registration failed after Supabase signUp:', dbErr);
      if (supabaseService) await supabaseService.auth.admin.deleteUser(authUser.id).catch(() => {});
      return res.status(500).json({ error: 'Hotel registration failed. Please try again.' });
    }

    await writeHotelAudit(created.hotel.id, created.user.id, 'registered_hotel', 'hotel', created.hotel.id, req);
    const userOut = {
      id: created.user.id, hotelId: created.hotel.id, fullName: created.user.full_name,
      email: created.user.email, hotelName: created.hotel.name
    };

    if (confirmed && data.session) {
      return res.status(201).json({
        ok: true, requiresVerification: false, role: 'hotel_admin', redirectUrl: 'hotel_admin.html',
        token: data.session.access_token, refreshToken: data.session.refresh_token, user: userOut
      });
    }
    return res.status(201).json({
      ok: true,
      requiresVerification: true,
      emailSent: true,
      message: 'Account created. Check your inbox (and spam folder) for the verification email.',
      user: userOut,
      role: 'hotel_admin'
    });
  } catch (err) {
    console.error('Registration failed:', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const { error } = await makeAuthClient().auth.resend({
      type: 'signup', email, options: { emailRedirectTo: `${FRONTEND_URL}/index.html?verified=1` }
    });
    if (error && authErrorStatus(error) === 429) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another email.' });
    }
    if (error) console.warn('Supabase resend failed:', error.message);
    // Same answer whether or not the account exists.
    return res.json({ ok: true, message: 'If that account is awaiting verification, a new email has been sent.' });
  } catch (err) {
    console.error('Resend verification failed:', err);
    return res.status(500).json({ error: 'Could not resend the verification email.' });
  }
});

async function handleForgotPassword(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });
  const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
  try {
    const row = await dbFindAdmin({ identifier: email });
    if (row) {
      // Accounts created before the Supabase Auth upgrade have no auth user yet: create and link one.
      if (!row.auth_user_id && supabaseService) {
        let authUser = null;
        const { data, error } = await supabaseService.auth.admin.createUser({
          email: row.email, email_confirm: true, password: crypto.randomBytes(24).toString('hex'),
          user_metadata: { full_name: row.full_name }
        });
        if (error) authUser = await findAuthUserByEmail(row.email);
        else authUser = data.user;
        if (authUser) {
          await dbUpdateAdmin(row.id, { auth_user_id: authUser.id, email_verified_at: row.email_verified_at || new Date().toISOString() });
        }
      }
      const { error } = await makeAuthClient().auth.resetPasswordForEmail(row.email, {
        redirectTo: `${FRONTEND_URL}/reset-password.html`
      });
      if (error) {
        console.warn('Supabase resetPasswordForEmail failed:', error.message);
        if (authErrorStatus(error) === 429) {
          return res.status(429).json({ error: 'Please wait a minute before requesting another reset email.' });
        }
      }
      await writeHotelAudit(row.hotel_id, row.id, 'password_reset_requested', 'user', row.id, req);
    }
    return res.status(202).json(generic);
  } catch (err) {
    console.error('Forgot password failed:', err);
    return res.status(500).json({ error: 'Password reset request failed' });
  }
}

app.post('/api/auth/forgot-password', handleForgotPassword);
app.post('/api/auth/hotel-admin/password-reset', handleForgotPassword);

// Called by reset-password.html with the recovery token Supabase puts in the email link.
app.post('/api/auth/reset-password', async (req, res) => {
  const accessToken = String(req.body?.accessToken || '').trim();
  const password = String(req.body?.password || '');
  if (!accessToken || !password) return res.status(400).json({ error: 'Reset token and new password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  if (!supabaseService) return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server.' });

  try {
    const { data, error } = await makeAuthClient().auth.getUser(accessToken);
    if (error || !data?.user) return res.status(401).json({ error: 'This reset link is invalid or has expired.' });

    const { error: updateError } = await supabaseService.auth.admin.updateUserById(data.user.id, { password });
    if (updateError) {
      return res.status(authErrorStatus(updateError) === 422 ? 400 : 500).json({ error: updateError.message || 'Could not update the password.' });
    }
    const row = await dbFindAdmin({ authUserId: data.user.id });
    if (row) {
      await dbUpdateAdmin(row.id, { force_password_reset: false, failed_login_attempts: 0 });
      await writeHotelAudit(row.hotel_id, row.id, 'password_reset_completed', 'user', row.id, req);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Reset password failed:', err);
    return res.status(500).json({ error: 'Could not reset the password.' });
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
    // Supabase validates the session token (signature, expiry, revoked sessions).
    const { data, error } = await makeAuthClient().auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });

    const result = await pool.query(
      `SELECT u.id, u.hotel_id, u.full_name, u.email, u.role_id, u.account_status, h.name AS hotel_name
       FROM hotel_admin_users u
       JOIN hotels h ON h.id = u.hotel_id
       WHERE u.auth_user_id = $1 AND u.deleted_at IS NULL`,
      [data.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(403).json({ error: 'Hotel admin access required' });
    if (user.account_status !== 'active') return res.status(401).json({ error: 'Account is not active' });

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

async function hotelAdminLogin(req, res, { allowDirectorFallback }) {
  const loginIdentifier = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password;
  if (!loginIdentifier || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await authenticateHotelAdmin(loginIdentifier, password, req);
    if (!result.notFound) {
      if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
      if (!pool) {
        return res.status(503).json({
          error: 'Admin portal database is unavailable. Configure DATABASE_URL on the backend and restart the server.'
        });
      }
      return res.json({
        role: 'hotel_admin',
        redirectUrl: 'hotel_admin.html',
        token: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        user: result.user
      });
    }
  } catch (err) {
    console.error('Hotel admin login failed:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }

  if (!allowDirectorFallback) return res.status(401).json({ error: 'Invalid credentials' });

  try {
    const hotelId = parseHotelIdFromRequest(req);
    const filters = { username: `eq.${loginIdentifier}` };
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
}

app.post('/api/auth/hotel-admin', (req, res) => hotelAdminLogin(req, res, { allowDirectorFallback: false }));
app.post('/api/auth/login', (req, res) => hotelAdminLogin(req, res, { allowDirectorFallback: true }));

app.post('/api/auth/hotel-admin/logout', requireHotelAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE hotel_admin_users SET is_online = FALSE, last_seen_at = NOW() WHERE id = $1', [req.hotelAdmin.id]);
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'logout', 'user', req.hotelAdmin.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
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
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  if (!supabaseService) return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is required to create staff accounts' });

  const lowered = String(email).trim().toLowerCase();
  let authUserId = null;
  try {
    // Staff are created already confirmed: the hotel admin vouches for the address and hands over the password.
    const { data, error } = await supabaseService.auth.admin.createUser({
      email: lowered, password: String(password), email_confirm: true, user_metadata: { full_name: fullName }
    });
    if (error) {
      const taken = /already|registered|exists/i.test(error.message || '');
      return res.status(taken ? 409 : 400).json({ error: taken ? 'A user with that email already exists' : (error.message || 'Failed to create user') });
    }
    authUserId = data.user.id;

    const result = await pool.query(
      `INSERT INTO hotel_admin_users
       (hotel_id, full_name, employee_id, department_id, role_id, email, phone, shift_id, employment_status, account_status, password_hash, profile_photo_url, auth_user_id, email_verified_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW(),NOW())
       RETURNING *`,
      [hotelId, fullName, employeeId || null, departmentId || null, roleId || null, lowered, phone || null, shiftId || null, employmentStatus || 'active', accountStatus || 'active', PASSWORD_PLACEHOLDER, profilePhotoUrl || null, authUserId]
    );
    await writeHotelAudit(hotelId, req.hotelAdmin.id, 'user_created', 'user', result.rows[0].id, req, { email: lowered });
    const row = result.rows[0];
    delete row.password_hash;
    delete row.verification_token;
    res.status(201).json(row);
  } catch (err) {
    if (authUserId) await supabaseService.auth.admin.deleteUser(authUserId).catch(() => {});
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
    const updated = result.rows[0];
    if (email && updated.auth_user_id && supabaseService) {
      const { error: syncErr } = await supabaseService.auth.admin.updateUserById(updated.auth_user_id, { email: String(email).trim().toLowerCase(), email_confirm: true });
      if (syncErr) console.warn('Could not sync email to Supabase Auth:', syncErr.message);
    }
    await writeHotelAudit(req.hotelAdmin.hotel_id, req.hotelAdmin.id, 'profile_updated', 'user', req.params.id, req);
    delete updated.password_hash;
    delete updated.verification_token;
    res.json(updated);
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
       WHERE id = $1 AND hotel_id = $2 AND deleted_at IS NULL RETURNING id, auth_user_id`,
      [req.params.id, req.hotelAdmin.hotel_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].auth_user_id && supabaseService) {
      await supabaseService.auth.admin.deleteUser(result.rows[0].auth_user_id).catch((e) => console.warn('Could not delete Supabase Auth user:', e.message));
    }
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