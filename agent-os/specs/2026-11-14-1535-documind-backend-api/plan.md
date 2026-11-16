> **Superseded for this repo (2026-11-16):** the API portions of this spec are replaced by `../2026-11-16-*-documind-node-api/` (Node.js + TypeScript API). The AI/processing portions (Docling, HybridChunker, Bedrock/Groq, map-reduce, worker idempotency) apply to the separate Python project in `../ai`.

# DocuMind AI Backend API — Shaped Spec & Implementation Plan

> **Revision log**
> - **r1** (2026-11-14): initial shaped plan (`source-spec.md`).
> - **r2** (2026-11-14): large-document processing addendum (`source-spec-large-docs.md`).
> - **r3** (2026-11-14): chunking switched to Docling **HybridChunker** (`source-spec-hybrid-chunker.md`). The custom Markdown chunker is removed. The changes affect "Key design choices", "Large document processing", the storage layout, Tasks 2, 3, 5, 6, 7 and 8, and the open items. API contracts, the upload flow, the SQS architecture and the Bedrock/Groq fallback are unchanged.

## Context

`/home/abhay/Documents/python-summarizer/api` is an empty repository. It holds only `agent-os/` scaffolding, with an empty standards index and no product docs. We are building the DocuMind AI backend from the user's pasted spec. The frontend lives in `../ui` and is a separate Next.js app that we must not touch. The backend does the following:
- Issues presigned S3 uploads.
- Confirms uploads into MySQL.
- Queues summary jobs on SQS.
- Processes jobs in a container-image Lambda: Docling extraction, HybridChunker, then Bedrock as the primary LLM with Groq as fallback.
- Serves status, results and grounded follow-up Q&A.

Local development uses Serverless Offline, LocalStack (S3/SQS) and a MySQL container. Production is `ap-south-1` under the `document-ai` SSO profile, and deployment needs explicit approval.

### Environment findings
- Python 3.14 local, `uv` available → create a 3.12 venv with uv.
- Node 22, Docker 29, Compose v5, AWS CLI v2. Profiles `document-ai` and `localstack` exist; `nearsite` (company) must not be touched.
- Serverless Framework is not installed. It will be installed as a **dev dependency** in `package.json`, with no global install.
- No git repo yet. Init only if the user asks.

### Shaping decisions (confirmed)
- **Serverless Framework v4.** Needs `serverless login` (free tier). Plugins: `serverless-offline` and `serverless-offline-sqs` (the latter polls LocalStack SQS → `process_summary`).
- **Runtime python3.12.** API functions are zip-packaged. `process_summary` is an ECR container image built from `docker/processing.Dockerfile`, based on `public.ecr.aws/lambda/python:3.12`.
- **Contract:** the pasted spec as-is. No visuals, no reference code.
- **No agent-os standards exist.** `standards.md` will note this and capture the spec's response-envelope and error rules as de-facto standards.
- **Module naming.** Use `bedrock_service.py`, not `bedrock.service.py`, because dots are not valid in Python module names.
- **Chunking (r3).** Docling `HybridChunker` only. `chunking_service.py` is a thin wrapper, and there is no custom heading, paragraph or sentence chunker.

