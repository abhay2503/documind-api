import { createHash } from 'node:crypto';
import { getPool, isDuplicateKeyError, withTransaction } from '../database/pool';
import { findDocument } from '../repositories/documentRepository';
import {
  claimRepublish,
  findActiveDuplicateJob,
  findJobByIdempotencyKey,
  findJobWithDocument,
  insertQueuedJob,
  markJobPublished,
  markJobPublishFailed,
} from '../repositories/summaryJobRepository';
import type { ApiSummaryStyle, CreateSummaryResponse, SummaryJob } from '../types/api';
import type { SummaryJobRow, SummaryJobWithDocumentRow } from '../types/db';
import { toApiStatus, toApiSummaryJob, toDbStyle } from '../utils/contract';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../utils/errors';
import { newJobId } from '../utils/ids';
import type { Logger } from '../utils/logger';
import { publishSummaryJob } from './sqsService';

/** A queued job with no confirmed publish is considered stuck after this long. */
export const REPUBLISH_STALE_SECONDS = 60;
/** Total publish attempts (1 inline + recoveries) before the job is failed. */
export const MAX_PUBLISH_ATTEMPTS = 3;

export interface CreateSummaryInput {
  documentId: string;
  style: ApiSummaryStyle;
  instructions?: string;
  idempotencyKey?: string;
  /** Authenticated Cognito `sub`; the document must belong to this user. */
  userId: string;
}

const hashInstructions = (instructions: string | null) =>
  instructions ? createHash('sha256').update(instructions).digest('hex') : null;

const toResponse = (job: Pick<SummaryJobRow, 'job_id' | 'document_id' | 'status'>): CreateSummaryResponse => ({
  jobId: job.job_id,
  documentId: job.document_id,
  status: toApiStatus(job.status),
});

/**
 * Creates a summary job and publishes it to SQS. The DB row is committed before publishing;
 * if publishing fails the job is marked failed so it never stays queued forever.
 * Never processes the document or calls an LLM.
 */
export async function createSummaryJob(input: CreateSummaryInput, log: Logger): Promise<CreateSummaryResponse> {
  const style = toDbStyle(input.style);
  const instructions = input.instructions?.trim() || null;
  const instructionsHash = hashInstructions(instructions);
  const idempotencyKey = input.idempotencyKey ?? null;

  let outcome: { kind: 'existing'; job: SummaryJobRow } | { kind: 'created'; jobId: string };
  try {
    outcome = await withTransaction(async (conn) => {
      // Locking the document row serialises concurrent requests for the same document,
      // which makes the duplicate checks below race-free. The userId filter enforces ownership:
      // another user's document is indistinguishable from a missing one, and nothing is queued.
      const doc = await findDocument(conn, input.documentId, { userId: input.userId, forUpdate: true });
      if (!doc) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'The requested document was not found.');
      if (doc.status !== 'uploaded') {
        throw new ConflictError('DOCUMENT_NOT_UPLOADED', 'The document upload has not been completed yet.');
      }

      if (idempotencyKey) {
        const existing = await findJobByIdempotencyKey(conn, input.documentId, idempotencyKey);
        if (existing) return { kind: 'existing' as const, job: existing };
      }
      const active = await findActiveDuplicateJob(conn, input.documentId, style, instructionsHash);
      if (active) return { kind: 'existing' as const, job: active };

      const jobId = newJobId();
      await insertQueuedJob(conn, {
        jobId,
        documentId: input.documentId,
        style,
        instructions,
        instructionsHash,
        idempotencyKey,
      });
      return { kind: 'created' as const, jobId };
    });
  } catch (err) {
    // Two requests with the same Idempotency-Key raced past the lookup: return the winner.
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findJobByIdempotencyKey(getPool(), input.documentId, idempotencyKey);
      if (existing) return toResponse(existing);
    }
    throw err;
  }

  if (outcome.kind === 'existing') {
    log.info('Returning existing summary job', { jobId: outcome.job.job_id, documentId: input.documentId });
    return toResponse(outcome.job);
  }

  const { jobId } = outcome;
  try {
    await publishSummaryJob({ jobId, documentId: input.documentId });
  } catch (err) {
    log.error('Failed to publish summary job', { err, jobId });
    await markJobPublishFailed(getPool(), jobId);
    throw new ServiceUnavailableError('QUEUE_UNAVAILABLE', 'We could not start processing right now. Please try again.');
  }

  try {
    await markJobPublished(getPool(), jobId);
  } catch (err) {
    // The message is already on the queue; recovery may republish later, which the worker tolerates.
    log.warn('Published job but could not record published_at', { err, jobId });
  }

  log.info('Summary job queued', { jobId, documentId: input.documentId, style });
  return { jobId, documentId: input.documentId, status: 'queued' };
}

/**
 * Returns the job for the frontend, opportunistically recovering jobs that never reached the queue.
 * Only jobs whose document belongs to `userId` are visible; any other job is a 404, checked before recovery.
 */
export async function getSummaryJob(jobId: string, userId: string, log: Logger): Promise<SummaryJob> {
  const row = await findJobWithDocument(getPool(), jobId, { userId });
  if (!row) throw new NotFoundError('JOB_NOT_FOUND', 'The requested summary job was not found.');

  if (row.status === 'queued' && !row.published_at) {
    const recovered = await recoverUnpublishedJob(row, log);
    if (recovered) return toApiSummaryJob(recovered, log);
  }
  return toApiSummaryJob(row, log);
}

/**
 * Lazy recovery for a job committed to the database whose SQS publish was never confirmed
 * (e.g. the Lambda crashed between commit and publish). Driven by the frontend's polling,
 * so no scheduler or extra infrastructure is needed. Best-effort: errors are logged, not thrown.
 */
async function recoverUnpublishedJob(
  row: SummaryJobWithDocumentRow,
  log: Logger,
): Promise<SummaryJobWithDocumentRow | undefined> {
  const pool = getPool();
  try {
    if (row.publish_attempts >= MAX_PUBLISH_ATTEMPTS) {
      const ageSeconds = (Date.now() - row.created_at.getTime()) / 1000;
      if (ageSeconds < REPUBLISH_STALE_SECONDS) return undefined;
      if (await markJobPublishFailed(pool, row.job_id)) {
        log.error('Summary job failed after exhausting publish attempts', { jobId: row.job_id });
        return findJobWithDocument(pool, row.job_id);
      }
      return undefined;
    }

    const claimed = await claimRepublish(pool, row.job_id, row.publish_attempts, REPUBLISH_STALE_SECONDS);
    if (!claimed) return undefined;

    log.warn('Republishing unconfirmed summary job', { jobId: row.job_id, attempt: row.publish_attempts + 1 });
    await publishSummaryJob({ jobId: row.job_id, documentId: row.document_id });
    await markJobPublished(pool, row.job_id);
    return undefined;
  } catch (err) {
    log.error('Recovery republish failed', { err, jobId: row.job_id });
    return undefined;
  }
}
