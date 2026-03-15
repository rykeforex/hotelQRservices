-- Database schema for LUXE Hotel QR Services (PostgreSQL / Supabase)

-- Departments table
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Director table (single entry)
CREATE TABLE IF NOT EXISTS director (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Requests table
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  room_number TEXT NOT NULL,
  service TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in-progress', 'completed')),
  voice_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default departments (will not overwrite existing)
INSERT INTO departments (name, password_hash) VALUES
  ('Maintenance', '$2a$10$example.hash.for.wrench'),
  ('Housekeeping', '$2a$10$example.hash.for.broom'),
  ('Room Service', '$2a$10$example.hash.for.plate'),
  ('Concierge', '$2a$10$example.hash.for.bell'),
  ('Laundry', '$2a$10$example.hash.for.shirt')
ON CONFLICT (name) DO NOTHING;

-- Seed director account
INSERT INTO director (id, username, password_hash) VALUES
  (1, 'director', '$2a$10$example.hash.for.pearl')
ON CONFLICT (id) DO NOTHING;

-- Seed sample requests
INSERT INTO requests (room_number, service, request_text, status) VALUES
  ('201', 'maintenance', 'Broken air conditioning', 'pending'),
  ('305', 'housekeeping', 'Clean my room', 'in-progress'),
  ('412', 'roomservice', 'Order breakfast', 'completed'),
  ('108', 'concierge', 'Taxi request', 'pending'),
  ('256', 'laundry', 'Wash & fold', 'in-progress')
ON CONFLICT DO NOTHING;
