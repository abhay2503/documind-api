import { z } from 'zod';
import { validate, withHttp } from '../middleware/httpHandler';
import { completeUpload } from '../services/uploadService';
import { getAuthenticatedUserId } from '../utils/auth';
import { isDocumentId } from '../utils/ids';

const paramsSchema = z.object({
  documentId: z.string().refine(isDocumentId, 'invalid document id'),
});

/** POST /documents/{documentId}/complete — verifies the S3 object and marks the document uploaded. No SQS publish. */
export const handler = withHttp(async ({ event, log }) => {
  const userId = getAuthenticatedUserId(event);
  const { documentId } = validate(paramsSchema, event.pathParameters);
  return { statusCode: 200, body: await completeUpload(documentId, userId, log) };
});
