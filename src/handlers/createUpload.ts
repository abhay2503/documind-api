import { z } from 'zod';
import { validate, withHttp } from '../middleware/httpHandler';
import { createUpload } from '../services/uploadService';

const bodySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(127),
  size: z.number().int().positive(),
});

/** POST /uploads — returns a presigned S3 PUT URL. Does not start processing. */
export const handler = withHttp(async ({ body, log }) => {
  const input = validate(bodySchema, body);
  return { statusCode: 201, body: await createUpload(input, log) };
});
