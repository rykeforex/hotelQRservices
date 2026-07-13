-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.departments (
  id integer NOT NULL DEFAULT nextval('departments_id_seq'::regclass),
  name text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT departments_pkey PRIMARY KEY (id)
);
CREATE TABLE public.director (
  id integer NOT NULL CHECK (id = 1),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT director_pkey PRIMARY KEY (id)
);
CREATE TABLE public.requests (
  id integer NOT NULL DEFAULT nextval('requests_id_seq'::regclass),
  room_number text NOT NULL,
  service text NOT NULL,
  request_text text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'in-progress'::text, 'completed'::text])),
  voice_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT requests_pkey PRIMARY KEY (id)
);
CREATE TABLE public.password_resets (
  id integer NOT NULL DEFAULT nextval('password_resets_id_seq'::regclass),
  dept text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT password_resets_pkey PRIMARY KEY (id)
);
CREATE TABLE public.hotels (
  id integer NOT NULL DEFAULT nextval('hotels_id_seq'::regclass),
  name text NOT NULL,
  logo_url text,
  address text,
  contact_email text,
  contact_phone text,
  timezone text NOT NULL DEFAULT 'UTC'::text,
  language text NOT NULL DEFAULT 'en'::text,
  date_format text NOT NULL DEFAULT 'MMM D, YYYY'::text,
  brand_colors jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotels_pkey PRIMARY KEY (id)
);
CREATE TABLE public.hotel_admin_roles (
  id integer NOT NULL DEFAULT nextval('hotel_admin_roles_id_seq'::regclass),
  hotel_id integer NOT NULL,
  name text NOT NULL,
  description text,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotel_admin_roles_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_roles_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id)
);
CREATE TABLE public.hotel_admin_departments (
  id integer NOT NULL DEFAULT nextval('hotel_admin_departments_id_seq'::regclass),
  hotel_id integer NOT NULL,
  name text NOT NULL,
  manager_id integer,
  status text NOT NULL DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotel_admin_departments_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_departments_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id),
  CONSTRAINT hotel_admin_departments_manager_fk FOREIGN KEY (manager_id) REFERENCES public.hotel_admin_users(id)
);
CREATE TABLE public.hotel_admin_shifts (
  id integer NOT NULL DEFAULT nextval('hotel_admin_shifts_id_seq'::regclass),
  hotel_id integer NOT NULL,
  name text NOT NULL,
  start_time time without time zone,
  end_time time without time zone,
  status text NOT NULL DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotel_admin_shifts_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_shifts_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id)
);
CREATE TABLE public.hotel_admin_users (
  id integer NOT NULL DEFAULT nextval('hotel_admin_users_id_seq'::regclass),
  hotel_id integer NOT NULL,
  full_name text NOT NULL,
  employee_id text,
  department_id integer,
  role_id integer,
  email text NOT NULL,
  phone text,
  shift_id integer,
  employment_status text NOT NULL DEFAULT 'active'::text CHECK (employment_status = ANY (ARRAY['active'::text, 'inactive'::text, 'terminated'::text, 'leave'::text])),
  account_status text NOT NULL DEFAULT 'active'::text CHECK (account_status = ANY (ARRAY['active'::text, 'suspended'::text, 'locked'::text, 'deleted'::text])),
  password_hash text NOT NULL,
  profile_photo_url text,
  force_password_reset boolean NOT NULL DEFAULT false,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  is_online boolean NOT NULL DEFAULT false,
  last_login_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  locked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT hotel_admin_users_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_users_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id),
  CONSTRAINT hotel_admin_users_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.hotel_admin_departments(id),
  CONSTRAINT hotel_admin_users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.hotel_admin_roles(id),
  CONSTRAINT hotel_admin_users_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.hotel_admin_shifts(id)
);
CREATE TABLE public.hotel_admin_audit_logs (
  id integer NOT NULL DEFAULT nextval('hotel_admin_audit_logs_id_seq'::regclass),
  hotel_id integer NOT NULL,
  actor_user_id integer,
  action text NOT NULL,
  target_type text,
  target_id text,
  ip_address text,
  device text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotel_admin_audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_audit_logs_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id),
  CONSTRAINT hotel_admin_audit_logs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.hotel_admin_users(id)
);
CREATE TABLE public.hotel_admin_notifications (
  id integer NOT NULL DEFAULT nextval('hotel_admin_notifications_id_seq'::regclass),
  hotel_id integer NOT NULL,
  sender_user_id integer,
  department_id integer,
  type text NOT NULL DEFAULT 'announcement'::text CHECK (type = ANY (ARRAY['announcement'::text, 'department'::text, 'maintenance'::text])),
  title text NOT NULL,
  message text NOT NULL,
  delivery_status text NOT NULL DEFAULT 'queued'::text CHECK (delivery_status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'failed'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotel_admin_notifications_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_notifications_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id),
  CONSTRAINT hotel_admin_notifications_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.hotel_admin_users(id),
  CONSTRAINT hotel_admin_notifications_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.hotel_admin_departments(id)
);
CREATE TABLE public.hotel_admin_password_resets (
  id integer NOT NULL DEFAULT nextval('hotel_admin_password_resets_id_seq'::regclass),
  hotel_id integer NOT NULL,
  user_id integer,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  CONSTRAINT hotel_admin_password_resets_pkey PRIMARY KEY (id),
  CONSTRAINT hotel_admin_password_resets_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id),
  CONSTRAINT hotel_admin_password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.hotel_admin_users(id)
);