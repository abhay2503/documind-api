# DocuMind API (Node.js + TypeScript): Implementation Plan

## Context

The architecture is now split into two projects:
- **`api/`** (this repo) is a Node.js + TypeScript Serverless API. It handles uploads, MySQL, job creation and SQS publishing.
- **`../ai`** (a separate project) is the Python AI worker. It consumes SQS, runs Docling/LLM, and writes status and results to MySQL.

The earlier shaped spec in `agent-os/specs/2026-11-14-1535-documind-backend-api/` described an all-Python backend. Its AI/processing parts (Docling, HybridChunker, Bedrock/Groq, map-reduce) now belong to the Python project. Its API parts are replaced by this plan. The goal is a lightweight, independently deployable API whose contract matches the existing frontend in `../ui`.

### Findings
- `api/` holds `agent-os/`, plus leftovers from the interrupted Python start: `.venv/` and a Serverless-only `package.json`/`node_modules`. Those leftovers will be removed or replaced.
- The frontend contract (`../ui/src/lib/api/client.ts`, `types.ts`; read-only, never modified):
  - `POST /uploads` body `{fileName, contentType, size}` → reads `{documentId, key, uploadUrl}` directly, with no envelope.
  - The PUT to S3 sends a `Content-Type` header, so the presigned URL must sign the content type.
  - `POST /documents/{id}/complete` has no body.
  - `POST /summaries` body `{documentId, style}` with style `concise|detailed|bullets|insights` → reads `{jobId}`.
  - `GET /summaries/{jobId}` → `{jobId, documentId, status: queued|processing|done|failed, stage?, result?, error?}`.
    - `stage` is one of `preparing|extracting|structuring|analyzing|generating|finalizing`.
    - `result` is `{documentName, style, overview, keyPoints[], findings[{title,detail}], actionItems[], generatedAt}`.
  - Errors: the frontend reads `response.data.message`.
  - It also calls `POST /summaries/{jobId}/questions`.
- Host environment:
  - A MySQL server is already running on `localhost:3306`.
  - The `localstack/localstack-pro` image is present, but `LOCALSTACK_AUTH_TOKEN` is not set in the env.
  - Node 22, AWS profile `document-ai`.

### Decisions (confirmed with user)
- **Contract:** the API matches the frontend exactly: no envelope, frontend field names and enum values. Error body: `{ "message": "...", "code": "DOCUMENT_NOT_FOUND" }`.
- **Q&A:** `POST /summaries/{jobId}/questions` is deferred. It is not registered in this API, and where it will live gets decided later.
- **Local infra:** LocalStack (S3 and SQS) through a small `docker-compose.yml`, which is infra emulation only; the Node API itself is not containerized. MySQL uses the host server on 3306 with a new `documind` DB and user.
- **Env:** `.env` for local stages, `.env.prod` for `--stage prod`. Serverless loads the file and injects the values into Lambda `environment`. Code reads `process.env` only through `src/config`. Secrets Manager is not used.
- **Serverless Framework v4** (already chosen). Its built-in esbuild handles TypeScript, so no bundler plugin is needed. `serverless-offline` serves the API locally.

### Key design choices
- **DB vocabulary vs API vocabulary.** The DB stores the spec vocabulary, which is the contract shared with the Python worker: statuses `queued|processing|completed|failed`, styles `concise|detailed|bullet_points|key_insights`. One mapper (`src/utils/contract.ts`) translates at the API edge: `completed→done`, `bullets↔bullet_points`, `insights↔key_insights`. Worker-facing names stay stable even if the UI wording changes.
- **Result composition.** The worker stores only `{overview, keyPoints, findings[{title,detail}], actionItems}` in `summary_jobs.result`. The API adds `documentName` (from `documents.file_name`), `style` (mapped) and `generatedAt` (from `completed_at`).
- **IDs and keys.** `documentId = doc_<uuid>`, `jobId = job_<uuid>` (`crypto.randomUUID`). The S3 key is `documents/{documentId}/{sanitizedFileName}` and is created server-side.
- **Upload records.** `POST /uploads` inserts the `documents` row with status `pending_upload`, which keeps the expected key and size server-side. `/complete` never trusts a client key.
- **Upload validation:**
  - Extension must be `.pdf`, `.docx` or `.txt`, and the MIME type must match the extension.
  - `size` must be >0 and ≤10 MB; larger returns 413.
  - The presigned PUT expires in 900s and signs `ContentType`.
