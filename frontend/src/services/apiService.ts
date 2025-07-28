import { currentConfig } from '../config';

const API_BASE_URL = currentConfig.apiBaseUrl;

export interface LoginResponse {
  success: boolean;
  message: string;
}

export interface SubmitCodeResponse {
  success: boolean;
  message: string;
  messages?: Array<{
    text: string;
    type: 'success' | 'error' | 'warning' | 'info';
  }>;
}

export class ApiService {
  private sessionId: string;

  constructor() {
    // Generate a unique session ID for this user
    this.sessionId = this.generateSessionId();
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async login(username: string, password: string, debugMode: boolean = false): Promise<LoginResponse> {
    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
          sessionId: this.sessionId,
          debugMode,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Login failed:', response.status, errorText);
        return {
          success: false,
          message: `Login failed: ${response.statusText}`,
        };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Login API error:', error);
      return {
        success: false,
        message: 'Network error. Please check if the server is running.',
      };
    }
  }

  async submitCode(code: string, debugMode: boolean = false): Promise<SubmitCodeResponse> {
    try {
      const response = await fetch(`${API_BASE_URL}/submit-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          sessionId: this.sessionId,
          debugMode,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Submit code failed:', response.status, errorText);
        return {
          success: false,
          message: `Submit failed: ${response.statusText}`,
        };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Submit code API error:', error);
      return {
        success: false,
        message: 'Network error. Please check if the server is running.',
      };
    }
  }

  async logout(): Promise<void> {
    try {
      await fetch(`${API_BASE_URL}/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
        }),
      });
    } catch (error) {
      console.error('Logout API error:', error);
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/health`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

// Export singleton instance
export const apiService = new ApiService(); 