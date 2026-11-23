import { z } from 'zod';
import { validate, withHttp } from '../middleware/httpHandler';
import { createUpload } from '../services/uploadService';
import { getAuthenticatedUserId } from '../utils/auth';

const bodySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(127),
  size: z.number().int().positive(),
});

/** POST /uploads — returns a presigned S3 PUT URL. The document is owned by the JWT `sub`. Does not start processing. */
export const handler = withHttp(async ({ event, body, log }) => {
  const userId = getAuthenticatedUserId(event);
  const input = validate(bodySchema, body);
  return { statusCode: 201, body: await createUpload(input, userId, log) };
});
