import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { getConfig } from '../config';
import { ServiceUnavailableError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * One small pool per Lambda container, created lazily and reused across warm invocations.
 * Lambda runs one request per container at a time, so a limit of 1–2 connections is enough
 * and keeps the total connection count bounded by concurrency.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const { db } = getConfig();
    pool = mysql.createPool({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      connectionLimit: db.connectionLimit,
      maxIdle: db.connectionLimit,
      idleTimeout: 60_000,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      connectTimeout: 5_000,
      timezone: 'Z',
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
    // Store and read DATETIME values in UTC regardless of the server's time zone.
    pool.on('connection', (conn) => {
      conn.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

/** Anything that can run a query: the pool or a connection inside a transaction. */
export type Queryable = Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>;

type Params = (string | number | boolean | Date | null)[];

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
  'POOL_CLOSED',
]);

/** Maps connectivity failures to a 503; everything else bubbles up as an unexpected error. */
function translateDbError(err: unknown): never {
  const code = (err as { code?: string }).code;
  if (code && CONNECTION_ERROR_CODES.has(code)) {
    logger.error('Database unavailable', { err, dbErrorCode: code });
    throw new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again.');
  }
  throw err;
}

export async function queryRows<T>(db: Queryable, sql: string, params: Params = []): Promise<T[]> {
  try {
    const [rows] = await db.execute<RowDataPacket[]>(sql, params);
    return rows as unknown as T[];
  } catch (err) {
    translateDbError(err);
  }
}

export async function queryOne<T>(db: Queryable, sql: string, params: Params = []): Promise<T | undefined> {
  const rows = await queryRows<T>(db, sql, params);
  return rows[0];
}

export async function execute(db: Queryable, sql: string, params: Params = []): Promise<ResultSetHeader> {
  try {
    const [result] = await db.execute<ResultSetHeader>(sql, params);
    return result;
  } catch (err) {
    translateDbError(err);
  }
}

/** Runs fn inside a transaction; commits on success, rolls back on error, always releases the connection. */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  let conn: PoolConnection;
  try {
    conn = await getPool().getConnection();
  } catch (err) {
    translateDbError(err);
  }
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      logger.warn('Transaction rollback failed', { err: rollbackErr });
    }
    throw err;
  } finally {
    conn.release();
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: string }).code === 'ER_DUP_ENTRY';
}

/** Test helper. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
