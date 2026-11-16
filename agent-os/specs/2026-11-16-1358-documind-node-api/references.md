# References for DocuMind API (Node.js)

## Frontend contract (read-only, separate repo)

- `../ui/src/lib/api/client.ts`:
  - `POST /uploads` body `{fileName, contentType, size}` → `{documentId, key, uploadUrl}`
  - The PUT to S3 sends the same `Content-Type`.
  - `POST /documents/{id}/complete` has no body.
  - `POST /summaries` `{documentId, style}` → `{jobId}`
  - `GET /summaries/{jobId}` → `SummaryJob`
  - Errors are read from `response.data.message`.
- `../ui/src/lib/api/types.ts`: `SummaryStyle`, `JobStatus` (`done`), `ProcessingStage`, `SummaryResult`, `SummaryJob`.

## External docs to verify during implementation
- Serverless Framework v4: built-in esbuild for TypeScript, dotenv / `.env.{stage}` loading, `httpApi.cors`.
- serverless-offline v14 with Serverless v4.
- AWS SDK v3: `@aws-sdk/s3-request-presigner` `getSignedUrl(PutObjectCommand)`, `HeadObjectCommand`, SQS `SendMessageCommand`.
- mysql2/promise: `createPool`, transactions, `enableKeepAlive`.