- **Completion check:**
  - `HeadObject` on the DB key. A missing object returns 409 `UPLOAD_NOT_FOUND`.
  - `ContentLength` must be ≤10 MB and must equal the declared size; otherwise the object is deleted and the API returns 409/413.
  - `ContentType` must match what was declared.
  - The document is marked `uploaded`.
  - The call is idempotent: an already-uploaded document returns 200.
- **No SQS publish on upload or completion.**
- **Summary creation:**
  - Validate the style, and the optional `instructions` (≤2000 chars, accepted for the future even though the UI doesn't send it yet).
  - The document must exist and be `uploaded`.
- **Duplicate protection:**
  1. An optional `Idempotency-Key` header with `UNIQUE(document_id, idempotency_key)`.
  2. Since the UI sends no header: if an *active* (`queued`/`processing`) job already exists for the same document, style and instructions hash, it is returned instead of creating a new one. This protects against double-clicks; a regeneration after completion still creates a new job.
- **Reliable publish, with no extra infrastructure:**
  - Insert the job (`queued`, `published_at NULL`) and commit, then `SendMessage`, then set `published_at`.
  - If `SendMessage` fails, mark the job `failed` with `error_code=QUEUE_PUBLISH_FAILED` and return 503 `QUEUE_UNAVAILABLE`.
  - **Recovery** covers a crash between the insert and the publish. `GET /summaries/{jobId}`, which the frontend polls, sees `queued` with `published_at IS NULL` and `created_at` older than 60s. It claims the republish with a conditional `UPDATE … SET publish_attempts = publish_attempts + 1 WHERE … AND publish_attempts = ?`, then republishes.
  - After 3 failed attempts the job is marked `failed`.
  - The worker must be idempotent, which is already in its spec, so a rare duplicate message is harmless.
- **SQS message:** `{"jobId": "...", "documentId": "..."}` only, with no content or style; the worker reads those from MySQL.
- **MySQL connections:**
  - The `mysql2/promise` pool is created once per container (module scope) with `connectionLimit` from env (default 2), `enableKeepAlive`, and `waitForConnections`.
  - Lost connections are handled by the pool.
  - The `withTransaction(fn)` helper does begin/commit/rollback and always `release()`s the connection.
  - All SQL is parameterized and lives in `src/repositories/*` only.
- **Errors:**
  - `AppError(status, code, message)` subclasses.
  - The handler wrapper maps them to JSON. Unknown errors become 500 `INTERNAL_ERROR` and are logged with the requestId.
  - No stack traces, SQL text or AWS errors leak to the client.
  - Codes: 400 `VALIDATION_ERROR`, 404 `DOCUMENT_NOT_FOUND`/`JOB_NOT_FOUND`, 409 `UPLOAD_NOT_FOUND`/`DOCUMENT_NOT_UPLOADED`, 413 `FILE_TOO_LARGE`, 503 `QUEUE_UNAVAILABLE`/`DATABASE_UNAVAILABLE`.
- **Logging:** a dependency-free JSON logger (`level, msg, requestId, route, durationMs, …`). It never logs document content, URLs with signatures, or credentials.
- **Validation:** `zod`, a small dependency justified by typed request parsing for every route.
- **CORS:** `httpApi.cors` with origins from env `CORS_ALLOWED_ORIGINS` (local: `http://localhost:3000`). LocalStack bucket CORS allows PUT from the same origin.
- **Auth:** none yet. `documents.user_id` is nullable, and repositories accept an optional `userId` for future ownership checks.

## Implementation steps (in the spec's priority order)

### 0. Spec bookkeeping and cleanup
- Create `agent-os/specs/2026-11-16-<HHMM>-documind-node-api/` with these files:
  - `plan.md` (this plan) and `shape.md` (decisions above)
  - `standards.md` (contract, error format, security rules)
  - `references.md` (the `../ui` contract files)
  - `source-spec.md` (the pasted Node spec, verbatim)
  - `worker-contract.md`, the contract for the Python project: the SQS message, the DB columns and statuses the worker updates (`status`, `stage`, `result`, `llm_provider`, `llm_model`, `error_code`, `error_message`, `started_at`, `completed_at`), and the result JSON shape.
- Add a note at the top of the old `2026-11-14-1535-documind-backend-api/plan.md`: "API portions superseded by 2026-11-16 Node API spec; AI/processing portions apply to the Python project in ../ai."
- Delete `api/.venv/`. Replace `package.json`; `node_modules` is reinstalled.

### 1. Initialize the Node.js + TypeScript project
- `package.json`:
  - deps: `mysql2`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-sqs`, `zod`
  - devDeps: `typescript`, `@types/node`, `@types/aws-lambda`, `serverless@4`, `serverless-offline`, `vitest`, `aws-sdk-client-mock`
  - scripts: `offline`, `typecheck`, `test`, `migrate`, `deploy:prod`
- `tsconfig.json` (strict, ES2022, NodeNext), `.gitignore` (`node_modules`, `.serverless`, `.build`, `.env`, `.env.prod`, `dist`), `.env.example`.
- Runtime `nodejs22.x`.

### 2. Configure Serverless Framework (`serverless.yml`)
- `service: documind-api`, `provider: aws`, `region: ap-south-1`.
- `profile: document-ai` only for the prod stage. `stage` defaults to `local`.
- Env loading: `.env.prod` for `--stage prod`, `.env` otherwise. Verify v4's dotenv behavior (`useDotenv` / `.env.{stage}` precedence) at implementation and pin it in the README.
- `provider.environment`: maps every variable from `src/config` via `${env:…}`.
- `functions`: `createUpload`, `completeUpload`, `createSummary`, `getSummary`. Each handler is `src/handlers/<name>.handler` with an `httpApi` event.
- `resources` (prod deploy only, never created without approval):
  - S3 bucket: private, BlockPublicAccess, SSE-S3, CORS for the frontend origin.
  - SQS queue + DLQ (`maxReceiveCount` 3). The visibility timeout is a param set to suit the Python worker's timeout.
  - `Outputs` export the queue ARN/URL and bucket name for the Python project.
- IAM (least privilege):
  - `s3:PutObject`, `s3:GetObject` (covers HeadObject) and `s3:DeleteObject` (for removing invalid uploads) on `arn:…:bucket/documents/*`
  - `sqs:SendMessage` on the queue ARN
- `custom.serverless-offline`: `httpPort: 4000` (the UI uses 3000).
- `docker-compose.yml`:
  - `localstack` only (image `localstack/localstack:4.14.0`, Community, no auth token, port 4566, healthcheck waits for the init script).
  - `docker/localstack/init-aws.sh` creates the bucket (with CORS), the queue and the DLQ with its redrive policy.

### 3. Env configuration
- `src/config/index.ts` reads and validates `process.env` once with zod and fails fast on missing values. Variables:
  - `NODE_ENV`, `AWS_REGION`
  - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT`
  - `S3_BUCKET_NAME`, `SQS_QUEUE_URL`, `CORS_ALLOWED_ORIGINS`
  - `UPLOAD_URL_EXPIRES_SECONDS`, `MAX_UPLOAD_BYTES`
  - `AWS_ENDPOINT_URL` (local only; it sets `endpoint` + `forcePathStyle` on the S3 client so presigned URLs point at `http://localhost:4566`)
- `.env.example` uses placeholders. `.env` and `.env.prod` are gitignored, created by you.

### 4. MySQL connection and database utilities
- `src/database/pool.ts`: a lazy singleton pool, `query<T>()`, and `withTransaction()`. Connection errors are mapped to `DATABASE_UNAVAILABLE`.
- `database/migrations/001_initial.sql` and `scripts/migrate.mjs` (plain Node + mysql2; applies files in order and records them in `schema_migrations`). This repo owns the schema.
- `database/setup-local.sql`: creates the `documind` DB and user on the host MySQL, which you run once with `! sudo mysql < database/setup-local.sql`.
- Tables (InnoDB, utf8mb4, `DATETIME(3)`):
  - **`documents`**: `id` PK, `document_id` UNIQUE, `user_id` NULL, `file_name`, `content_type`, `file_size`, `s3_key`, `status` ENUM(`pending_upload`, `uploaded`), `uploaded_at`, `created_at`, `updated_at`. Indexes on `(user_id)` and `(status)`.
  - **`summary_jobs`**:
    - Identity and links: `id` PK, `job_id` UNIQUE, `document_id` FK → `documents.document_id`.
    - Status: `status` ENUM(`queued`, `processing`, `completed`, `failed`), `stage` VARCHAR NULL.
    - Request: `summary_style` ENUM, `instructions` TEXT NULL, `instructions_hash` CHAR(64) NULL, `idempotency_key` NULL.
    - Result: `result` JSON NULL, `extracted_content_key` NULL.
    - LLM and errors: `llm_provider`, `llm_model`, `llm_usage` JSON NULL, `error_code`, `error_message`, `retry_count`.
    - Publishing: `publish_attempts`, `published_at`.
    - Timestamps: `created_at`, `started_at`, `completed_at`, `updated_at`.
    - Indexes: `UNIQUE(document_id, idempotency_key)`, `(document_id, status)`, `(status, created_at)`.
  - The `summary_questions` table is deferred together with Q&A. The schema stays open to it.

### 5–6. Upload + completion
- `src/handlers/createUpload.ts` → `services/uploadService.ts` → `repositories/documentRepository.ts` + `services/s3Service.ts` (`presignPut`, `headObject`, `deleteObject`). Returns 201 `{documentId, key, uploadUrl, expiresIn}`.
- `src/handlers/completeUpload.ts` → `uploadService.completeUpload(documentId)`. Returns 200 `{documentId, status: "uploaded", fileName}`.

### 7–8. Summary job creation + SQS
- `src/handlers/createSummary.ts` → `services/summaryService.ts` (validation, duplicate/idempotency checks, transaction insert, publish, failure marking) → `repositories/summaryJobRepository.ts` + `services/sqsService.ts`. Returns 202 `{jobId, documentId, status: "queued"}`.

### 9. Status and result retrieval
- `src/handlers/getSummary.ts` → `summaryService.getJob(jobId)`. It joins the document, maps through `utils/contract.ts`, and runs the lazy republish recovery. Returns 200 with the frontend `SummaryJob` shape: `error` is a user-safe message (never raw worker exceptions), and `result` is present only when `done`.

### 10. Error handling, logging, reliability
- `src/middleware/httpHandler.ts`: the `withHttp(handlerFn)` wrapper. It parses the JSON body (invalid → 400), attaches the logger and requestId, maps `AppError`s, adds JSON headers and logs the duration.
- `src/utils/{errors,logger,contract,ids,fileTypes}.ts`, `src/types/{api,db}.ts`.

### 11. Local end-to-end test
- Unit tests (`tests/`, vitest) use `aws-sdk-client-mock` for S3/SQS and a mocked repository layer. They cover:
  - Validation: extension, MIME and size.
  - Upload URL generation, and the completion paths (missing object, size mismatch, idempotent).
  - Summary creation: happy path, document not uploaded, duplicate active job, idempotency key, and SQS failure → job `failed` + 503.
  - Lazy republish recovery, and contract mapping (`completed→done`, style aliases, result composition).
- An integration test (`tests/integration`, opt-in) runs against LocalStack + host MySQL.

## Verification
1. `docker compose up -d`, then `aws --endpoint-url http://localhost:4566 s3 ls` / `sqs list-queues`. These use explicit flags only, and global AWS config is not touched.
2. `! sudo mysql < database/setup-local.sql`, then `npm run migrate`.
3. `npm run typecheck && npm test`.
4. `npm run offline` (port 4000), then:
   - `curl POST /uploads` → `curl -X PUT` the file to `uploadUrl` with the same Content-Type → `POST /documents/{id}/complete` → `POST /summaries` returns 202.
   - Confirm the message in LocalStack SQS (`receive-message`).
   - `GET /summaries/{jobId}` returns `queued`.
   - Manually `UPDATE summary_jobs SET status='completed', result=…`, then GET returns `done` + the composed result.
5. Point `../ui` `.env.local` at `http://localhost:4000` (your change, in your repo) and run the upload → generate flow from the browser.
6. No `serverless deploy` without explicit approval; prod uses `--stage prod` with the `document-ai` profile.

## Open items
- ~~LocalStack Pro auth token~~ Resolved: switched to LocalStack Community 4.14.0 (tokenless).
- **Serverless v4 login:** run `! npx serverless login` once. The earlier `/login` was Claude Code's login, not Serverless's.
- **Production MySQL** host and network: if it is RDS in a VPC, the Lambdas need VPC config, and SQS/S3 access then needs a NAT or VPC endpoints. Decide before the prod deploy.
- **Q&A route ownership:** deferred.
