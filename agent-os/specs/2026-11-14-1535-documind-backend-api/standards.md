# Standards for DocuMind AI Backend API

`agent-os/standards/index.yml` was empty at shaping time, so no project standards apply yet. The rules below come from the source spec (§13–14, §17) and act as working standards for this work. If they prove durable, consider promoting them with `/agent-os:discover-standards`.

---

## api/response-format

Success:

```json
{ "success": true, "data": {}, "message": "Operation completed successfully" }
```

Error:

```json
{ "success": false, "error": { "code": "DOCUMENT_NOT_FOUND", "message": "The requested document was not found" } }
```

## api/status-codes

| Code | Use |
|---|---|
| 200 | Successful retrieval or operation |
| 201 | Resource created (e.g. upload URL issued) |
| 202 | Async summary job accepted |
| 400 | Invalid request |
| 404 | Missing resource |
| 409 | Conflicting operation (e.g. document not uploaded, job not completed) |
| 413 | File over 10 MB |
| 500 | Unexpected server error |
| 503 | Dependency unavailable (e.g. SQS publish failed) |

Never expose stack traces, SQL errors, AWS credentials or secrets to clients.

## security/validation

- S3 buckets stay private. Presigned URLs are short-lived (900s).
- Validate extension, content type and actual size, and verify that the S3 object exists before confirming an upload.
- Never trust client-provided S3 keys. The key always comes from server-side metadata.
- Use parameterized SQL only.
- Keep the Groq key and DB credentials on the backend (`.env` locally, Secrets Manager in prod). Use Lambda IAM roles in AWS.
- Validate all API inputs.
- Design for ownership checks (`user_id`) once auth exists.
- Do not log document contents or secrets.

## architecture/constraints

- The backend is Python only. Node is used only for Serverless tooling. No DynamoDB, Prisma, Express or MySQL2.
- Upload and summarization are separate operations. Never summarize during upload.
- `documentId`, `jobId` and `s3Key` are distinct identifiers.
- API handlers stay lightweight. Docling and the LLM summary run only in the processing Lambda.
- Use least-privilege IAM.
- Keep local and production config separate.

## document-processing/chunking (r3)

- All document chunking goes through Docling `HybridChunker` (`src/services/document/chunking_service.py`). Do not write custom heading-, paragraph-, sentence- or character-based splitters. Bin-packing *whole* intermediate summaries for hierarchical reduce is allowed; it never splits document text.
- LLM requests use `chunker.contextualize(chunk)`, never the bare `chunk.text`.
- The chunker's `max_tokens` comes from `token_budget.py` (the min across fallback-eligible providers). Never hardcode a token limit.
- Never truncate a document to fit a context window. Chunk it, retrieve from it, or reject it with an explicit error.
- Chunk sets are persisted to S3 with config-hash keys and reused. Docling runs only when no valid Docling JSON exists.
- API Lambdas must not import `docling` or `docling_core`; only the processing image does.
- Never modify or delete the original upload.
- Never claim token savings from chunking.
