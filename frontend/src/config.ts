// Configuration using environment variables
export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8081/api'
};

// Export the config directly
export const currentConfig = config; 