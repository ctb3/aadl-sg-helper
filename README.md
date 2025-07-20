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

1. **Deploy Backend** to Railway/Render/Railway:
   - Upload `backend/` folder
   - Set environment variables if needed
   - Update `frontend/src/config.ts` with your backend URL

2. **Deploy Frontend** to Vercel/Netlify:
   - Upload `frontend/` folder
   - Build command: `npm run build`
   - Output directory: `dist`

## Technologies

- **Frontend**: React, TypeScript, Vite, Scribe.js OCR, React Easy Crop
- **Backend**: Express.js, Playwright (browser automation)

## Configuration

Update `frontend/src/config.ts` to point to your deployed backend URL when going to production.