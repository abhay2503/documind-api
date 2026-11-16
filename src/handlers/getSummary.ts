import { z } from 'zod';
import { validate, withHttp } from '../middleware/httpHandler';
import { getSummaryJob } from '../services/summaryService';
import { isJobId } from '../utils/ids';

const paramsSchema = z.object({
  jobId: z.string().refine(isJobId, 'invalid job id'),
});

/** GET /summaries/{jobId} — latest status (and result when done) as written by the Python worker. */
export const handler = withHttp(async ({ event, log }) => {
  const { jobId } = validate(paramsSchema, event.pathParameters);
  return { statusCode: 200, body: await getSummaryJob(jobId, log) };
});
