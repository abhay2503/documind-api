# Standards for DocuMind API (Node.js)

No agent-os standards are indexed. These are the working standards for this repo.

## api/contract
- Response bodies match `../ui/src/lib/api/types.ts` exactly, with no envelope.
- Error body: `{ "message": "<user-safe text>", "code": "UPPER_SNAKE_CODE" }`.
- Status codes:
  - 200 OK, 201 created (upload URL), 202 accepted (summary job)
  - 400 validation, 404 not found, 409 conflict, 413 file too large
  - 500 unexpected, 503 dependency unavailable
- Never expose stack traces, SQL, AWS error details or secrets.

## api/layering
- `handlers/` are thin: parse and validate, call a service, return.
- `services/` hold business logic and AWS integrations.
- `repositories/` hold all SQL. Every query is parameterized.
- `config/` is the only place that reads `process.env`.

## data/vocabulary
- The DB uses `queued|processing|completed|failed` and `concise|detailed|bullet_points|key_insights`. The Python worker relies on these values.
- API ↔ DB translation happens only in `src/utils/contract.ts`.

## security
- The bucket is private. Presigned PUT URLs last 900s and sign the content type.
- Never trust client S3 keys. Verify the object with HeadObject before marking it uploaded.
- Use Lambda IAM roles, never access keys. No credentials in code or Git (`.env*` is gitignored except `.env.example`).
- Never log document content, presigned URLs or credentials.

## process
- No SQS publish on upload or completion. Only `POST /summaries` publishes.
- No AWS resource creation or deploy without explicit approval. Use the `document-ai` profile only.
