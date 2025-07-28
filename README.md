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
   npm run dev
   ```
   Backend will run on http://localhost:8081

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

## Production Deployment

**Current Production URLs:**
- **Frontend**: https://aadl.ctb3.net
- **Backend API**: https://aadl-api.ctb3.net

**Deployment Platforms:**
- **Frontend**: AWS Amplify (auto-deploys on push to main)
- **Backend**: AWS Elastic Beanstalk (auto-deploys on push to main)

**Deployment Process:**
- Frontend and backend automatically deploy when you push to the `main` branch
- GitHub Actions handles backend deployment to Elastic Beanstalk
- Amplify handles frontend deployment

## Technologies

- **Frontend**: React, TypeScript, Vite, Scribe.js OCR, React Easy Crop
- **Backend**: Express.js, Playwright (browser automation)

## Environment Setup

### Frontend Environment Variables
Create `frontend/.env.local` for local development:
```bash
VITE_API_BASE_URL=http://localhost:8081/api
```

### Backend Environment Variables
Create `backend/.env` for local development:
```bash
PORT=8081
NODE_ENV=development
```

### Production Environment Variables
Set these in your deployment platform:
- **Frontend (Amplify)**: `VITE_API_BASE_URL=https://aadl-api.ctb3.net/api`
- **Backend (Elastic Beanstalk)**: `PORT=8081`, `NODE_ENV=production`


## Development Notes

- The backend uses Playwright for browser automation to interact with the AADL website
- Sessions are persisted between deployments using a local JSON file
- CORS is configured to allow requests from the production frontend domain
- The frontend uses Vite for fast development and optimized builds