### Key design choices
- **IDs:** `doc_<uuid4hex>`, `job_<uuid4hex>`. S3 key `documents/{documentId}/{sanitized_filename}` is generated server-side. The `documents` row is created at `POST /uploads` with status `pending_upload`. That way `/complete` reads the key from the DB, never from the client.
- **Reliable publish:** insert the job as `queued` and commit, then publish to SQS. If the publish fails, mark the job `failed` (`error_message=QUEUE_PUBLISH_FAILED`) and return 503. No stuck `queued` jobs.
- **Idempotency:** an optional `Idempotency-Key` header is stored in `summary_jobs.idempotency_key`, with UNIQUE on (document_id, idempotency_key). A repeat request returns the existing job.
- **Processing idempotency:** an atomic `UPDATE … SET status='processing' WHERE job_id=%s AND status IN ('queued','failed_retryable') OR (status='processing' AND started_at < NOW()-visibility)`. If 0 rows match, skip the message, because the job is completed or already in progress. `retry_count` is incremented. Result save + `completed` happen in one transaction.
- **SQS:**
  - `batchSize: 1` plus `functionResponseType: ReportBatchItemFailures`.
  - Processing timeout 900s and queue visibility timeout 5400s (≥6× the Lambda timeout, per AWS guidance).
  - DLQ with `maxReceiveCount: 3`.
  - The last attempt marks the job `failed`, detected via the `ApproximateReceiveCount` attribute.
- **Extracted content (r3):** Docling produces a `DoclingDocument`. From it the processor saves both Markdown (`extracted/{documentId}.md`, key saved in `summary_jobs.extracted_content_key` and `documents.extracted_content_key`) and lossless Docling JSON. HybridChunker chunk sets are persisted to S3. See "Storage layout".
- **Chunking (r3):** `HybridChunker` over the `DoclingDocument`, followed by single-request or map-reduce summarization. See "Large document processing".
- **LLM:**
  - Bedrock Converse API via boto3, with `BEDROCK_MODEL_ID` from env (no hardcoded ID).
  - Retries use exponential backoff with full jitter, max 3.
  - Fallback to Groq only on `ThrottlingException`, `ServiceUnavailableException`, `ModelNotReadyException`, `ModelTimeoutException`, 5xx and connection timeouts.
  - No fallback on `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException` or auth/config errors.
  - Both providers return JSON that is validated by the Pydantic `SummaryResult` model (`overview`, `keyPoints`, `findings`, `actionItems`). On a validation failure, re-prompt once, then error.
- **Q&A (r3):** reads only that document's persisted artifacts. It never imports or runs Docling or HybridChunker, and the API Lambda has no Docling dependency.
  - If the whole Markdown fits the Q&A budget, the full document goes into one prompt.
  - Otherwise it loads the persisted **Q&A chunk set** (HybridChunker output, contextualized text) and picks the top-K chunks by lexical BM25-style relevance (pure Python) within the budget. That is retrieval, not truncation, and the prompt says the excerpts are partial.
  - A system prompt tells the model to answer only from the provided content. Results are stored in `summary_questions`.
  - It is synchronous (API Gateway caps it at 29s), so Q&A never runs map-reduce.
- **DB:**
  - A PyMySQL connection is module-level and lazily created, reused across warm invocations, with `ping(reconnect=True)` before use.
  - A `transaction()` context manager wraps multi-record updates.
  - All SQL is parameterized.
- **Secrets:** locally via `.env`. In prod, DB credentials and the Groq key come from Secrets Manager (`SECRETS_ARN`), fetched once per cold start.
- **Responses:** the `{success, data, message}` / `{success:false, error:{code,message}}` envelope from `utils/responses.py`, plus an `AppError` hierarchy mapped to 400/404/409/413/500/503. Stack traces and SQL text are never returned. Logging contains no document content.
- **Auth:** `user_id` stays nullable. Repositories take an optional `user_id` filter so ownership checks can be switched on later.

### Large document processing (r2 addendum, revised in r3 for HybridChunker)

**Extraction** (`src/services/document/docling_service.py`)
- **PDF and DOCX:** `DocumentConverter.convert()` → `DoclingDocument`.
- **TXT:** decoded as UTF-8 (with a BOM strip; undecodable input fails as `DocumentExtractionError`). It is then turned into a `DoclingDocument` so HybridChunker can process it like any other format:
  - Preferred: Docling's own plain-text/Markdown input path, if the pinned Docling version accepts it without misreading `#`, `*` or `|` in plain text.
  - Otherwise: build the document programmatically with `docling-core` (`DoclingDocument` plus `add_text(label=PARAGRAPH)` per blank-line-separated block). This only *constructs the document*; all chunking stays in HybridChunker.
  - **Verify at implementation time and record the result in `references.md`.**
