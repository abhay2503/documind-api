# Contract between DocuMind API (Node) and the Python AI worker

## SQS message (published by the API on `POST /summaries`)

```json
{ "jobId": "job_<uuid>", "documentId": "doc_<uuid>" }
```

There is no document content in the message. The worker reads the style, instructions and S3 key from MySQL. The API may, rarely, publish the same job twice (recovery republish), so **the worker must be idempotent**: it claims the job with a conditional status update and skips the job if it is already `completed` or actively processing.

## Tables (owned and migrated by the API repo, `database/migrations`)

- `documents`: the worker reads `document_id`, `file_name`, `content_type`, `s3_key`. It may write `extracted_content_key` (an optional extra column, added by a later migration if needed).
- `summary_jobs`: the worker reads `job_id`, `document_id`, `summary_style`, `instructions`.

### Columns the worker writes on `summary_jobs`

| Column | Values / notes |
|---|---|
| `status` | `queued` → `processing` → `completed` \| `failed` |
| `stage` | optional progress hint: `preparing`, `extracting`, `structuring`, `analyzing`, `generating`, `finalizing` |
| `started_at` / `completed_at` | `DATETIME(3)` UTC |
| `result` | JSON, see below; set in the same transaction as `status='completed'` |
| `llm_provider`, `llm_model` | provider and model of the final call |
| `llm_usage` | JSON usage/cost details (internal) |
| `extracted_content_key` | S3 key of the extracted Markdown |
| `error_code`, `error_message` | on failure. `error_message` must be user-safe, because the API returns it as `error`. |
| `retry_count` | incremented per processing attempt |

### `result` JSON shape

```json
{
  "overview": "string",
  "keyPoints": ["string"],
  "findings": [{ "title": "string", "detail": "string" }],
  "actionItems": ["string"]
}
```

The API adds `documentName`, `style` and `generatedAt` when it returns the result to the frontend.

## Style values (DB)
`concise`, `detailed`, `bullet_points`, `key_insights`

## S3
Originals are stored at `documents/{documentId}/{fileName}` in the bucket from the API stack output. The worker needs `s3:GetObject` on `documents/*`, plus whatever it needs under its own prefixes (`extracted/*`, `chunks/*`, `intermediate/*`).
