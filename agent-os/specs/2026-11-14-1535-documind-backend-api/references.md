# References for DocuMind AI Backend API

## Similar Implementations

None. The `api/` repository was empty at shaping time, and the frontend in `../ui` is intentionally not used as a reference. The pasted spec (`source-spec.md`) is the API contract.

## External documentation to consult during implementation

These docs should be checked, not assumed:
- **Docling HybridChunker (r3):** `docling.chunking.HybridChunker` / `docling_core.transforms.chunker.hybrid_chunker`. Check:
  - the constructor args (`tokenizer`, `max_tokens`, `merge_peers`)
  - `chunk(dl_doc=…)` and `contextualize(chunk)`
  - the `chunk.meta.headings` and `doc_items[*].prov` page numbers
  - the tokenizer classes `BaseTokenizer`, `HuggingFaceTokenizer` and `OpenAITokenizer`
  - the behaviour when a single item exceeds `max_tokens`
  - `DoclingDocument.save_as_json` / `load_from_json` and `export_to_markdown`

  *Record the verified versions and findings here at the start of Task 6.*
- **Docling:** the `DocumentConverter` API, supported input formats (confirm whether plain TXT is accepted natively; otherwise build the `DoclingDocument` via docling-core), model artifact pre-download for container builds, and OCR options.
- **Amazon Bedrock Runtime Converse API:** request and response shapes, error codes (`ThrottlingException`, `ServiceUnavailableException`, `ModelNotReadyException`, `ModelTimeoutException`, `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException`), and cross-region inference profiles for ap-south-1.
- **Groq Python SDK:** chat completions, JSON mode, and exception classes (`RateLimitError`, `APIConnectionError`, `InternalServerError`, `AuthenticationError`).
- **Serverless Framework v4:** `provider.ecr.images`, `httpApi` events, SQS events with `functionResponseType`, and stage params.
- **serverless-offline / serverless-offline-sqs:** LocalStack endpoint configuration.
- **AWS Lambda + SQS:** partial batch responses, and visibility timeout guidance (≥6× the function timeout).
- **LocalStack:** init hooks (`/etc/localstack/init/ready.d`) and S3 CORS for browser presigned PUTs.
