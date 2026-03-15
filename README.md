# LUXE Hotel QR Services System

A comprehensive digital concierge system for luxury hotels, featuring QR code-enabled service requests, real-time staff management, and executive oversight.

## Features

### Guest Interface (`index.html`)
- Luxury QR code-scanned service request interface
- 8 service categories (Housekeeping, Maintenance, Room Service, Concierge, etc.)
- Voice recording for detailed requests
- Real-time request status tracking

### Department Dashboard (`department_dashboard.html`)
- Staff login for specific departments
- Filtered request management
- Status updates (pending → in-progress → completed)
- Real-time notifications for new requests

### Director Dashboard (`director_dashboard.html`)
- Executive overview of all operations
- Real-time statistics and KPIs
- Department performance monitoring
- Report generation
- System health monitoring

## Backend Architecture

### Database Schema
- **departments**: Department authentication
- **director**: Director authentication
- **requests**: Service requests with status tracking
- **Voice recordings**: Stored as files with URLs

### API Endpoints
- `POST /api/requests` - Create new request
- `GET /api/requests` - Get all requests (director)
- `GET /api/requests/:department` - Get department requests
- `PUT /api/requests/:id/status` - Update request status
- `POST /api/auth/department` - Department login
- `POST /api/auth/director` - Director login

### Real-time Features
- Socket.io for instant notifications
- Live request updates across all interfaces

## Setup Instructions

### Prerequisites
- Node.js (v14 or higher)
- SQLite3

### Installation

1. **Install Dependencies**
   ```bash
   npm install
   ```

## Supabase Setup Guide

### 1. Create Supabase Project
1. Go to [supabase.com](https://supabase.com) and sign up/login
2. Click "New Project"
3. Choose your organization and enter project details:
   - **Name**: `luxe-hotel-services`
   - **Database Password**: Choose a strong password
   - **Region**: Select closest to your users

### 2. Get Database Credentials
1. In your Supabase dashboard, go to **Settings** → **Database**
2. Copy the **Connection string** (it looks like: `postgres://postgres:[password]@db.[project-ref].supabase.co:5432/postgres`)
3. Note down your project URL and anon key (for future use)

### 3. Configure Environment
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Update `.env` with your Supabase credentials:
   ```env
   DATABASE_URL=postgres://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
   JWT_SECRET=your_super_secret_jwt_key_here
   INIT_DB=true
   ```

### 4. Run Database Schema
The server will automatically run `schema.sql` when `INIT_DB=true`, creating tables and seeding data.

### 5. Test Connection
```bash
npm start
# Should see: "Connected to PostgreSQL database" and "Database schema initialized"
```

### 6. Verify Setup
Test the health endpoint:
```bash
curl http://localhost:3000/api/health
# Should return: {"status":"OK","timestamp":"..."}
```

## Alternative: Local PostgreSQL

If you prefer local development:

1. Install PostgreSQL locally
2. Create a database: `createdb luxe_hotel`
3. Update `.env`:
   ```env
   DATABASE_URL=postgres://username:password@localhost:5432/luxe_hotel
   ```
4. Run schema manually or let the app initialize it

3. **Initialize Database (Optional)**
   If `INIT_DB=true`, the server will run `schema.sql` on startup and seed default data.

4. **Start Backend Server**
   ```bash
   npm start
   # or for development
   npm run dev
   ```
   Server runs on `http://localhost:3000`

4. **Open Frontend Files**
   - Guest interface: Open `index.html` in browser
   - Department dashboard: Open `department_dashboard.html` in browser
   - Director dashboard: Open `director_dashboard.html` in browser

### Default Credentials

**Departments:**
- Maintenance: `wrench`
- Housekeeping: `broom`
- Room Service: `plate`
- Concierge: `bell`
- Laundry: `shirt`

**Director:**
- Username: `director`
- Password: `pearl`

## Development

### Project Structure
```
hotelQRservices/
├── index.html                 # Guest interface
├── department_dashboard.html  # Department staff interface
├── director_dashboard.html    # Executive dashboard
├── server.js                  # Backend server
├── schema.sql                 # Database schema
├── package.json               # Dependencies
└── uploads/                   # Voice recordings (created automatically)
```

### Adding New Features
1. Update database schema in `schema.sql`
2. Add API endpoints in `server.js`
3. Update frontend interfaces accordingly

### Security Notes
- Passwords are stored in plain text for demo purposes
- In production, use proper password hashing
- Implement proper authentication tokens
- Add HTTPS and CORS configuration

## Technologies Used
- **Frontend**: HTML, CSS (Tailwind), JavaScript
- **Backend**: Node.js, Express.js
- **Database**: SQLite3
- **Real-time**: Socket.io
- **File Upload**: Multer

## Future Enhancements
- User authentication for guests
- Push notifications for staff
- Advanced analytics and reporting
- Mobile app versions
- Integration with hotel PMS systems

---

**Powered by PeerLoom Technologies**