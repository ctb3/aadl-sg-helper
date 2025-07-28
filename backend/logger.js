// Production-ready logger for Elastic Beanstalk/CloudWatch
class Logger {
  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development';
  }

  info(message, data = {}) {
    this.log('INFO', message, data);
  }

  error(message, error = null, data = {}) {
    const logData = {
      ...data,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : null
    };
    this.log('ERROR', message, logData);
  }

  warn(message, data = {}) {
    this.log('WARN', message, data);
  }

  debug(message, data = {}) {
    if (this.isDevelopment) {
      this.log('DEBUG', message, data);
    }
  }

  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...data
    };

    // In production, log as JSON for CloudWatch
    if (!this.isDevelopment) {
      console.log(JSON.stringify(logEntry));
    } else {
      // In development, use readable format
      console.log(`[${level}] ${message}`);
      if (Object.keys(data).length > 0) {
        console.log('   Data:', data);
      }
    }
  }
}

export const logger = new Logger(); 