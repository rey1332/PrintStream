export interface ConsoleLogEntry {
  timestamp: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'debug';
  message: string;
}

export class RealtimeConsoleLogger {
  private logs: ConsoleLogEntry[] = [];
  private maxLogs = 500;
  private callbacks: ((log: ConsoleLogEntry) => void)[] = [];

  subscribe(callback: (log: ConsoleLogEntry) => void) {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  info(message: string) {
    this.log('info', message);
  }

  success(message: string) {
    this.log('success', message);
  }

  warn(message: string) {
    this.log('warning', message);
  }

  error(message: string) {
    this.log('error', message);
  }

  debug(message: string) {
    if (process.env.NODE_ENV === 'development') {
      this.log('debug', message);
    }
  }

  private log(type: ConsoleLogEntry['type'], message: string) {
    const timestamp = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const entry: ConsoleLogEntry = {
      timestamp,
      type,
      message,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Notify subscribers
    this.callbacks.forEach((cb) => cb(entry));

    // Also log to browser console in dev
    if (process.env.NODE_ENV === 'development') {
      const formatted = `[${type.toUpperCase()}] ${message}`;
      if (type === 'error') console.error(formatted);
      else if (type === 'warning') console.warn(formatted);
      else console.log(formatted);
    }
  }

  getLogs(): ConsoleLogEntry[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
  }
}

// Export singleton instance
export const consoleLogger = new RealtimeConsoleLogger();
