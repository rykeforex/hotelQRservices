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

## Architecture

### Hybrid Client-Side + Real-Time System

This application combines **Supabase client-side operations** with **Socket.io real-time updates** for optimal performance and user experience.

### Database Schema
- **requests**: Service requests with status tracking
  - `id` (auto-increment)
  - `room_number` (text)
  - `service` (text)
  - `request_text` (text)
  - `voice_url` (text, optional)
  - `status` (text: 'pending', 'in-progress', 'completed')
  - `created_at` (timestamp)
  - `updated_at` (timestamp)

### Client-Side Operations
- **Supabase Client**: Direct database queries from browser
- **Socket.io**: Real-time notifications for new requests and status updates
- **Authentication**: Secure password-based login with backend-managed credentials
- **Password recovery**: Hotel admins can submit a password reset request for administrator review from the sign-in page
- **File Storage**: Voice recordings in Supabase Storage

### Real-Time Features
- **Live Updates**: New requests appear instantly on department/director dashboards
- **Status Changes**: Updates propagate immediately across all connected clients
- **Voice Notes**: New voice recordings trigger notifications
- **Cross-Client Sync**: All dashboards stay synchronized in real-time

### Security Notes
- In production, implement proper authentication
- Use Row Level Security (RLS) policies in Supabase
- Store sensitive credentials securely
- Consider API rate limiting

## Setup Instructions

### Prerequisites
- Supabase account (free tier available)
- Web browser with JavaScript enabled

### Supabase Setup

1. **Create Supabase Project**
   - Go to [supabase.com](https://supabase.com) and sign up/login
   - Click "New Project"
   - Name: `luxe-hotel-services`
   - Choose a strong database password
   - Select region closest to your users

2. **Get Project Credentials**
   - In your Supabase dashboard, go to **Settings** → **API**
   - Copy your **Project URL** and **anon/public key**
   - Copy the `service_role` key only for the backend; never put it in browser code or share it publicly

3. **Configure the Application**
   - Open the backend `.env` file and set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
   - Replace `https://YOUR_PROJECT_REF.supabase.co` with the Project URL from Supabase.
   - `.env` is ignored by Git; keep your keys there and out of frontend files.

4. **Configure Backend Storage**
   - Set `SUPABASE_SERVICE_ROLE_KEY` in `.env` using the service role key from Supabase API settings.
   - Set `SUPABASE_STORAGE_BUCKET=audio` (the bucket used for voice recordings).
   - Ensure the bucket exists and is set to public access so recordings can be retrieved.

5. **Configure Confirmation Email**
   - Configure an email provider in the backend environment. Supported options are Resend (`RESEND_API_KEY`), Brevo (`BREVO_API_KEY`), SendGrid (`SENDGRID_API_KEY`), or SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`).
   - Set `SMTP_FROM` to a sender address verified with your email provider. For API providers, verify the sender/domain in that provider before testing.
   - Set `APP_BASE_URL` to the public URL of the backend so verification links open the deployed app.
   - Keep provider credentials only in the backend environment (for example, Render's environment settings), never in frontend files. Signup returns quickly and sends confirmation email in the background; check backend logs for provider delivery failures.

6. **Set Up Database Schema**
   - In your Supabase dashboard, go to **SQL Editor**
   - Run the contents of `schema.sql` to create tables
   - This creates the `requests` table with proper structure

7. **Configure Storage (Optional)**
   - For voice recordings, create a storage bucket called `voice-recordings`
   - Set bucket to public access for voice playback

### Deployment

#### Option 1: GitHub Pages (Recommended)
1. Push code to GitHub repository
2. Go to repository **Settings** → **Pages**
3. Set source to "Deploy from a branch"
4. Select main branch and save
5. Your site will be available at `https://yourusername.github.io/repository-name`

#### Option 2: Direct File Access
- Open `index.html` directly in a web browser
- All files work offline once Supabase is configured

### Testing

1. **Start the backend server** (real-time updates are built into `server.js`):
   ```bash
   npm start
   ```

2. **Guest Interface**: Open `index.html`, select a service, record a message
3. **Department Dashboard**: Open `department_dashboard.html`, login with department credentials
4. **Director Dashboard**: Open `director_dashboard.html`, login with director credentials

### Credentials

Authentication is managed by the backend and Supabase configuration. Create and administer department, director, and hotel admin accounts through your database and do not rely on hardcoded demo credentials.

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

This project does not include hardcoded credentials. Configure authentication through your backend and database instead.

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
└── README.md                  # Project documentation
```

### Adding New Features
1. Update database schema in `schema.sql`
2. Add API endpoints in `server.js`
3. Update frontend interfaces accordingly

### Security Notes
- Passwords should be stored as hashes and never kept in plain text
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