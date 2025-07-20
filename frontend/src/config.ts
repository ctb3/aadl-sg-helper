// Configuration for different environments
export const config = {
  // Development - local backend
  development: {
    apiBaseUrl: 'http://localhost:3001/api'
  },
  // Production - deployed backend (update this when you deploy)
  production: {
    apiBaseUrl: 'https://your-backend-url.com/api' //TODO: Update this when you deploy
  }
};

// Get current environment
const isDevelopment = import.meta.env.DEV;

// Export the appropriate config
export const currentConfig = isDevelopment ? config.development : config.production; 