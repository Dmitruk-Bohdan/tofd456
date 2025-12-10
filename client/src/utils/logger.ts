/**
 * Утилита для структурированного логирования в клиенте.
 */

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: any;
  error?: Error;
}

function formatLog(entry: LogEntry): string {
  const { timestamp, level, context, message, data, error } = entry;
  let log = `[${timestamp}] [${level}] [${context}] ${message}`;
  
  if (data !== undefined) {
    log += `\n  Data: ${JSON.stringify(data, null, 2)}`;
  }
  
  if (error) {
    log += `\n  Error: ${error.message}`;
    if (error.stack) {
      log += `\n  Stack: ${error.stack}`;
    }
  }
  
  return log;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: LogLevel, message: string, data?: any, error?: Error): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      data,
      error,
    };

    const formatted = formatLog(entry);
    
    switch (level) {
      case "DEBUG":
        console.debug(formatted);
        break;
      case "INFO":
        console.info(formatted);
        break;
      case "WARN":
        console.warn(formatted);
        break;
      case "ERROR":
        console.error(formatted);
        break;
    }
  }

  debug(message: string, data?: any): void {
    this.log("DEBUG", message, data);
  }

  info(message: string, data?: any): void {
    this.log("INFO", message, data);
  }

  warn(message: string, data?: any): void {
    this.log("WARN", message, data);
  }

  error(message: string, error?: Error, data?: any): void {
    this.log("ERROR", message, data, error);
  }
}

