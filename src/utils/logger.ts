/** Minimal structured JSON logger (CloudWatch-friendly). Never pass document content, presigned URLs or secrets. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const withCode = err as Error & { code?: unknown; $metadata?: { httpStatusCode?: number } };
    return {
      name: err.name,
      message: err.message,
      code: withCode.code,
      httpStatusCode: withCode.$metadata?.httpStatusCode,
      stack: err.stack,
    };
  }
  return { value: String(err) };
}

export function createLogger(base: Record<string, unknown> = {}, minLevel: Level = envLevel()): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    const entry: Record<string, unknown> = { level, msg, time: new Date().toISOString(), ...base, ...fields };
    if (entry.err !== undefined) entry.err = serializeError(entry.err);
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }, minLevel),
  };
}

function envLevel(): Level {
  const value = process.env.LOG_LEVEL;
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
}

export const logger = createLogger({ service: 'documind-api' });