- Empty, corrupt or unsupported input raises `DocumentExtractionError`. It is non-retryable and marks the job failed immediately.
- The original upload in `documents/{documentId}/…` is never modified or deleted.

**Storage layout (S3, single private bucket)**

```text
documents/{documentId}/{fileName}                       original upload (immutable)
extracted/{documentId}.md                               Markdown export (human-readable; whole-doc prompts; spec path)
extracted/{documentId}.docling.json                     DoclingDocument JSON (lossless; re-chunking without re-running Docling)
chunks/{documentId}/{purpose}-{chunkConfigHash}.json    persisted HybridChunker chunk set (purpose = summary | qa)
intermediate/{jobId}/{chunkConfigHash}/map-{n}.md       map-stage checkpoints (lifecycle-expired after 7 days)
```

- `extracted/*` objects carry S3 user metadata: `source-etag` (the original's ETag), `docling-version` and `pipeline-hash` (a hash of the converter options, e.g. OCR on or off).
- **Chunk-set file schema** (Pydantic `ChunkSet`):
  - `documentId`, `purpose`, `sourceEtag`, `doclingVersion`, `doclingCoreVersion`.
  - `chunker`: `{class: "HybridChunker", tokenizer: {type, id, charsPerToken?}, maxTokens, mergePeers}`.
  - `chunkConfigHash`, `createdAt`, `chunkCount`, `totalEstimatedTokens`.
  - `chunks[]`: `{index, text, contextualizedText, headings[], pageNumbers[], estimatedTokens}`.
- `chunkConfigHash` = sha256 of `purpose`, the tokenizer type/id/params, `maxTokens`, `mergePeers` and the docling-core version. Any change to the model budget or tokenizer produces a new chunk set; old ones stay valid for their own config.

**Reuse rules** (`src/services/document/document_artifacts.py`)
1. If `chunks/{documentId}/{purpose}-{hash}.json` exists and its `sourceEtag` and Docling versions match, use it. Neither Docling nor HybridChunker runs.
2. Otherwise, if `extracted/{documentId}.docling.json` is valid (metadata matches), load it with `DoclingDocument.load_from_json` (docling-core only) and run HybridChunker. Docling does not run.
3. Otherwise, run Docling, write `.md` and `.docling.json`, then run HybridChunker. This is the only path where Docling runs.
4. Every new extraction also persists **both** chunk sets, `summary` and `qa`, so the Q&A Lambda never chunks.
- Concurrent jobs on the same document may both write identical artifacts. The writes are deterministic and idempotent; only compute is wasted, which is accepted.

**Token budget** (`src/services/llm/token_budget.py`)
- Per-provider env:
  - `BEDROCK_CONTEXT_TOKENS`, `BEDROCK_MAX_OUTPUT_TOKENS`
  - `GROQ_CONTEXT_TOKENS`, `GROQ_MAX_OUTPUT_TOKENS`, and optional `GROQ_TPM_LIMIT`
  - Shared: `LLM_PROMPT_OVERHEAD_TOKENS` (system prompt + style template + user instructions; the actual instruction length is added per job) and `LLM_BUDGET_SAFETY_RATIO` (default 0.85).
- `input_budget(provider) = floor((context − max_output − prompt_overhead − instructions_tokens) × safety_ratio)`. Groq's is additionally capped by its TPM limit when that is set.
- **Effective budget = min(Bedrock budget, Groq budget).** Any request may fall back to Groq mid-job, so every request must fit both providers.
  - **Summary chunk set:** `HybridChunker.max_tokens = effective budget`, optionally lowered by `LLM_CHUNK_TOKENS`.
  - **Q&A chunk set:** `max_tokens = QA_CHUNK_TOKENS` (default about 1/6 of the effective budget, for retrieval granularity).
- Budgets below a minimum (e.g. 1,000) fail at cold start as a config error. No limit is hardcoded; the context-window values are set in env once the model is verified in ap-south-1.
- **Single vs map-reduce:** estimate the tokens of the full Markdown. If they fit the effective budget, make one request with the whole Markdown. Otherwise run map-reduce over the summary chunk set.

**Tokenizer** (`src/services/document/tokenizers.py`)
- HybridChunker takes a docling-core `BaseTokenizer` plus `max_tokens`. Neither Claude nor every Groq model has a public local tokenizer, so `CHUNK_TOKENIZER` selects one:
  - `char_estimate` (default): a small `BaseTokenizer` subclass counting `ceil(len(text) / LLM_CHARS_PER_TOKEN)` (default 4). It matches the agreed 4-chars/token rule and downloads nothing.
  - `huggingface:<repo-id>`: the docling-core `HuggingFaceTokenizer`, e.g. the Groq model's open tokenizer. The tokenizer files are baked into the image at build time, never fetched at runtime.
  - `tiktoken:<encoding>`: the docling-core `OpenAITokenizer`, as a closer proxy if wanted.
- The same tokenizer instance is used for the fit check, chunking and usage estimates, so the numbers stay consistent. The safety ratio absorbs estimate error.
- The `BaseTokenizer` interface (`count_tokens`, `get_max_tokens`, `get_tokenizer`) must be **verified against the pinned docling-core version**.

**Chunking service** (`src/services/document/chunking_service.py`, a thin wrapper)
- `build_chunker(purpose, budget) -> HybridChunker(tokenizer=…, max_tokens=…, merge_peers=True)`.
- `chunk_document(doc, purpose, budget) -> ChunkSet`: iterate `chunker.chunk(dl_doc=doc)`. For each chunk, store `chunk.text`, `chunker.contextualize(chunk)`, `chunk.meta.headings` and the page numbers from `chunk.meta.doc_items[*].prov`, plus the tokenizer count of the contextualized text.
- There is no other splitting or merging logic. HybridChunker's structure-awareness covers headings, section context, tables and captions.
- **LLM requests always send `contextualizedText`,** so each chunk carries its heading and caption context.
- **Oversized chunks:** HybridChunker may emit a chunk over `max_tokens` when it cannot split one item further (e.g. a huge table cell). That chunk is logged with a warning and still sent as long as it fits the provider's *hard* budget (the pre-safety-ratio figure). Otherwise the job fails as `CHUNK_EXCEEDS_MODEL_LIMIT`; it is never truncated. **Verify** this behaviour on a large-table sample during benchmarking.
- **Overlap:** HybridChunker has no overlap option, and the spec says "where appropriate". The summary map stage uses no overlap, because overlap duplicates key points and costs tokens. For Q&A, retrieval returns each selected chunk together with its neighbouring chunk (`index ± 1`) when the budget allows. That gives context continuity at query time without a custom chunker.

**Map-reduce** (`src/services/llm/summary_service.py`)
- **Fits budget:** a single request produces `SummaryResult` directly.
- **Map stage:** each summary-chunk's `contextualizedText` is summarized into a style-neutral intermediate note (section context, facts, figures, action items).
  - The map output is capped via the provider's `max_tokens` parameter, so no single note can exceed the reduce budget.
  - Requests run on a `ThreadPoolExecutor(max_workers=LLM_MAP_CONCURRENCY)`, default 3.
  - Each request uses the full retry → Groq fallback policy.
- **Reduce stage:** if the intermediates fit the reduce budget, one request produces `SummaryResult`, applying the user's style and instructions.
  - Otherwise the reduce is **hierarchical**: pack *whole* intermediate notes greedily into groups that fit the budget (bin-packing whole notes, never splitting document text, so this is not a chunker), reduce each group to a new note, and repeat.
  - The depth is bounded by `LLM_MAX_REDUCE_LEVELS`, default 4; exceeding it is a non-retryable error.
- **Checkpointing:** each map result is stored at `intermediate/{jobId}/{chunkConfigHash}/map-{n}.md`, and an SQS retry reuses completed map results. The `intermediate/` prefix has a 7-day lifecycle expiry.
- The final output is validated by `SummaryResult`, with one re-prompt on failure.
- **Lambda timing:** 900s timeout. If `context.get_remaining_time_in_millis()` drops below a safety margin, the job releases itself back to retry; checkpoints mean no work is lost. `MAX_DOCUMENT_TOKENS` (sized from the benchmark) rejects oversized documents with `DOCUMENT_TOO_LARGE_TO_PROCESS`; it never truncates them.

**Provider attribution and usage tracking**
- `llm_provider`/`llm_model` record the provider of the **final** (single or reduce) call.
- The `summary_jobs.llm_usage` JSON records:
  - `estimatedInputTokens` (document), `tokenizer`, `chunkSetKey`, `chunkCount`, `reduceLevels`, `requestCount`, `retryCount`, `fallbackCount`.
  - Per-provider `{requests, inputTokens, outputTokens}` from actual usage: Bedrock Converse `usage.inputTokens`/`outputTokens`, Groq `usage.prompt_tokens`/`completion_tokens`.
- `GET /summaries/{jobId}` adds a `providersUsed` list. The usage numbers stay internal unless you ask to expose them.
- Docs and logs make no claim of token savings. Chunking adds tokens (contextualized headings, map prompts, intermediate notes, reduce prompts and retries); it does not reduce them.

---

## Task 1: Save spec documentation ✅ (r1–r3)
`agent-os/specs/2026-11-14-1535-documind-backend-api/` contains:
- `plan.md`
- `shape.md`
- `standards.md`
- `references.md`
- `source-spec.md`
- `source-spec-large-docs.md`
- `source-spec-hybrid-chunker.md`

## Task 2: Project foundation (Phase 1)
- `pyproject.toml` (ruff config) plus pinned dependency files:
  - `requirements.txt`, for API Lambdas: `boto3`, `pymysql`, `pydantic`, `python-dotenv` and `groq` (the Q&A Lambda needs the Groq fallback). **No Docling.**
  - `requirements-processing.txt`: adds `docling` and `docling-core[chunking]` for HybridChunker. Optional tokenizer extras are added only if `CHUNK_TOKENIZER` is set to `huggingface:` or `tiktoken:`.
  - `requirements-dev.txt`: `pytest`, `pytest-mock`, `moto[s3,sqs]`, `ruff`.
  - The venv is created via `uv venv --python 3.12`.
- `package.json` with dev deps `serverless@4`, `serverless-offline` and `serverless-offline-sqs`.
- `docker-compose.yml` with two services:
  - `localstack` (S3, SQS), port 4566, with an init hook `docker/localstack/init-aws.sh` that creates the bucket (with CORS for `localhost:3000` and a lifecycle rule on `intermediate/`), the queue and the DLQ with its redrive policy.
  - `mysql:8.4`, port 3306, with a named volume and `database/schema.sql` mounted into `docker-entrypoint-initdb.d`.
- `.env.example` (including the r3 vars: `CHUNK_TOKENIZER`, `LLM_CHARS_PER_TOKEN`, `QA_CHUNK_TOKENS`, `LLM_CHUNK_TOKENS`, the per-provider context/output vars, `LLM_MAP_CONCURRENCY`, `LLM_MAX_REDUCE_LEVELS`, `MAX_DOCUMENT_TOKENS`), `.gitignore` and `src/config/settings.py`. Settings come from Pydantic and env, with an `APP_ENV` switch. The endpoint override applies only when local. Presigned URLs use `S3_PUBLIC_ENDPOINT_URL=http://localhost:4566`.
- Verify: `docker compose up -d`, then `awslocal s3 ls` / `sqs list-queues` and a `mysql` ping.

## Task 3: Storage & database (Phase 2)
- `database/schema.sql` plus `database/migrations/001_initial.sql`. A simple `scripts/migrate.py` applies the files in order and tracks them in a `schema_migrations` table.
  - Tables: `documents`, `summary_jobs` and `summary_questions`, with FKs and indexes on `document_id`, `status`, `job_id` and `created_at`. `result` is a JSON column.
  - Extra columns: `documents.extracted_content_key`, `summary_jobs.llm_usage` (JSON) and `summary_jobs.chunk_count`. r3 adds no new columns; chunk-set keys live in S3 and in `llm_usage.chunkSetKey`.
- Services: `src/services/s3_service.py` (presign PUT, head_object, get/put object, with JSON helpers), `sqs_service.py` and `mysql_service.py` (connection reuse plus `transaction()`).
- Repositories: `document_repository.py`, `summary_repository.py` and `question_repository.py`.

## Task 4: Upload APIs (Phase 3)
- `src/utils/responses.py`, `src/utils/errors.py`, `src/utils/handler.py`. The `@api_handler` decorator parses JSON, maps errors and wraps the envelope.
- `src/services/document/document_validator.py` checks extension, MIME and size. The allowed types are pdf, docx and txt. The size limit is 10 MB; anything larger returns 413.
- `functions/create_upload/handler.py` (201) and `functions/complete_upload/handler.py`. The completion handler uses `head_object` on the DB key and checks that ContentLength ≤ 10 MB and that the content type matches. It then updates the status to `uploaded`. A missing object returns 409 `UPLOAD_NOT_FOUND`.
- Manual check: curl the presigned PUT to localhost:4566.

## Task 5: Async summary jobs (Phase 4)
- `functions/create_summary/handler.py` returns 202. It validates the style enum and caps `instructions` at 2000 chars, then checks the document is `uploaded`. It applies the idempotency key, inserts the job, then publishes.
- `functions/get_summary/handler.py` returns status plus result, provider, model and `providersUsed`.
- `functions/process_summary/handler.py` returns SQS partial batch failures and orchestrates claim → resolve artifacts (reuse rules) → summarize → save. It uses stub extract/LLM until Task 6.
- `serverless.yml` is a single file with stages `local` and `prod`. It defines:
  - httpApi routes and the queue/DLQ/bucket resources (private, block public access, SSE-S3, CORS, and a lifecycle rule expiring `intermediate/` after 7 days).
  - Least-privilege IAM, with per-function roles:
    - Upload functions: `s3:PutObject`/`GetObject` (HeadObject is covered by GetObject) on `documents/*`.
    - `create_summary`: `sqs:SendMessage` on the queue.
    - `ask_question` (r3): `s3:GetObject` on `extracted/*` and `chunks/*`, plus the Bedrock and Secrets permissions below.
    - Processor (r3):
      - `s3:GetObject` on `documents/*`
      - `GetObject`/`PutObject` on `extracted/*`, `chunks/*` and `intermediate/*`
      - `s3:ListBucket` scoped by prefix to `intermediate/*` (for checkpoint discovery)
      - `bedrock:InvokeModel*` on the configured model or inference profile ARN
      - `secretsmanager:GetSecretValue` on the secret
  - `ecr.images.processing` from the Dockerfile, plus `custom.serverless-offline-sqs` pointing at LocalStack.

## Task 6: AI integration (Phase 5) — revised in r3
Files (all new):
- `src/services/document/docling_service.py`:
  - `convert(source_bytes, file_type) -> DoclingDocument` (PDF/DOCX via `DocumentConverter`; TXT via the verified path above)
  - `export_markdown(doc)` and `to_json(doc)` / `from_json(data)`
  - Raises `DocumentExtractionError`.
- `src/services/document/tokenizers.py`: a `CharEstimateTokenizer(BaseTokenizer)` plus a `get_tokenizer(settings)` factory for `char_estimate`, `huggingface:` and `tiktoken:`.
- `src/services/document/chunking_service.py`: the thin HybridChunker wrapper (`build_chunker`, `chunk_document`) and the `ChunkSet` serialization. It contains no custom splitting logic.
- `src/services/document/document_artifacts.py`: the S3 layout, metadata validity checks, the reuse resolution (rules 1–4) and the chunk-config hash.
- `src/schemas/chunks.py`: the `ChunkSet` and `ChunkRecord` Pydantic models.
- `src/services/llm/token_budget.py`: the per-provider budgets, the effective min, and the fit check.
- `src/services/llm/base_llm.py` (the `LLMProvider` protocol returning text plus a usage dict; `RetryableLLMError`, `NonRetryableLLMError`), `bedrock_service.py`, `groq_service.py` and `src/services/llm/fallback.py` (retry/backoff plus the Bedrock→Groq policy shared by summary and Q&A).
- `src/services/llm/summary_service.py`: the single-request or map-reduce flow, prompts per style, hierarchical reduce, bounded concurrency, checkpoints, usage aggregation and `SummaryResult` validation.
- `src/schemas/summary.py`: `SummaryResult`.

Removed from r2:
- `src/services/document/markdown_chunker.py`, and any custom heading, paragraph or sentence splitting.
- The top-level `src/services/docling_service.py` location moves under `services/document/`, matching the spec's §7 suggestion.

The processing image (`docker/processing.Dockerfile`):
- Built on the Lambda python3.12 base.
- Installs `requirements-processing.txt`.
- Pre-downloads the Docling layout/table models at build time (and the HF tokenizer files if configured), with `HF_HOME` and `DOCLING_ARTIFACTS_PATH` set and `HF_HUB_OFFLINE=1` at runtime.
- OCR is off by default.
- Benchmark memory, duration and cold start with the Lambda RIE on small, medium and large PDF/DOCX/TXT samples, including a large-table PDF, before setting the memory (start at 3008 MB) and timeout.

**Blocker to verify (read-only, needs your approval to run):** `aws bedrock list-foundation-models` and `list-inference-profiles --region ap-south-1 --profile document-ai`. These confirm the available Claude model or inference-profile ID, and its context and output limits, before the budget env values are set.

## Task 7: Follow-up questions (Phase 6) — revised in r3
- `functions/ask_question/handler.py` and `src/services/qa_service.py`:
  - Requires a `completed` job, and the question must be 1–1000 chars.
  - **Fit check:** if the Markdown's estimate fits the Q&A budget, the prompt is built from `extracted/{documentId}.md`.
  - **Otherwise:** load `chunks/{documentId}/qa-{hash}.json` and take the BM25 top-K, plus neighbouring chunks, within the budget, using `contextualizedText`.
  - If the Q&A chunk set is missing, return 409 `DOCUMENT_CONTEXT_NOT_READY`. That cannot happen for completed jobs under the reuse rules. There is no chunking fallback in the API.
  - Uses the shared `fallback.py` (Bedrock → Groq), then stores the result in `summary_questions` and returns 200.

## Task 8: Tests & docs (Phase 7)
- Unit tests (`tests/unit/`) use moto for S3/SQS and mocked LLM providers, plus a fake repo or a MySQL test schema. They cover all 16 items in spec §15, including:
  - The fallback matrix: retryable vs non-retryable errors.
  - Duplicate SQS delivery being skipped.
  - Last-attempt failure marking.
  - Partial batch response.
  - **Chunking service (r3):**
    - HybridChunker is constructed with the configured tokenizer and `max_tokens`, and `contextualize()` output is what gets sent to the LLM.
    - Headings and page numbers are captured in `ChunkSet`.
    - Chunking is deterministic for the same document and config.
    - An oversized-chunk warning or `CHUNK_EXCEEDS_MODEL_LIMIT` is raised as appropriate.
    - These tests run on small `DoclingDocument` fixtures (JSON), so they are fast and need no models.
  - **Artifact reuse (r3):**
    - Rule 1 skips Docling and the chunker.
    - Rule 2 skips Docling only.
    - Rule 3 runs both, and a config-hash change triggers re-chunking without Docling.
    - An ETag or Docling-version mismatch triggers re-extraction.
    - The original document is never written to.
  - Token budget: the min across providers, instruction tokens counted, and rejection of an invalid config.
  - The `CharEstimateTokenizer` interface contract.
  - Map-reduce: the single-request path, a ~40k-token fixture producing multiple map calls plus a reduce, hierarchical reduce, the concurrency cap, per-chunk fallback, checkpoint reuse on retry, and usage aggregation.
  - Q&A: the whole-document path, the top-K plus neighbours path, the missing-chunk-set 409, and that `docling` is never imported in the API package (an import guard test).
- Integration tests (`tests/integration/`, marker `integration`) run against LocalStack and the local MySQL. They cover the full upload → complete → summarize → process flow with a stubbed LLM, plus a real Docling + HybridChunker pass on sample PDF, DOCX and TXT files (marker `docling`, run inside the processing image). Real Bedrock/Groq tests are behind a `live_llm` marker and are skipped by default.
- `README.md` covers:
  - Prerequisites, plus local start/stop/reset (`docker compose down -v`).
  - Migrations, running offline, and the test commands.
  - The S3 artifact layout and reuse rules, and the chunking/token-budget configuration.
  - Deployment with the `AWS_PROFILE=document-ai` `aws sso login` flow and `serverless deploy --stage prod`, only after approval.
  - The route list, required AWS resources and IAM permissions, and known limitations.

## Verification
1. `docker compose up -d` → LocalStack health at `localhost:4566/_localstack/health`, and the MySQL tables exist.
2. `npx serverless offline --stage local` → `POST /uploads` → curl PUT the file to the presigned URL → `POST /documents/{id}/complete` → `POST /summaries` returns 202 → serverless-offline-sqs triggers the processor → poll `GET /summaries/{jobId}` until `completed` → `POST /summaries/{jobId}/questions`.
3. S3 contains `extracted/{id}.md`, `extracted/{id}.docling.json`, `chunks/{id}/summary-*.json` and `chunks/{id}/qa-*.json`. A second `POST /summaries` on the same document logs "artifact reuse: rule 1" and runs no Docling or HybridChunker.
4. `pytest -m "not integration and not live_llm and not docling"` passes, `pytest -m integration` passes with the services up, and `ruff check .` is clean.
5. Build the processing image and invoke it via RIE with sample PDF, DOCX and TXT files, recording memory, duration, chunk counts and oversized-chunk warnings.
6. No AWS deploy or resource creation without explicit approval. The `nearsite` profile is never used.

## Blockers / open items
- Serverless v4 requires `serverless login` (you run `! npx serverless login`).
- Bedrock Claude model or inference-profile availability in ap-south-1 (and its context and output limits) must be verified, and model access granted.
- A Groq API key is needed for fallback tests (local `.env` only). The Groq model's context window and TPM limit are needed for its budget.
- **r3 verification items** (at the start of Task 6, against the pinned versions):
  - The docling-core `BaseTokenizer` interface.
  - HybridChunker's behaviour on items it cannot split.
  - Whether Docling ingests TXT natively.
  - The `chunk.meta` fields available for page numbers.
- Production MySQL hosting (RDS? VPC/NAT implications for Lambda reaching Bedrock and SQS) is not specified. The spec will assume the DB endpoint is provided via Secrets Manager and flag VPC networking as a deploy-time decision.
