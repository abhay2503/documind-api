import { execute, queryOne, type Queryable } from '../database/pool';
import type { DbSummaryStyle, SummaryJobRow, SummaryJobWithDocumentRow } from '../types/db';

const JOB_COLUMNS = `j.job_id, j.document_id, j.status, j.stage, j.summary_style, j.instructions, j.result,
  j.error_code, j.error_message, j.publish_attempts, j.published_at, j.created_at, j.completed_at`;

export interface NewSummaryJob {
  jobId: string;
  documentId: string;
  style: DbSummaryStyle;
  instructions: string | null;
  instructionsHash: string | null;
  idempotencyKey: string | null;
}

/** Inserts a queued job. publish_attempts starts at 1: the API publishes immediately after commit. */
export async function insertQueuedJob(db: Queryable, job: NewSummaryJob): Promise<void> {
  await execute(
    db,
    `INSERT INTO summary_jobs
       (job_id, document_id, status, summary_style, instructions, instructions_hash, idempotency_key, publish_attempts)
     VALUES ($1, $2, 'queued', $3, $4, $5, $6, 1)`,
    [job.jobId, job.documentId, job.style, job.instructions, job.instructionsHash, job.idempotencyKey],
  );
}

export async function findJobByIdempotencyKey(
  db: Queryable,
  documentId: string,
  idempotencyKey: string,
): Promise<SummaryJobRow | undefined> {
  return queryOne<SummaryJobRow>(
    db,
    `SELECT ${JOB_COLUMNS} FROM summary_jobs j WHERE j.document_id = $1 AND j.idempotency_key = $2`,
    [documentId, idempotencyKey],
  );
}

/** Latest queued/processing job for the same document + style + instructions (double-click protection). */
export async function findActiveDuplicateJob(
  db: Queryable,
  documentId: string,
  style: DbSummaryStyle,
  instructionsHash: string | null,
): Promise<SummaryJobRow | undefined> {
  return queryOne<SummaryJobRow>(
    db,
    `SELECT ${JOB_COLUMNS} FROM summary_jobs j
     WHERE j.document_id = $1 AND j.summary_style = $2 AND j.instructions_hash IS NOT DISTINCT FROM $3
       AND j.status IN ('queued', 'processing')
     ORDER BY j.created_at DESC LIMIT 1`,
    [documentId, style, instructionsHash],
  );
}

export async function findJobWithDocument(
  db: Queryable,
  jobId: string,
  opts: { userId?: string | null } = {},
): Promise<SummaryJobWithDocumentRow | undefined> {
  const params: (string | null)[] = [jobId];
  let sql = `SELECT ${JOB_COLUMNS}, d.file_name, d.user_id
     FROM summary_jobs j JOIN documents d ON d.document_id = j.document_id
     WHERE j.job_id = $1`;
  if (opts.userId !== undefined) {
    sql += ' AND d.user_id IS NOT DISTINCT FROM $2';
    params.push(opts.userId);
  }
  return queryOne<SummaryJobWithDocumentRow>(db, sql, params);
}

export async function markJobPublished(db: Queryable, jobId: string): Promise<void> {
  await execute(
    db,
    'UPDATE summary_jobs SET published_at = CURRENT_TIMESTAMP(3) WHERE job_id = $1 AND published_at IS NULL',
    [jobId],
  );
}

/** Fails a job that never reached the queue. Only applies while it is still queued and unpublished. */
export async function markJobPublishFailed(db: Queryable, jobId: string): Promise<boolean> {
  const result = await execute(
    db,
    `UPDATE summary_jobs
     SET status = 'failed', error_code = 'QUEUE_PUBLISH_FAILED',
         error_message = 'Could not queue the job for processing.', completed_at = CURRENT_TIMESTAMP(3)
     WHERE job_id = $1 AND status = 'queued' AND published_at IS NULL`,
    [jobId],
  );
  return result.rowCount === 1;
}

/**
 * Atomically claims a recovery republish for a job stuck as queued-but-unpublished.
 * The compare-and-set on publish_attempts ensures concurrent pollers republish at most once per attempt.
 */
export async function claimRepublish(
  db: Queryable,
  jobId: string,
  expectedAttempts: number,
  staleAfterSeconds: number,
): Promise<boolean> {
  const result = await execute(
    db,
    `UPDATE summary_jobs SET publish_attempts = publish_attempts + 1
     WHERE job_id = $1 AND status = 'queued' AND published_at IS NULL AND publish_attempts = $2
       AND updated_at < CURRENT_TIMESTAMP(3) - make_interval(secs => $3)`,
    [jobId, expectedAttempts, staleAfterSeconds],
  );
  return result.rowCount === 1;
}
