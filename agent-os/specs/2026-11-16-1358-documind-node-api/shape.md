# DocuMind API (Node.js + TypeScript) — Shaping Notes

## Scope

This is the frontend-facing API for DocuMind AI. It is a Node.js + TypeScript project on Serverless Framework v4, AWS Lambda and API Gateway (HTTP API), using MySQL (`mysql2`), S3 and SQS. AI processing lives in the separate Python project (`../ai`).

Routes:
- `POST /uploads`
- `POST /documents/{documentId}/complete`
- `POST /summaries`
- `GET /summaries/{jobId}`

Source requirements are in `source-spec.md`.

## Decisions

- **Contract:** the API matches the existing frontend (`../ui/src/lib/api`). There is no envelope, and errors are `{message, code}`. The frontend's enum values are `bullets`/`insights` and `done`.
- **Shared DB vocabulary:** the DB, which is shared with the Python worker, uses the spec vocabulary: `completed`, `bullet_points`, `key_insights`. `src/utils/contract.ts` translates at the API edge.
- **Q&A deferred:** `POST /summaries/{jobId}/questions` is not part of this API yet.
- **Local infra:** LocalStack Community 4.14.0 (S3/SQS; no auth token) via docker-compose, plus the host MySQL on 3306. The Node API itself is not containerized.
- **Env files:** `.env` for local and `.env.prod` for `--stage prod`, injected into Lambda env. No Secrets Manager.
- **Upload records:** the `documents` row is created at `POST /uploads` (`pending_upload`). The S3 key and declared size are kept server-side, and `/complete` verifies them with HeadObject.
- **Publishing:** SQS is published only from `POST /summaries`. The message is `{jobId, documentId}`.
- **Reliable publish:**
  - Publish after the DB commit, then set `published_at`.
  - If the publish fails, the job is marked `failed` and the API returns 503.
  - If the process crashes between insert and publish, `GET /summaries/{jobId}` lazily republishes (a claim via the `publish_attempts` CAS, max 3).
- **Duplicate jobs:**
  - An optional `Idempotency-Key` header.
  - The active job for the same document, style and instructions is reused.
- **Validation:** `zod` for request and config validation.
- **Logging:** a dependency-free JSON logger.
- **Auth:** none yet. `user_id` is nullable.

## Context

- **Visuals:** None.
- **References:** `../ui/src/lib/api/client.ts` and `types.ts` (the contract).
- **Product alignment:** N/A.
- **Previous spec:** `../2026-11-14-1535-documind-backend-api/`. Its AI parts move to the Python project.
