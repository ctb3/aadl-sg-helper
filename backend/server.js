import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Store sessions in memory (in production, use a proper database)
const sessions = new Map();

// Session storage file
const SESSION_FILE = join(__dirname, 'sessions.json');

// Load sessions from file
function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      const parsed = JSON.parse(data);
      sessions.clear();
      for (const [key, value] of Object.entries(parsed)) {
        sessions.set(key, value);
      }
      console.log(`Loaded ${sessions.size} sessions from file`);
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
  }
}

// Save sessions to file
function saveSessions() {
  try {
    const data = JSON.stringify(Object.fromEntries(sessions));
    fs.writeFileSync(SESSION_FILE, data);
  } catch (error) {
    console.error('Error saving sessions:', error);
  }
}

// Load sessions on startup
loadSessions();

// AADL Service class
class AADLService {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async initialize(debugMode = false) {
    try {
      this.browser = await chromium.launch({
        headless: !debugMode,
        slowMo: debugMode ? 1000 : 0,
      });

      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      this.page = await this.context.newPage();
      console.log('AADL Service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize AADL Service:', error);
      throw error;
    }
  }

  async login(username, password) {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }

    try {
      console.log('Attempting to login to AADL...');
      
      await this.page.goto('https://aadl.org/user/login');
      await this.page.waitForSelector('input[name="name"]', { timeout: 10000 });
      
      await this.page.fill('input[name="name"]', username);
      await this.page.fill('input[name="pass"]', password);
      await this.page.click('input[type="submit"]');
      
      await this.page.waitForLoadState('networkidle');
      
      const currentUrl = this.page.url();
      //TODO: fix login failure checking logic
      const isLoggedIn = !currentUrl.includes('/user/login');
      
      if (isLoggedIn) {
        console.log('Login successful!');
        return true;
      } else {
        console.log('Login failed - still on login page');
        return false;
      }
    } catch (error) {
      console.error('Login error:', error);
      return false;
    }
  }

  async submitCode(code) {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }

    try {
      console.log(`Submitting code: ${code}`);
      
      await this.page.goto('https://aadl.org/summergame/player/0/gamecode');
      
      // Wait for the form to load
      await this.page.waitForSelector('input[id="edit-code-text"]', { timeout: 10000 });
      
      // Fill in the code
      await this.page.fill('input[id="edit-code-text"]', code);
      
      // Ensure the first player checkbox is checked (usually the main user)
      await this.page.evaluate(() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length > 0) {
            for (const checkbox of checkboxes) {
                checkbox.checked = true;
            }
        }
      });
      
      // Try multiple approaches to click the submit button
      try {
        // First, try the specific selector from the error log
        await this.page.click('input[id="edit-submit"][type="submit"]');
      } catch (error) {
        console.log('Specific selector failed, trying alternative approaches...');
        
        // Try clicking by text content TODO: delete?
        await this.page.click('input[value="Submit"]');
      }
      
      await this.page.waitForLoadState('networkidle');
      
      const result = await this.checkSubmissionResult();
      
      if (result.success) {
        console.log('Code submitted successfully!');
        return { success: true, messages: result.messages };
      } else {
        console.log('Code submission failed or already submitted');
        return { success: false, messages: result.messages };
      }
    } catch (error) {
      console.error('Code submission error:', error);
      return false;
    }
  }

  async saveSession(sessionId) {
    if (!this.context) return;

    try {
      const cookies = await this.context.cookies();
      const localStorage = await this.page?.evaluate(() => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            data[key] = localStorage.getItem(key);
          }
        }
        return data;
      });

      const session = {
        cookies,
        localStorage: localStorage || {},
        timestamp: Date.now()
      };

      sessions.set(sessionId, session);
      saveSessions();
      console.log('Session saved');
    } catch (error) {
      console.error('Failed to save session:', error);
    }
  }

  async loadSession(sessionId) {
    try {
      const session = sessions.get(sessionId);
      if (!session) return false;

      // Check if session is still valid (24 hours)
      if (Date.now() - session.timestamp > 24 * 60 * 60 * 1000) {
        console.log('Session expired, removing...');
        sessions.delete(sessionId);
        saveSessions();
        return false;
      }

      // Restore cookies
      if (this.context && session.cookies.length > 0) {
        await this.context.addCookies(session.cookies);
      }

      // Restore localStorage
      if (this.page && session.localStorage) {
        await this.page.evaluate((data) => {
          for (const [key, value] of Object.entries(data)) {
            localStorage.setItem(key, value);
          }
        }, session.localStorage);
      }

      console.log('Session restored');
      return true;
    } catch (error) {
      console.error('Failed to load session:', error);
      return false;
    }
  }

  async checkSubmissionResult() {
    if (!this.page) return { success: false, messages: [] };

    try {
      // Extract all messages from the messages wrapper
      const messages = await this.page.evaluate(() => {
        const messageElements = document.querySelectorAll('.messages__wrapper .messages');
        const extractedMessages = [];
        
        messageElements.forEach(element => {
          const text = element.textContent?.trim();
          const type = element.className.includes('messages--error') ? 'error' :
                      element.className.includes('messages--warning') ? 'warning' :
                      element.className.includes('messages--status') ? 'success' : 'info';
          
          if (text) {
            extractedMessages.push({ text, type });
          }
        });
        
        return extractedMessages;
      });

      // Determine overall success based on message types
      const hasSuccess = messages.some(msg => msg.type === 'success');
      const hasError = messages.some(msg => msg.type === 'error');
      const hasWarning = messages.some(msg => msg.type === 'warning');

      // If there's at least one success message, consider it successful
      // (even if there are also error messages for other players)
      const overallSuccess = hasSuccess;

      return {
        success: overallSuccess,
        messages: messages
      };
    } catch (error) {
      console.error('Error checking submission result:', error);
      return { success: false, messages: [] };
    }
  }

  async cleanup() {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      console.log('AADL Service cleaned up');
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
}

// API Routes

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password, sessionId, debugMode = false } = req.body;

  if (!username || !password || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const aadlService = new AADLService();
    await aadlService.initialize(debugMode);
    
    const success = await aadlService.login(username, password);
    
    if (success) {
      await aadlService.saveSession(sessionId);
      await aadlService.cleanup();
      res.json({ success: true, message: 'Login successful' });
    } else {
      await aadlService.cleanup();
      res.status(401).json({ success: false, message: 'Login failed' });
    }
  } catch (error) {
    console.error('Login API error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Submit code endpoint
app.post('/api/submit-code', async (req, res) => {
  const { code, sessionId, debugMode = false } = req.body;

  if (!code || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const aadlService = new AADLService();
    await aadlService.initialize(debugMode);
    
    // Try to load existing session
    const sessionLoaded = await aadlService.loadSession(sessionId);
    
    if (!sessionLoaded) {
      await aadlService.cleanup();
      return res.status(401).json({ success: false, message: 'Session expired or invalid' });
    }
    
    const result = await aadlService.submitCode(code);
    await aadlService.cleanup();
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Code submitted successfully',
        messages: result.messages 
      });
    } else {
      res.json({ 
        success: false, 
        message: 'Code submission failed or already submitted',
        messages: result.messages 
      });
    }
  } catch (error) {
    console.error('Submit code API error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  const { sessionId } = req.body;

  if (sessionId) {
    sessions.delete(sessionId);
    saveSessions();
  }

  res.json({ success: true, message: 'Logged out successfully' });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
}); 