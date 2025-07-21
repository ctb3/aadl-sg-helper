# AADL Summer Game OCR Helper

A React-based MVP that can take photos of handwritten contest entry codes, extract the handwritten text using OCR, and automatically submit the extracted codes to the Ann Arbor District Library (AADL) website.

## Project Structure

This project is separated into frontend and backend for better deployment and development:

```
aadl-sg-helper/
├── frontend/           # React app with OCR and UI
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── backend/            # Express server with Playwright automation
│   ├── server.js
│   ├── package.json
│   └── sessions.json
└── README.md
```

## Quick Start

### Development (Local)

1. **Start the Backend:**
   ```bash
   cd backend
   npm install
   npm run server
   ```
   Backend will run on http://localhost:3001

2. **Start the Frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Frontend will run on http://localhost:5173

### Available Scripts

**Backend:**
- `npm run server` - Start the server directly
- `npm run dev` - Start with nodemon (auto-restart on changes)
- `npm start` - Production start (for deployment platforms)

**Frontend:**
- `npm run dev` - Vite development server
- `npm run build` - Build for production
- `npm run preview` - Preview the built app

### Production Deployment TODO

**AWS Deployment Setup:**

1. **Frontend (AWS Amplify):**
   - Domain: `aadl.ctb3.net`
   - Build command: `cd frontend && npm run build`
   - Output directory: `frontend/dist`
   - Configuration: `amplify.yml`

2. **Backend (AWS ECS):**
   - Domain: `api.aadl.ctb3.net`
   - Container: Node.js with Playwright
   - Dockerfile: `backend/Dockerfile`
   - Port: 3001

3. **SSL Certificates:**
   - Automatic with AWS Certificate Manager
   - Covers both subdomains

**Quick Deploy:**
```bash
./deploy.sh
```

## Technologies

- **Frontend**: React, TypeScript, Vite, Scribe.js OCR, React Easy Crop
- **Backend**: Express.js, Playwright (browser automation)

## Environment Setup

### Frontend Environment Variables
 `frontend/.env.local` for local development:
```bash
VITE_API_BASE_URL=http://localhost:3001/api
```

### Backend Environment Variables
 `backend/.env` for local development:
```bash
PORT=3001
NODE_ENV=development
```

### Production Environment Variables
Set these in your deployment platform:
- **Frontend (Amplify)**: `VITE_API_BASE_URL=https://api.aadl.ctb3.net/api`
- **Backend (ECS)**: `PORT=3001`, `NODE_ENV=production`