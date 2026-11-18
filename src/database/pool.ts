import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg';
import { getConfig } from '../config';
import { ServiceUnavailableError } from '../utils/errors';
import { logger } from '../utils/logger';

// BIGINT (int8) comes back as a string by default; our values (sizes, ids) fit safely in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/**
 * One small pool per Lambda container, created lazily and reused across warm invocations.
 * Lambda runs one request per container at a time, so a limit of 1–2 connections is enough
 * and keeps the total connection count bounded by concurrency.
 */
let pool: Pool | undefined;

function sslOption(db: ReturnType<typeof getConfig>['db']): PoolConfig['ssl'] {
  switch (db.sslMode) {
    case 'disable':
      return false;
    case 'require':
      // Encrypted, certificate not verified (same meaning as libpq sslmode=require).
      return { rejectUnauthorized: false };
    case 'verify-full':
      // Encrypted and verified; for Aiven pass its CA certificate via DB_SSL_CA.
      return { rejectUnauthorized: true, ca: db.sslCa };
  }
}

export function getPool(): Pool {
  if (!pool) {
    const { db } = getConfig();
    pool = new pg.Pool({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      ssl: sslOption(db),
      max: db.connectionLimit,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    // An idle client can error (e.g. server restart); without a listener this would crash the process.
    pool.on('error', (err) => logger.warn('Idle database client error', { err }));
  }
  return pool;
}

/** Anything that can run a query: the pool or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

type Params = (string | number | boolean | Date | null)[];

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  '3D000', // invalid_catalog_name (database does not exist)
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001',
  '08003',
  '08006',
]);

// node-postgres raises these without a code.
const CONNECTION_ERROR_MESSAGES = ['timeout exceeded when trying to connect', 'Connection terminated', 'Cannot use a pool after calling end'];

/** Maps connectivity failures to a 503; everything else bubbles up as an unexpected error. */
function translateDbError(err: unknown): never {
  const { code, message } = err as { code?: string; message?: string };
  if ((code && CONNECTION_ERROR_CODES.has(code)) || CONNECTION_ERROR_MESSAGES.some((m) => message?.includes(m))) {
    logger.error('Database unavailable', { err, dbErrorCode: code });
    throw new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again.');
  }
  throw err;
}

export async function queryRows<T>(db: Queryable, sql: string, params: Params = []): Promise<T[]> {
  try {
    const result = await db.query(sql, params);
    return result.rows as T[];
  } catch (err) {
    translateDbError(err);
  }
}

export async function queryOne<T>(db: Queryable, sql: string, params: Params = []): Promise<T | undefined> {
  const rows = await queryRows<T>(db, sql, params);
  return rows[0];
}

/** Runs a write; `rowCount` is the number of rows inserted/updated/deleted. */
export async function execute(db: Queryable, sql: string, params: Params = []): Promise<{ rowCount: number }> {
  try {
    const result = await db.query(sql, params);
    return { rowCount: result.rowCount ?? 0 };
  } catch (err) {
    translateDbError(err);
  }
}

/** Runs fn inside a transaction; commits on success, rolls back on error, always releases the connection. */
export async function withTransaction<T>(fn: (conn: PoolClient) => Promise<T>): Promise<T> {
  let conn: PoolClient;
  try {
    conn = await getPool().connect();
  } catch (err) {
    translateDbError(err);
  }
  let discard: Error | undefined;
  try {
    await conn.query('BEGIN');
    const result = await fn(conn);
    await conn.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await conn.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.warn('Transaction rollback failed', { err: rollbackErr });
      discard = rollbackErr as Error; // do not reuse a connection in an unknown state
    }
    throw err;
  } finally {
    conn.release(discard);
  }
}

/** PostgreSQL SQLSTATE 23505 = unique_violation. */
export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

/** Test helper. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
