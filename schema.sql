-- ============================================================
-- Merged multi-tenant schema for the Hotel Admin Portal.
-- Each tenant-owned record is scoped by hotel_id.
-- Safe to re-run: everything uses IF NOT EXISTS and guarded inserts.
-- ============================================================

CREATE TABLE IF NOT EXISTS hotels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  address TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  language TEXT NOT NULL DEFAULT 'en',
  date_format TEXT NOT NULL DEFAULT 'MMM D, YYYY',
  brand_colors JSONB NOT NULL DEFAULT '{}'::jsonb,
  email_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hotel_id, name)
);

ALTER TABLE departments
  ADD CONSTRAINT departments_hotel_name_unique UNIQUE (hotel_id, name);

CREATE TABLE IF NOT EXISTS director (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hotel_id, username)
);

ALTER TABLE director
  ADD CONSTRAINT director_hotel_username_unique UNIQUE (hotel_id, username);

CREATE TABLE IF NOT EXISTS hotel_admin_roles (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hotel_id, name)
);

ALTER TABLE hotel_admin_roles
  ADD CONSTRAINT hotel_admin_roles_hotel_name_unique UNIQUE (hotel_id, name);

CREATE TABLE IF NOT EXISTS hotel_admin_departments (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  manager_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hotel_id, name)
);

ALTER TABLE hotel_admin_departments
  ADD CONSTRAINT hotel_admin_departments_hotel_name_unique UNIQUE (hotel_id, name);

CREATE TABLE IF NOT EXISTS hotel_admin_shifts (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_time TIME,
  end_time TIME,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hotel_id, name)
);

ALTER TABLE hotel_admin_shifts
  ADD CONSTRAINT hotel_admin_shifts_hotel_name_unique UNIQUE (hotel_id, name);

CREATE TABLE IF NOT EXISTS hotel_admin_users (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  employee_id TEXT,
  department_id INTEGER REFERENCES hotel_admin_departments(id) ON DELETE SET NULL,
  role_id INTEGER REFERENCES hotel_admin_roles(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  phone TEXT,
  shift_id INTEGER REFERENCES hotel_admin_shifts(id) ON DELETE SET NULL,
  employment_status TEXT NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','inactive','terminated','leave')),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','locked','deleted')),
  password_hash TEXT NOT NULL,
  profile_photo_url TEXT,
  force_password_reset BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (hotel_id, email),
  UNIQUE (hotel_id, employee_id)
);

ALTER TABLE hotel_admin_users
  ADD CONSTRAINT hotel_admin_users_hotel_email_unique UNIQUE (hotel_id, email),
  ADD CONSTRAINT hotel_admin_users_hotel_employee_id_unique UNIQUE (hotel_id, employee_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hotel_admin_departments_manager_fk'
  ) THEN
    ALTER TABLE hotel_admin_departments
      ADD CONSTRAINT hotel_admin_departments_manager_fk
      FOREIGN KEY (manager_id) REFERENCES hotel_admin_users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS hotel_admin_audit_logs (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES hotel_admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_address TEXT,
  device TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hotel_admin_notifications (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  sender_user_id INTEGER REFERENCES hotel_admin_users(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES hotel_admin_departments(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'announcement' CHECK (type IN ('announcement','department','maintenance')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','sent','delivered','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hotel_admin_password_resets (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES hotel_admin_users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_number TEXT NOT NULL,
  service TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in-progress','completed')),
  voice_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  dept TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'departments' AND column_name = 'hotel_id') THEN
    ALTER TABLE departments ADD COLUMN hotel_id INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'departments' AND column_name = 'name') THEN
    ALTER TABLE departments ADD COLUMN name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'departments' AND column_name = 'password_hash') THEN
    ALTER TABLE departments ADD COLUMN password_hash TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'departments' AND column_name = 'created_at') THEN
    ALTER TABLE departments ADD COLUMN created_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'director' AND column_name = 'hotel_id') THEN
    ALTER TABLE director ADD COLUMN hotel_id INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'director' AND column_name = 'username') THEN
    ALTER TABLE director ADD COLUMN username TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'director' AND column_name = 'password_hash') THEN
    ALTER TABLE director ADD COLUMN password_hash TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'director' AND column_name = 'full_name') THEN
    ALTER TABLE director ADD COLUMN full_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'director' AND column_name = 'created_at') THEN
    ALTER TABLE director ADD COLUMN created_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'hotel_id') THEN
    ALTER TABLE requests ADD COLUMN hotel_id INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'room_number') THEN
    ALTER TABLE requests ADD COLUMN room_number TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'service') THEN
    ALTER TABLE requests ADD COLUMN service TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'request_text') THEN
    ALTER TABLE requests ADD COLUMN request_text TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'status') THEN
    ALTER TABLE requests ADD COLUMN status TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'voice_url') THEN
    ALTER TABLE requests ADD COLUMN voice_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'created_at') THEN
    ALTER TABLE requests ADD COLUMN created_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'updated_at') THEN
    ALTER TABLE requests ADD COLUMN updated_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'password_resets' AND column_name = 'hotel_id') THEN
    ALTER TABLE password_resets ADD COLUMN hotel_id INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'password_resets' AND column_name = 'dept') THEN
    ALTER TABLE password_resets ADD COLUMN dept TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'password_resets' AND column_name = 'status') THEN
    ALTER TABLE password_resets ADD COLUMN status TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'password_resets' AND column_name = 'created_at') THEN
    ALTER TABLE password_resets ADD COLUMN created_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_departments_hotel ON departments(hotel_id);
