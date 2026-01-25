/**
 * Logging utilities for copy trading bot
 * Handles JSONL file logging, error extraction, and sensitive data redaction
 */

import fs from 'node:fs/promises';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

/**
 * Redact sensitive fields from CLOB error objects
 * Removes API keys, signatures, passphrases, and full request data
 */
export function redactClobError(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactClobError);
  }

  const result: any = {};
  for (const key of Object.keys(obj)) {
    // Skip sensitive fields entirely
    if (key === 'POLY_API_KEY' || 
        key === 'POLY_PASSPHRASE' || 
        key === 'POLY_SIGNATURE' ||
        key === 'signature' ||
        key === 'Authorization' ||
        key === 'data' && typeof obj[key] === 'string' && obj[key].length > 200) { // Skip large request bodies
      result[key] = '[REDACTED]';
    } else if (key === 'headers' && typeof obj[key] === 'object') {
      // Redact sensitive headers
      const headers: any = {};
      for (const headerKey of Object.keys(obj[key])) {
        if (headerKey.startsWith('POLY_') || 
            headerKey === 'Authorization' ||
            headerKey === 'signature') {
          headers[headerKey] = '[REDACTED]';
        } else {
          headers[headerKey] = obj[key][headerKey];
        }
      }
      result[key] = headers;
    } else {
      result[key] = redactClobError(obj[key]);
    }
  }
  return result;
}

/**
 * Extract error details from various error shapes returned by SDK/CLOB
 * Handles: result.error, result.errorMsg, nested error responses, axios errors
 */
export function extractErrorDetails(result: any): {
  errorMsg: string | null;
  errorStatus: number | null;
  errorSource: string | null;
} {
  // Direct errorMsg field
  if (result?.errorMsg) {
    return {
      errorMsg: result.errorMsg,
      errorStatus: result.errorStatus || null,
      errorSource: result.errorSource || null,
    };
  }

  // Axios-style error from CLOB client: result.error.response.data.error
  if (result?.error?.response?.data?.error) {
    return {
      errorMsg: result.error.response.data.error,
      errorStatus: result.error.response?.status || null,
      errorSource: 'clob',
    };
  }

  // Alternative shape: result.error.data.error (as seen in terminal output)
  if (result?.error?.data?.error) {
    return {
      errorMsg: result.error.data.error,
      errorStatus: result.error?.status || null,
      errorSource: 'clob',
    };
  }

  // Generic error.message
  if (result?.error?.message) {
    return {
      errorMsg: result.error.message,
      errorStatus: null,
      errorSource: 'unknown',
    };
  }

  // result.message fallback
  if (result?.message) {
    return {
      errorMsg: result.message,
      errorStatus: null,
      errorSource: 'unknown',
    };
  }

  // No error found
  return {
    errorMsg: null,
    errorStatus: null,
    errorSource: null,
  };
}

export interface JsonlLogger {
  write: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Creates a JSONL file logger with queued writes
 * All writes are queued to prevent concurrent file access issues
 */
export function createJsonlFileLogger(filePath: string): JsonlLogger {
  let queue = Promise.resolve();

  async function ensureDir() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  function write(event: string, data: Record<string, unknown> = {}) {
    queue = queue
      .then(async () => {
        await ensureDir();
        const line = JSON.stringify({ ts: nowIso(), event, ...data }) + '\n';
        await fs.appendFile(filePath, line, 'utf8');
      })
      .catch((e) => {
        // never crash trading because logging failed
        console.error('[FileLog Error]', e?.message || e);
      });
  }

  return { write };
}

/**
 * Setup console.error override to intercept and redact CLOB Client errors
 * This prevents sensitive API keys/signatures from appearing in terminal logs
 * 
 * @param fileLog - JSONL logger to write sanitized errors to
 * @returns Cleanup function to restore original console.error
 */
export function setupConsoleErrorInterceptor(fileLog: JsonlLogger): () => void {
  const originalConsoleError = console.error;
  
  console.error = (...args: any[]) => {
    // Check if this is a CLOB Client error
    if (args[0] === '[CLOB Client] request error') {
      const errorObj = args[1];
      
      // Extract safe error details
      const safeError = {
        status: errorObj?.status || null,
        statusText: errorObj?.statusText || null,
        errorMessage: errorObj?.data?.error || null,
        url: errorObj?.config?.url || null,
        method: errorObj?.config?.method || null,
      };
      
      // Log to file with safe details only
      fileLog.write('clob_error', safeError);
      
      // Print redacted version to terminal
      originalConsoleError('[CLOB Client] request error', redactClobError(errorObj));
    } else {
      // Pass through all other errors unchanged
      originalConsoleError(...args);
    }
  };

  // Return cleanup function
  return () => {
    console.error = originalConsoleError;
  };
}
