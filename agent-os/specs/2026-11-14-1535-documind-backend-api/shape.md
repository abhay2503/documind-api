# DocuMind AI Backend API — Shaping Notes

## Scope

This is the Python serverless backend for DocuMind AI, an AI document summarizer. The frontend is a separate Next.js app in `../ui` and is out of scope.

What the backend does:
- `POST /uploads` issues a presigned S3 PUT (PDF, DOCX, TXT; up to 10 MB).
- `POST /documents/{documentId}/complete` verifies the S3 object and marks the document uploaded in MySQL.
- `POST /summaries` creates a job (`queued`), publishes it to SQS and returns 202 immediately.
- An SQS-triggered processing Lambda (container image) runs Docling extraction, then Bedrock (primary) with Groq as fallback, then validates the JSON summary and stores it in MySQL.
- `GET /summaries/{jobId}` returns status and result.
- `POST /summaries/{jobId}/questions` answers grounded Q&A over that job's extracted document only.

Local development uses Serverless Offline, LocalStack (S3/SQS) and MySQL in Docker. Production is `ap-south-1` on the personal `document-ai` SSO profile.

The full source requirements are in `source-spec.md`, plus the addenda in `source-spec-large-docs.md` (r2) and `source-spec-hybrid-chunker.md` (r3).

## Decisions

- **Serverless Framework v4**, installed as a project dev dependency. It needs `serverless login`.
- **Local SQS trigger:** the `serverless-offline-sqs` plugin, pointed at LocalStack.
- **Runtime:** python3.12 for all functions. The venv is created with `uv venv --python 3.12` because the host has 3.14.
- **Packaging:** API functions are zip packages. `process_summary` is a Lambda container image (`docker/processing.Dockerfile`) because of Docling's size.
- **DB driver:** PyMySQL with parameterized SQL and a reused module-level connection (`ping(reconnect=True)`). No ORM, no DynamoDB, no Node backend code.
- **Server-owned S3 key:** the `documents` row is created at `POST /uploads` (`pending_upload`). `/complete` reads the key from the DB.
- **Reliable publish:** commit the job, then publish to SQS. If the publish fails, mark the job `failed` and return 503.
- **Idempotency:** an optional `Idempotency-Key` header on `POST /summaries`, enforced by UNIQUE(document_id, idempotency_key).
- **Processing idempotency:** an atomic conditional status claim. Completed or in-flight jobs are skipped. The result and the `completed` status are written in one transaction.
- **SQS settings:**
  - `batchSize: 1` with `ReportBatchItemFailures`.
  - Lambda timeout 300s; visibility timeout 1800s.
  - DLQ with `maxReceiveCount: 3`.
  - The final attempt marks the job `failed`.
- **Extracted Markdown** is stored in S3 at `extracted/{documentId}.md`, not in MySQL. It is reused for Q&A.
- **Chunking:** map-reduce summarization when the content exceeds `LLM_MAX_INPUT_TOKENS`.
- **LLM calls:**
  - Bedrock uses the Converse API. The model ID comes from env and must be verified in ap-south-1 first; no ID is hardcoded.
  - Retry only transient errors, with bounded backoff and jitter.
  - Fall back to Groq only on throttling, unavailability or overload. Never fall back on validation, permission or config errors.
- **Output validation:** both providers' output is validated by the same Pydantic `SummaryResult` schema.
- **Module names** use underscores (`bedrock_service.py`) instead of the spec's dotted names.
- **Large documents (r2, revised r3):**
  - Docling's `DocumentConverter` produces a `DoclingDocument`. TXT is converted into a `DoclingDocument` too.
  - Docling **`HybridChunker`** produces the chunks; there is **no custom chunker** (`chunking_service.py` is a thin wrapper). LLM input is always `chunker.contextualize(chunk)`.
  - Tokenizer: a `char_estimate` docling-core `BaseTokenizer` (4 chars/token) by default, with HF/tiktoken selectable. `max_tokens` is the min of the Bedrock and Groq input budgets (context − output − prompt/instruction overhead, × safety ratio).
  - S3 artifacts: the original (immutable), `extracted/{id}.md`, `extracted/{id}.docling.json`, `chunks/{id}/{summary|qa}-{configHash}.json` and `intermediate/{jobId}/…` checkpoints.
  - Reuse rules: a matching chunk set skips Docling and the chunker; a matching Docling JSON skips Docling only; otherwise run full extraction.
  - Single request when the document fits; otherwise map-reduce with hierarchical reduce (greedy packing of whole notes), bounded concurrency and checkpoints.
  - Q&A reads the persisted Q&A chunk set (BM25 top-K plus neighbours), and the API Lambda has no Docling dependency.
  - Overlap: none for summaries (HybridChunker has no overlap option); neighbour expansion at Q&A retrieval time instead.
  - Usage is tracked in `summary_jobs.llm_usage`, with no claim of token savings. Processing Lambda is 900s, with visibility 5400s.
- **Auth:** not implemented yet. `user_id` is nullable and repositories accept an optional owner filter.
- **No AWS deployment** or resource creation without explicit approval. The company `nearsite` profile must not be touched, and global AWS, Git and SSH config must not be modified.

## Context

- **Visuals:** None. The API is backend-only.
- **References:** None. The repo was empty at shaping time, and the pasted spec is the contract.
- **Product alignment:** N/A. There is no `agent-os/product/`.

## Open items / blockers

- **r3 verification items** (pinned versions): the docling-core `BaseTokenizer` interface, HybridChunker's handling of items it cannot split, native TXT ingestion, and the `chunk.meta` page provenance.

- The user must run `npx serverless login` for Serverless v4.
- Claude model or inference-profile availability in ap-south-1 must be verified with read-only `aws bedrock list-*` calls on `document-ai`, and model access must be enabled.
- A Groq API key is needed for fallback testing (local `.env` only).
- Production MySQL hosting and Lambda VPC/NAT networking are undecided. This is a deploy-time decision.

## Standards Applied

There are no agent-os standards indexed yet. The spec's response envelope, error codes and security rules are captured as working standards in `standards.md`.
