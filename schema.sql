-- ============================================================
-- Creates the Hotel Admin Portal tables + seeds a working login.
-- Safe to re-run: everything uses IF NOT EXISTS / ON CONFLICT.
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

CREATE INDEX IF NOT EXISTS idx_hotel_admin_users_hotel ON hotel_admin_users(hotel_id);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_users_department ON hotel_admin_users(department_id);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_audit_hotel_created ON hotel_admin_audit_logs(hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hotel_admin_notifications_hotel_created ON hotel_admin_notifications(hotel_id, created_at DESC);

-- ============================================================
-- Seed data — required to log in the first time
-- ============================================================

-- Your hotel record
INSERT INTO hotels (name, contact_email, timezone, language, date_format)
VALUES ('LUXE Hotel', 'admin@luxehotel.com', 'UTC', 'en', 'MMM D, YYYY')
ON CONFLICT DO NOTHING;

-- Full-access "Hotel Admin" role
INSERT INTO hotel_admin_roles (hotel_id, name, description, permissions)
SELECT id, 'Hotel Admin', 'Full administrative access', '{
  "View Requests": true, "Complete Requests": true, "Edit Requests": true, "Delete Requests": true,
  "Export Reports": true, "Manage Staff": true, "Manage Departments": true,
  "View Analytics": true, "Manage Settings": true
}'::jsonb
FROM hotels WHERE name = 'LUXE Hotel'
ON CONFLICT (hotel_id, name) DO NOTHING;

-- First Hotel Admin login
-- Email: admin@luxehotel.com   Password: ChangeMe123!  (verified working hash — change after first login)
INSERT INTO hotel_admin_users (hotel_id, role_id, full_name, employee_id, email, password_hash, account_status, employment_status)
SELECT h.id, r.id, 'Hotel Administrator', 'ADM-001', 'admin@luxehotel.com',
       '$2b$10$xpvhluU9Au3GQRB0odgRCODP99xxTYOmgaANjVC0JDHC1FI/ASVXe',
       'active', 'active'
FROM hotels h
JOIN hotel_admin_roles r ON r.hotel_id = h.id AND r.name = 'Hotel Admin'
WHERE h.name = 'LUXE Hotel'
ON CONFLICT (hotel_id, email) DO NOTHING;
