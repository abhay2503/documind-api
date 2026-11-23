# DocuMind API

This is the frontend-facing API for DocuMind AI, written in Node.js and TypeScript and running on AWS Lambda behind API Gateway (HTTP API). It handles four jobs:

- issuing presigned S3 uploads
- verifying finished uploads
- creating summary jobs in PostgreSQL and publishing them to SQS
- returning job status and results

**AI processing is not done here.** A separate Python worker consumes the SQS queue and writes progress and results back to PostgreSQL. The two projects agree on a shared contract, described in [`worker-contract.md`](agent-os/specs/2026-11-16-1358-documind-node-api/worker-contract.md). The design notes are in [`agent-os/specs/2026-11-16-1358-documind-node-api/`](agent-os/specs/2026-11-16-1358-documind-node-api/).

## Routes

The request and response shapes match the frontend (`../ui/src/lib/api`) exactly. Responses are returned as-is, with no wrapper object. Errors look like `{ "message": "...", "code": "..." }`.

| Method | Path | Request | Success |
|---|---|---|---|
| POST | `/uploads` | `{ fileName, contentType, size }` | **201** `{ documentId, key, uploadUrl, expiresIn }` |
| POST | `/documents/{documentId}/complete` | no body | **200** `{ documentId, status: "uploaded", fileName }` |
| POST | `/summaries` | `{ documentId, style, instructions? }` plus an optional `Idempotency-Key` header | **202** `{ jobId, documentId, status }` |
| GET | `/summaries/{jobId}` | none | **200** `{ jobId, documentId, status, stage?, result?, error? }` |

