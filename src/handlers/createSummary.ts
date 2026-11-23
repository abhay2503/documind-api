import { z } from 'zod';
import { validate, withHttp } from '../middleware/httpHandler';
import { createSummaryJob } from '../services/summaryService';
import { getAuthenticatedUserId } from '../utils/auth';
import { API_SUMMARY_STYLES } from '../utils/contract';
import { isDocumentId } from '../utils/ids';

const bodySchema = z.object({
  documentId: z.string().refine(isDocumentId, 'invalid document id'),
  style: z.enum(API_SUMMARY_STYLES),
  instructions: z.string().max(2000).optional(),
});

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'invalid characters')
  .optional();

/** POST /summaries — creates a queued job and publishes {jobId, documentId} to SQS. Returns immediately. */
export const handler = withHttp(async ({ event, body, log }) => {
  const userId = getAuthenticatedUserId(event);
  const input = validate(bodySchema, body);
  const idempotencyKey = validate(
    z.object({ key: idempotencyKeySchema }),
    { key: event.headers?.['idempotency-key'] },
  ).key;
  return { statusCode: 202, body: await createSummaryJob({ ...input, idempotencyKey, userId }, log) };
});
