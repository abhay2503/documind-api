import { z } from 'zod';
import type { ApiJobStatus, ApiSummaryStyle, ProcessingStage, SummaryJob, SummaryResult } from '../types/api';
import type { DbSummaryStyle, JobStatus, SummaryJobWithDocumentRow } from '../types/db';
import type { Logger } from './logger';

/** The single place where frontend vocabulary and DB/worker vocabulary are translated. */
const apiToDbStyle: Record<ApiSummaryStyle, DbSummaryStyle> = {
  concise: 'concise',
  detailed: 'detailed',
  bullets: 'bullet_points',
  insights: 'key_insights',
};

const dbToApiStyle: Record<DbSummaryStyle, ApiSummaryStyle> = {
  concise: 'concise',
  detailed: 'detailed',
  bullet_points: 'bullets',
  key_insights: 'insights',
};

const dbToApiStatus: Record<JobStatus, ApiJobStatus> = {
  queued: 'queued',
  processing: 'processing',
  completed: 'done',
  failed: 'failed',
};

const STAGES: readonly ProcessingStage[] = [
  'preparing',
  'extracting',
  'structuring',
  'analyzing',
  'generating',
  'finalizing',
];

export const API_SUMMARY_STYLES = Object.keys(apiToDbStyle) as [ApiSummaryStyle, ...ApiSummaryStyle[]];

export const toDbStyle = (style: ApiSummaryStyle): DbSummaryStyle => apiToDbStyle[style];
export const toApiStyle = (style: DbSummaryStyle): ApiSummaryStyle => dbToApiStyle[style];
export const toApiStatus = (status: JobStatus): ApiJobStatus => dbToApiStatus[status];

/** Result JSON written by the Python worker (worker-contract.md). Validated before returning to clients. */
const workerResultSchema = z.object({
  overview: z.string(),
  keyPoints: z.array(z.string()).default([]),
  findings: z.array(z.object({ title: z.string(), detail: z.string() })).default([]),
  actionItems: z.array(z.string()).default([]),
});

const GENERIC_FAILURE = 'We could not generate a summary for this document. Please try again.';
const ERROR_MESSAGES: Record<string, string> = {
  QUEUE_PUBLISH_FAILED: 'We could not start processing your document. Please try again.',
  INVALID_RESULT: GENERIC_FAILURE,
};

function failureMessage(row: SummaryJobWithDocumentRow): string {
  if (row.error_code && ERROR_MESSAGES[row.error_code]) return ERROR_MESSAGES[row.error_code]!;
  // error_message is defined as user-safe by the worker contract; cap length defensively.
  return row.error_message?.slice(0, 300) || GENERIC_FAILURE;
}

/** Builds the frontend SummaryJob from a DB row. */
export function toApiSummaryJob(row: SummaryJobWithDocumentRow, log?: Logger): SummaryJob {
  const job: SummaryJob = {
    jobId: row.job_id,
    documentId: row.document_id,
    status: toApiStatus(row.status),
  };

  if (row.status === 'processing' && row.stage && (STAGES as readonly string[]).includes(row.stage)) {
    job.stage = row.stage as ProcessingStage;
  }

  if (row.status === 'failed') {
    job.error = failureMessage(row);
  }

  if (row.status === 'completed') {
    const raw = typeof row.result === 'string' ? safeJsonParse(row.result) : row.result;
    const parsed = workerResultSchema.safeParse(raw);
    if (!parsed.success) {
      // A completed job with an unusable result is reported as failed rather than crashing the client.
      log?.error('Completed job has an invalid result payload', { jobId: row.job_id });
      return { ...job, status: 'failed', error: GENERIC_FAILURE };
    }
    const result: SummaryResult = {
      documentName: row.file_name,
      style: toApiStyle(row.summary_style),
      ...parsed.data,
      generatedAt: (row.completed_at ?? row.created_at).toISOString(),
    };
    job.result = result;
  }

  return job;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