- **Authentication:** every route requires `Authorization: Bearer <Cognito access token>`. See [Authentication and ownership](#authentication-and-ownership).
- **`style`:** `concise`, `detailed`, `bullets` or `insights`. These are stored in the database as `bullet_points` and `key_insights`.
- **`status`:** `queued`, `processing`, `done` or `failed`. `done` is stored in the database as `completed`.
- **Accepted files:** `.pdf`, `.docx` and `.txt`, up to 10 MB. The `Content-Type` is included in the upload URL's signature, so the browser must send the same `Content-Type` when it uploads.
- **Error codes:**

  | Status | Codes |
  |---|---|
  | 400 | `VALIDATION_ERROR` |
  | 401 | Returned by API Gateway for a missing, invalid or expired token (body `{"message":"Unauthorized"}`; Lambda is not invoked). `UNAUTHORIZED` from Lambda only if a route ever bypasses the authorizer. |
  | 404 | `DOCUMENT_NOT_FOUND`, `JOB_NOT_FOUND` |
  | 409 | `UPLOAD_NOT_FOUND`, `UPLOAD_SIZE_MISMATCH`, `UPLOAD_TYPE_MISMATCH`, `DOCUMENT_NOT_UPLOADED` |
  | 413 | `FILE_TOO_LARGE` |
  | 500 | `INTERNAL_ERROR` |
  | 503 | `QUEUE_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `STORAGE_UNAVAILABLE` |

- **Not built yet:** `POST /summaries/{jobId}/questions` (follow-up questions) is deferred and is not part of this API yet.

## Authentication and ownership

- **Who validates the token:** API Gateway's native HTTP API **JWT authorizer** (`cognitoJwt` in `serverless.yml`) validates the Cognito **access token**: signature, issuer `https://cognito-idp.ap-south-1.amazonaws.com/<COGNITO_USER_POOL_ID>`, expiry, and `client_id` against the audience `<COGNITO_APP_CLIENT_ID>`. A request with a missing or invalid token gets a 401 from API Gateway and never reaches Lambda. The User Pool and the public App Client (no secret) were created manually and are not managed by this stack.
- **Identity:** Lambda reads only the verified `sub` claim (`event.requestContext.authorizer.jwt.claims.sub`) through `getAuthenticatedUserId` (`src/utils/auth.ts`). A `userId` sent in the body, query string or headers is ignored. Email is not used as an identifier.
- **Ownership:** `POST /uploads` stores the `sub` in `documents.user_id`. Summary jobs belong to a user through `summary_jobs.document_id → documents.user_id`. The other three routes filter by owner in SQL. A document or job that belongs to another user returns the **same 404** as one that doesn't exist (`DOCUMENT_NOT_FOUND` / `JOB_NOT_FOUND`). This happens before any S3 call, job insert or SQS publish.
- **Documents created before authentication** (`user_id IS NULL`) are kept as they are: there is no backfill and nothing is deleted. Since no authenticated `sub` matches NULL, these documents and their jobs return 404 to every user. If any of them ever needs to be reassigned, that has to be a deliberate manual `UPDATE documents SET user_id = '<sub>'`, done only with real evidence of who owns them.

## How it works

1. **`POST /uploads`** checks the extension, MIME type and size. It saves a `documents` row with status `pending_upload`, which records the S3 key and declared size on the server, and returns a presigned PUT URL. No processing starts.
2. **Browser to S3:** the browser uploads the file directly to S3 using that URL.
3. **`POST /documents/{id}/complete`** reads the S3 key from the database (never from the client) and checks the object in S3. The object must exist, its size must equal the declared size and be at most 10 MB, and its content type must match. If any check fails, the object is deleted. If all pass, the document is marked `uploaded`. Calling it again is harmless, and it does not publish anything to SQS.
4. **`POST /summaries`** does its work inside a transaction that locks the document row:
   - It checks that the document's upload is complete.
   - It handles duplicate requests. A repeated `Idempotency-Key` returns the original job. If a `queued` or `processing` job already exists for the same document, style and instructions, that job is returned instead of creating a new one (this protects against double-clicks).
   - It inserts a `queued` job and commits.

   After the commit it publishes `{ jobId, documentId }` to SQS and records `published_at`.
5. **`GET /summaries/{jobId}`** returns the latest state written by the worker. For a completed job it also adds `documentName`, `style` and `generatedAt` to the result.

### Making sure jobs reach the queue

- **SQS publish fails:** the job is marked `failed` (`QUEUE_PUBLISH_FAILED`) and the API returns 503, so the frontend shows an error instead of waiting forever.
- **Lambda dies between the commit and the publish:** the job stays `queued` with no `published_at`. The frontend keeps polling `GET /summaries/{jobId}`, and once the job is more than 60 s old, a poll claims a republish. The claim is a conditional update on `publish_attempts`, so two simultaneous polls can't both republish. After 3 attempts in total the job is marked `failed`.

No scheduler or extra AWS service is needed. The worker must be idempotent, because a rare duplicate message is possible.

## Project layout

```text
src/
  handlers/       thin Lambda handlers (validate → service → response)
  services/       business logic and AWS integrations (S3, SQS)
  repositories/   all SQL (parameterized)
  database/       node-postgres (pg) pool, query helpers, transactions
  middleware/     withHttp: JSON parsing, logging, centralized errors
  utils/          errors, logger, ids, file types, API↔DB contract mapping
  types/          API (frontend) and DB (worker) shapes
  config/         the only reader of process.env (validated with zod)
database/
  migrations/     schema (owned by this repo, shared with the worker)
  setup-local.sql one-time local DB and user creation
scripts/migrate.mjs
docker-compose.yml          LocalStack only (S3 + SQS emulation)
docker/localstack/init-aws.sh
tests/unit, tests/integration
```

## Local development

**Prerequisites:**
- Node 22
- Docker
- A PostgreSQL server running on the host (127.0.0.1:5432)
- A Serverless Framework account. v4 needs a one-time `npx serverless login`.
- No LocalStack account or token is needed. Compose uses **LocalStack Community 4.14.0**, the last release that runs without an auth token (newer 2026.x images refuse to start without a license).

```bash
npm install
cp .env.example .env            # then fill in DB_PASSWORD etc.

# 1. Local AWS: S3 bucket (+ CORS) and SQS queue/DLQ are created by docker/localstack/init-aws.sh.
#    --wait returns once the container is healthy, i.e. after the init script has finished.
npm run localstack:up          # docker compose up -d --wait
npm run test:localstack        # optional: checks S3 presign/PUT/HEAD/DELETE, CORS and SQS (no database needed)

# 2. PostgreSQL (once): create the `documind` database if it is missing, then apply the schema
PGPASSWORD=<your postgres password> psql -h 127.0.0.1 -U postgres -d postgres -f database/setup-local.sql
npm run migrate

# 3. API on http://localhost:4000
npx serverless login            # once
npm run offline
```

In the frontend repo, set `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` in `../ui/.env.local`.

Locally, presigned URLs point at `http://localhost:4566/<bucket>/<key>` (LocalStack, path-style), so the browser can reach them. The LocalStack bucket accepts CORS `PUT` requests from `CORS_ALLOWED_ORIGIN`.

**Stop or reset:**
- `npm run localstack:down` (`docker compose down`) stops LocalStack.
- LocalStack Community has no persistence. Uploaded objects and queued messages are lost on every restart, and the bucket and queues are recreated empty, so a restart is also a reset.
- Local S3 checks presigned-URL signatures like real S3 (`S3_SKIP_SIGNATURE_VALIDATION=0`), so a PUT with a different `Content-Type` than the signed one fails with 403 locally too.
- To reset the database, run `DROP DATABASE documind;` and then `CREATE DATABASE documind;` as admin, followed by `npm run migrate`.

**Inspect LocalStack** with explicit endpoint flags, so your global AWS configuration is never used:
```bash
aws --endpoint-url http://localhost:4566 --region ap-south-1 s3 ls s3://documind-documents-local --recursive
aws --endpoint-url http://localhost:4566 --region ap-south-1 sqs receive-message \
  --queue-url http://localhost:4566/000000000000/documind-summary-queue-local
```

### Manual flow check (curl)

```bash
API=http://localhost:4000
printf 'hello documind\n' > /tmp/sample.txt
# Every route needs a Cognito access token (serverless-offline checks iss/aud/exp but not the signature).
# Copy one from the signed-in UI, e.g. (await fetchAuthSession()).tokens.accessToken.toString()
TOKEN=<access-token>
AUTH="Authorization: Bearer $TOKEN"
R=$(curl -s -X POST $API/uploads -H "$AUTH" -H 'Content-Type: application/json' \
     -d "{\"fileName\":\"sample.txt\",\"contentType\":\"text/plain\",\"size\":$(stat -c%s /tmp/sample.txt)}")
DOC=$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).documentId')
URL=$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).uploadUrl')
curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @/tmp/sample.txt "$URL"
curl -s -X POST $API/documents/$DOC/complete -H "$AUTH"
J=$(curl -s -X POST $API/summaries -H "$AUTH" -H 'Content-Type: application/json' -d "{\"documentId\":\"$DOC\",\"style\":\"bullets\"}")
JOB=$(echo "$J" | node -pe 'JSON.parse(require("fs").readFileSync(0)).jobId')
curl -s $API/summaries/$JOB -H "$AUTH"   # → queued (until the Python worker processes it)
```

## Tests

```bash
npm run typecheck
npm test                    # unit tests (S3/SQS mocked with aws-sdk-client-mock, repositories mocked)
npm run test:localstack     # S3 + SQS integration against LocalStack only (no database)
npm run test:integration    # everything above + full upload → summary flow against LocalStack and local PostgreSQL
```

## Configuration

**Environment files:**
- `.env` is used for local development (`--stage local`, the default).
- `.env.prod` is used for `--stage prod`.

Both are gitignored. `.env.example` lists every key.

> **Important:** when you deploy with `--stage prod`, Serverless v4 loads `.env.prod` **and** `.env`. Any key missing from `.env.prod` silently falls back to your local value, so `.env.prod` must define every key.
>
> Two safeguards help:
> - `serverless.yml` always deploys `LOCAL_AWS_ENDPOINT` empty for prod.
> - The app refuses to start if `NODE_ENV=production` while a LocalStack endpoint is set.

| Key | Purpose |
|---|---|
| `NODE_ENV` | `development` / `production` |
| `AWS_REGION` | `ap-south-1` locally. Lambda sets it automatically, so it is not injected. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL (`DB_SSLMODE`: `disable` locally, `require` on Aiven) |
| `DB_CONNECTION_LIMIT` | Pool size per Lambda container (default 2) |
| `S3_BUCKET_NAME` | Documents bucket. In prod the stack creates this bucket under this name. |
| `SQS_QUEUE_URL` | Local queue URL. In prod it is taken from the stack's own queue. |
| `LOCAL_AWS_ENDPOINT` | LocalStack endpoint (local only) |
| `CORS_ALLOWED_ORIGIN` | Frontend origin, used for both API Gateway CORS and S3 bucket CORS |
| `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID` | The existing Cognito User Pool and public App Client. Used only by `serverless.yml` to configure the API Gateway JWT authorizer; they are not passed to Lambda. CI reads them from the GitHub repository **variables** of the same names. |
| `UPLOAD_URL_EXPIRES_SECONDS`, `MAX_UPLOAD_BYTES` | 900 and 10 MB by default |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | Prod queue visibility timeout. Must be at least 6× the Python worker's Lambda timeout. |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (optional) |

## Deployment (production)

> **Get explicit approval before deploying.** The deploy creates real AWS resources in the personal `document-ai` account, in `ap-south-1`.

```bash
aws sso login --profile document-ai
cp .env.example .env.prod        # fill in every key; leave LOCAL_AWS_ENDPOINT empty
npm run package:prod             # dry run: builds and synthesizes CloudFormation without deploying
npm run migrate:prod             # apply the schema to the production PostgreSQL (Aiven)
npm run deploy:prod              # serverless deploy --stage prod (uses profile document-ai)
```

**What the stack creates:**
- 4 Lambda functions (`nodejs22.x`, arm64) and an HTTP API with CORS for `CORS_ALLOWED_ORIGIN`, plus a Cognito JWT authorizer on every route. No Cognito resources are created.
- An S3 bucket (`S3_BUCKET_NAME`) with these settings:
  - private, with all public access blocked
  - SSE-S3 encryption
  - BucketOwnerEnforced ownership
  - CORS that allows PUT from the frontend
  - retained if the stack is deleted
- An SQS queue `documind-summary-queue-prod`, with visibility timeout `SQS_VISIBILITY_TIMEOUT_SECONDS`, plus a DLQ `documind-summary-dlq-prod` (`maxReceiveCount` 3, 14-day retention).
- Outputs for the Python worker: `DocumentsBucketName`, `SummaryQueueUrl`, `SummaryQueueArn`, `SummaryDeadLetterQueueArn`, `HttpApiUrl`.

**The Lambda role is least-privilege.** It can only:
- `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/documents/*`
- `sqs:SendMessage` on the summary queue

The presigned upload URLs are signed with this same role.

**The API does not provision the database.** Production uses Aiven PostgreSQL over the public internet with `DB_SSLMODE=require`, so the Lambdas need no `vpc` config. If you move to a private network later, the functions need a `vpc` config, and S3 and SQS then need VPC endpoints or a NAT gateway.

## Known limitations / next steps

- There are no per-user usage limits yet.
- Follow-up Q&A (`POST /summaries/{jobId}/questions`) is deferred, and its owner is not yet decided.
- Upload objects whose `/complete` call never happens are not cleaned up. Consider an S3 lifecycle rule or a cleanup job later.
- Rate limiting and API Gateway throttling are left at their defaults.