CREATE INDEX IF NOT EXISTS idx_director_hotel ON director(hotel_id);
CREATE INDEX IF NOT EXISTS idx_requests_hotel_created ON requests(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status_hotel ON requests(hotel_id, status);
CREATE INDEX IF NOT EXISTS idx_password_resets_hotel_created ON password_resets(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_users_hotel ON hotel_admin_users(hotel_id);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_users_department ON hotel_admin_users(department_id);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_audit_hotel_created ON hotel_admin_audit_logs(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_notifications_hotel_created ON hotel_admin_notifications(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_departments_hotel ON hotel_admin_departments(hotel_id);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_roles_hotel ON hotel_admin_roles(hotel_id);

-- ============================================================
-- Seed data — required to log in the first time
-- ============================================================

-- Your hotel record
INSERT INTO hotels (name, contact_email, timezone, language, date_format)
SELECT 'LUXE Hotel', 'admin@luxehotel.com', 'UTC', 'en', 'MMM D, YYYY'
WHERE NOT EXISTS (
  SELECT 1 FROM hotels WHERE name = 'LUXE Hotel'
);

-- Full-access "Hotel Admin" role
INSERT INTO hotel_admin_roles (hotel_id, name, description, permissions)
SELECT h.id, 'Hotel Admin', 'Full administrative access', '{
  "View Requests": true, "Complete Requests": true, "Edit Requests": true, "Delete Requests": true,
  "Export Reports": true, "Manage Staff": true, "Manage Departments": true,
  "View Analytics": true, "Manage Settings": true
}'::jsonb
FROM hotels h
WHERE h.name = 'LUXE Hotel'
AND NOT EXISTS (
  SELECT 1 FROM hotel_admin_roles r
  WHERE r.hotel_id = h.id AND r.name = 'Hotel Admin'
);

-- Department login seed
INSERT INTO departments (hotel_id, name, password_hash)
SELECT h.id, 'Maintenance', '$2a$10$Bc5ipzhyq3qTFqayl8A3nuCt.FrepwMxdSUHXWokUsSUMH3Y/onsy'
FROM hotels h
WHERE h.name = 'LUXE Hotel'
AND NOT EXISTS (
  SELECT 1 FROM departments d
  WHERE d.hotel_id = h.id AND d.name = 'Maintenance'
);

-- Director login seed
INSERT INTO director (hotel_id, username, password_hash, full_name)
SELECT h.id, 'director', '$2a$10$Bc5ipzhyq3qTFqayl8A3nuCt.FrepwMxdSUHXWokUsSUMH3Y/onsy', 'Director'
FROM hotels h
WHERE h.name = 'LUXE Hotel'
AND NOT EXISTS (
  SELECT 1 FROM director d
  WHERE d.hotel_id = h.id AND d.username = 'director'
);

-- First Hotel Admin login
-- Email: admin@luxehotel.com   Password: ChangeMe123!  (verified working hash — change after first login)
INSERT INTO hotel_admin_users (hotel_id, role_id, full_name, employee_id, email, password_hash, account_status, employment_status)
SELECT h.id, r.id, 'Hotel Administrator', 'ADM-001', 'admin@luxehotel.com',
       '$2b$10$xpvhluU9Au3GQRB0odgRCODP99xxTYOmgaANjVC0JDHC1FI/ASVXe',
       'active', 'active'
FROM hotels h
JOIN hotel_admin_roles r ON r.hotel_id = h.id AND r.name = 'Hotel Admin'
WHERE h.name = 'LUXE Hotel'
AND NOT EXISTS (
  SELECT 1 FROM hotel_admin_users u
  WHERE u.hotel_id = h.id AND u.email = 'admin@luxehotel.com'
);

-- Example request and password reset rows using the same snake_case naming as the API
INSERT INTO requests (hotel_id, room_number, service, request_text, status, voice_url)
SELECT h.id, '101', 'maintenance', 'Please fix the air conditioner.', 'pending', NULL
FROM hotels h
WHERE h.name = 'LUXE Hotel'
AND NOT EXISTS (
  SELECT 1 FROM requests r
  WHERE r.hotel_id = h.id
    AND r.room_number = '101'
    AND r.service = 'maintenance'
);

INSERT INTO password_resets (hotel_id, dept, status)
SELECT h.id, 'Maintenance', 'pending'
FROM hotels h
WHERE h.name = 'LUXE Hotel'
AND NOT EXISTS (
  SELECT 1 FROM password_resets pr
  WHERE pr.hotel_id = h.id
    AND pr.dept = 'Maintenance'
);
