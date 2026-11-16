# DocuMind AI — Backend API Development Specification

> Source requirements as provided by the user on 2026-11-14. Kept verbatim for traceability; see `plan.md` and `shape.md` for shaped decisions.

## 1. Project Overview

We are building the backend API for **DocuMind AI**, an AI-powered document summarization application.

The frontend is a separate Next.js application. This repository must contain only the backend/API, Python Lambda functions, document-processing logic, infrastructure configuration, and related services.

The application allows users to:

1. Upload PDF, DOCX, and TXT documents.
2. Store uploaded documents in Amazon S3.
3. Select a summary style and optionally provide custom instructions.
4. Request AI-generated summaries.
5. Process documents asynchronously using Docling and an LLM.
6. Retrieve summary results and processing status.
7. Ask follow-up questions about the processed document.

### Important architecture decisions

- Backend language: Python.
- Runtime: AWS Lambda.
- Infrastructure: Serverless Framework.
- Local API development: Serverless Offline.
- Local AWS service emulation: LocalStack.
- Database: MySQL.
- Database access: Python MySQL driver with parameterized SQL queries.
- File storage: Amazon S3.
- Background processing: Amazon SQS.
- Document parsing: Docling.
- Primary LLM: Amazon Bedrock (Claude).
- Fallback LLM: Groq.
- Production deployment region: ap-south-1 (Mumbai).
- Production processing: AWS Lambda container image for the document-processing function.

Important: MySQL2 is a Node.js library. Since this backend is Python, use PyMySQL or another suitable Python MySQL driver instead. Do not introduce Node.js backend code.

---

## 2. High-Level Architecture

The application uses asynchronous document processing.

### Services

| Component | Technology | Responsibility |
|---|---|---|
| API | API Gateway + Python Lambda | Handle HTTP requests |
| Local API | Serverless Offline | Run API endpoints locally |
| Document storage | S3 | Store uploaded files |
| Background queue | SQS | Queue summary-processing jobs |
| Database | MySQL | Store documents, jobs, results and history |
| Document parser | Docling | Extract structured content |
| Primary AI | Amazon Bedrock Claude | Generate summaries |
| Fallback AI | Groq | Generate summaries if Bedrock has recoverable failures |
| Local AWS services | LocalStack | Emulate S3 and SQS locally |
| Local database | MySQL Docker container | Run MySQL locally |

### Expected processing workflow

1. User uploads a document.
2. API generates a document ID and presigned S3 upload URL.
3. Frontend uploads the file directly to S3.
4. Frontend confirms upload completion through the API.
5. API verifies the uploaded S3 object and saves document metadata in MySQL.
6. User selects a summary style and optionally enters custom instructions.
7. User clicks Generate Summary.
8. API creates a separate job ID and saves the job in MySQL with `queued` status.
9. API sends the job ID to SQS.
10. API immediately returns the job ID to the frontend.
11. Processing Lambda receives the SQS message.
12. Processing Lambda retrieves the document from S3.
13. Docling extracts the document content.
14. Summary Service sends the extracted content to Bedrock.
15. If Bedrock encounters a recoverable failure after bounded retries, Groq is used as a fallback.
16. Generated summary is validated and stored in MySQL.
17. Job status is updated to `completed`.
18. Frontend polls the API to retrieve job status and results.

Do not perform AI processing during document upload.

Uploading a document and generating a summary must remain two separate operations.

---

## 3. API Routes

Implement the following REST API endpoints.

### A. Generate document upload URL

`POST /uploads`

Purpose:
- Generate a unique document ID.
- Generate an S3 object key.
- Generate a presigned S3 PUT URL.
- Return the upload URL and document ID.

Example request:

```json
{
  "fileName": "invoice.pdf",
  "contentType": "application/pdf",
  "fileSize": 2048000
}
```

Example response:

```json
{
  "documentId": "doc_123",
  "uploadUrl": "https://example-presigned-url",
  "s3Key": "documents/doc_123/invoice.pdf",
  "expiresIn": 900
}
```

Requirements:
- Support PDF, DOCX and TXT.
- Maximum upload size: 10 MB.
- Validate extension, content type and file size.
- Use a private S3 bucket.
- Never expose AWS credentials to the frontend.
- Use short-lived presigned URLs.

### B. Confirm document upload

`POST /documents/{documentId}/complete`

Purpose:
- Verify that the uploaded object exists in S3.
- Validate the actual object metadata and size.
- Save document metadata in MySQL.
- Mark the document as uploaded.

Example response:

```json
{
  "documentId": "doc_123",
  "status": "uploaded",
  "fileName": "invoice.pdf"
}
```

Do not trust a client-provided S3 key. Retrieve the expected key from server-side document metadata.

### C. Create summary job

`POST /summaries`

Purpose:
- Create a new summary-processing job.
- Save the job in MySQL.
- Send a message to SQS.
- Return immediately without processing the document.

Example request:

```json
{
  "documentId": "doc_123",
  "style": "detailed",
  "instructions": "Focus on financial information"
}
```

Supported summary styles:
- concise
- detailed
- bullet_points
- key_insights

Example response:

```json
{
  "jobId": "job_789",
  "documentId": "doc_123",
  "status": "queued"
}
```

Requirements:
- Verify that the document exists and is uploaded.
- Generate a new job ID for each summary request.
- Save the job in MySQL before publishing to SQS.
- Use a reliable publishing strategy so a failed SQS publish does not leave a permanently queued job.
- Use idempotency where appropriate.
- Do not invoke Docling or Bedrock from this API handler.

### D. Get summary job status and result

`GET /summaries/{jobId}`

Purpose:
- Retrieve the summary job and its current status.
- Return the result when processing is completed.

Possible statuses:
- queued
- processing
- completed
- failed

Example response while processing:

```json
{
  "jobId": "job_789",
  "status": "processing",
  "result": null
}
```

Example completed response:

```json
{
  "jobId": "job_789",
  "status": "completed",
  "documentId": "doc_123",
  "provider": "bedrock",
  "model": "configured-model-id",
  "result": {
    "overview": "Document overview...",
    "keyPoints": [],
    "findings": [],
    "actionItems": []
  }
}
```

### E. Ask a question about a summary

`POST /summaries/{jobId}/questions`

Purpose:
- Accept follow-up questions about the processed document.
- Retrieve the document's extracted content or stored context.
- Generate an answer using the configured LLM service.
- Return the answer.

Example request:

```json
{
  "question": "What are the important financial figures?"
}
```

Example response:

```json
{
  "jobId": "job_789",
  "question": "What are the important financial figures?",
  "answer": "The document mentions..."
}
```

Requirements:
- Only allow questions for completed jobs.
- Keep the question-answering functionality grounded in the relevant document.
- Do not send unrelated documents or user data to the LLM.
- Consider storing conversation history in a separate table if required.

---

## 4. MySQL Database Design

Use MySQL as the application's primary database.

Start with the following tables.

### documents

Suggested columns:

- id
- document_id (unique)
- user_id (nullable initially if authentication is not yet implemented)
- file_name
- content_type
- file_size
- s3_key
- status
- created_at
- updated_at

### summary_jobs

Suggested columns:

- id
- job_id (unique)
- document_id
- status
- summary_style
- instructions
- result (JSON)
- extracted_content_key (nullable, if extracted content is stored in S3)
- llm_provider
- llm_model
- error_message
- retry_count
- created_at
- started_at
- completed_at
- updated_at

### summary_questions

Suggested columns:

- id
- job_id
- question
- answer
- llm_provider
- created_at

Requirements:
- Create SQL schema/migration files.
- Add appropriate indexes and foreign keys.
- Use parameterized queries.
- Use connection management suitable for Lambda.
- Avoid opening a new database connection for every individual query.
- Reuse connections safely where appropriate.
- Use transactions for operations that update multiple related records.
- Do not store large original documents in MySQL; keep them in S3.
- Store summary results as JSON.

Do not introduce DynamoDB. MySQL is the selected database.

---

## 5. SQS Background Processing

Use SQS to decouple API requests from expensive document-processing operations.

### Queue message

Use a simple message containing identifiers, not the complete document content.

Example:

```json
{
  "jobId": "job_789",
  "documentId": "doc_123"
}
```

### Processing Lambda responsibilities

1. Receive the SQS message.
2. Retrieve the job and document metadata from MySQL.
3. Update job status to `processing`.
4. Download the original document from S3.
5. Extract its content with Docling.
6. Generate the summary using the LLM service.
7. Validate the summary response.
8. Save the result in MySQL.
9. Update the job status to `completed`.
10. Handle errors and allow configured SQS retries.

### Reliability requirements

- Configure an SQS visibility timeout greater than the processing Lambda timeout.
- Configure a Dead Letter Queue.
- Configure maximum receive count.
- Make processing idempotent.
- Avoid duplicate summary records if a message is delivered more than once.
- Handle partial batch failures correctly if using batch processing.
- Do not mark a job completed before the result is successfully saved.
- Do not silently swallow processing errors.

Use separate API and processing Lambda functions.

The processing function should be packaged as a Lambda container image because Docling dependencies can be large.

---

## 6. LLM Integration: Bedrock Primary + Groq Fallback

Implement a provider-independent LLM service.

Suggested structure:

```text
services/
  llm/
    base_llm.py
    bedrock.service.py
    groq.service.py
    summary.service.py
```

### Bedrock

- Use Amazon Bedrock as the primary provider.
- Use boto3 for AWS Bedrock Runtime calls.
- Configure the model ID through environment variables.
- Verify actual model and inference-profile availability in ap-south-1.
- Do not hardcode an assumed model ID.

### Groq

- Use Groq as the fallback provider.
- Use the official Groq Python SDK.
- Store the Groq API key securely.
- Configure the Groq model ID through environment variables.

### Fallback rules

1. Attempt Bedrock first.
2. Retry transient failures with bounded exponential backoff and jitter.
3. If Bedrock still fails due to throttling, temporary unavailability or model overload, attempt Groq.
4. Do not fall back for invalid requests, invalid model IDs, permission errors or authentication/configuration failures.
5. If Groq also fails, report the processing failure and let SQS retry according to its configured policy.
6. Validate both providers' responses against the same output schema.

Store the actual provider and model used for each completed summary in MySQL.

Do not implement automatic provider switching for every error.

---

## 7. Docling Integration

Use Docling in Python for document extraction.

Responsibilities:
- Process PDF.
- Process DOCX.
- Process TXT.
- Convert documents into structured Markdown or text.
- Preserve useful document structure such as headings and tables where possible.
- Handle unsupported, corrupted or empty documents gracefully.

Suggested structure:

```text
services/
  document/
    docling.service.py
    document_validator.py
```

The document-processing Lambda must use a Docker/Lambda container image.

Benchmark actual memory consumption, processing time and cold starts before choosing Lambda memory and timeout settings.

For large extracted content:
- Do not blindly send the entire document in a single prompt.
- Implement appropriate chunking and summarization if required.
- Respect model context limits.
- Preserve relevant context when generating summaries.
- Avoid storing unnecessarily large extracted text directly in MySQL.

---

## 8. Local Development Setup

We want to develop and test the backend locally without depending on live AWS S3 and SQS for every run.

### Serverless Offline

Use Serverless Offline to run the HTTP API locally.

### LocalStack

Use LocalStack for:
- S3
- SQS
- Lambda/SQS event-source integration where supported.

### MySQL

Use a separate MySQL Docker container.

LocalStack does not replace MySQL.

### Docker Compose

Create a docker-compose.yml to run:
- LocalStack
- MySQL

Configure persistent local volumes where useful.

Local API configuration should use:
- Serverless Offline for HTTP endpoints.
- LocalStack endpoints for S3 and SQS.
- Local MySQL for application records.
- Real Bedrock only for intentional AI integration tests.
- Mock LLM responses for normal unit tests.

Make sure browser-accessible S3 presigned URLs use localhost rather than an internal Docker hostname.

Document how to start, stop and reset local services.

---

## 9. Dependencies

Install only the dependencies required by the implementation.

Suggested Python dependencies:

```text
boto3
pymysql
pydantic
python-dotenv
docling
groq
```

Add other dependencies only when justified by the implementation, such as:
- PyMySQL pooling support or a suitable connection manager.
- AWS SDK support already provided by boto3.
- Test dependencies such as pytest and pytest-mock.
- HTTP validation or serialization libraries if required.

Use pinned or bounded dependency versions and maintain a reproducible requirements file.

### Development tools

- Python virtual environment.
- Serverless Framework.
- Serverless Offline plugin.
- Docker and Docker Compose.
- LocalStack.
- MySQL Docker image.
- pytest.
- Ruff or an equivalent Python linter/formatter.

Serverless Framework and its plugins are Node.js-based development tooling; this does not mean the application backend should use Node.js.

Do not install Prisma, DynamoDB dependencies, Express, or unnecessary frameworks.

---

## 10. Serverless Framework Configuration

Create a serverless.yml defining:

- Python Lambda runtime.
- API Gateway HTTP endpoints.
- Separate Lambda handlers for each API route where appropriate.
- Separate SQS processing Lambda.
- SQS queue and DLQ.
- SQS event-source mapping.
- S3 bucket configuration.
- Appropriate IAM permissions.
- Environment variables.
- Lambda container image configuration for document processing.
- Local development configuration for Serverless Offline and LocalStack.

Keep infrastructure definitions reusable between local and AWS deployment wherever practical.

Use least-privilege IAM permissions.

Do not create or modify any resources in the company AWS account.

Use the personal AWS CLI profile `document-ai` for AWS deployment and integration testing.

AWS region: `ap-south-1`.

Use AWS SSO credentials; do not introduce long-lived AWS access keys.

---

## 11. Environment Variables

Create `.env.example` with placeholders only.

Expected variables:

```env
APP_ENV=local
AWS_REGION=ap-south-1

AWS_ENDPOINT_URL=http://localhost:4566

S3_BUCKET=documind-documents
SQS_QUEUE_URL=http://localhost:4566/000000000000/documind-summary-queue

DB_HOST=localhost
DB_PORT=3306
DB_NAME=documind
DB_USER=documind
DB_PASSWORD=

BEDROCK_MODEL_ID=
GROQ_API_KEY=
GROQ_MODEL_ID=
```

Use separate local and production configuration.

In production:
- Remove LocalStack endpoint overrides.
- Use actual AWS resource names.
- Use Lambda IAM roles for AWS service access.
- Use AWS Secrets Manager or another suitable secure mechanism for database and Groq credentials.
- Never commit actual credentials.

---

## 12. Suggested Backend Folder Structure

```text
api/
│
├── src/
│   ├── functions/
│   │   ├── create_upload/
│   │   ├── complete_upload/
│   │   ├── create_summary/
│   │   ├── get_summary/
│   │   ├── ask_question/
│   │   └── process_summary/
│   │
│   ├── services/
│   │   ├── s3_service.py
│   │   ├── sqs_service.py
│   │   ├── mysql_service.py
│   │   ├── docling_service.py
│   │   └── llm/
│   │       ├── base_llm.py
│   │       ├── bedrock_service.py
│   │       ├── groq_service.py
│   │       └── summary_service.py
│   │
│   ├── repositories/
│   │   ├── document_repository.py
│   │   ├── summary_repository.py
│   │   └── question_repository.py
│   │
│   ├── models/
│   ├── schemas/
│   ├── utils/
│   └── config/
│
├── database/
│   ├── migrations/
│   └── schema.sql
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── docker/
│   └── processing.Dockerfile
│
├── docker-compose.yml
├── serverless.yml
├── requirements.txt
├── requirements-dev.txt
├── .env.example
├── .gitignore
└── README.md
```

You may adjust this structure if a simpler or more maintainable structure is justified. Avoid unnecessary abstraction.

---

## 13. API Response and Error Handling

Use consistent JSON responses.

Success:

```json
{
  "success": true,
  "data": {},
  "message": "Operation completed successfully"
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "The requested document was not found"
  }
}
```

Use appropriate HTTP status codes:
- 200 for successful retrieval or operations.
- 201 for successful resource creation where appropriate.
- 202 for accepted asynchronous summary jobs.
- 400 for invalid requests.
- 404 for missing resources.
- 409 for conflicting operations.
- 413 for oversized files.
- 500 for unexpected server errors.
- 503 for unavailable dependencies where appropriate.

Do not expose stack traces, AWS credentials, SQL errors or internal secrets to clients.

---

## 14. Security and Validation

- Keep S3 buckets private.
- Use presigned URLs with limited expiry.
- Validate actual file size and file type.
- Verify S3 object existence before confirming upload.
- Never trust client-provided S3 keys.
- Use parameterized SQL queries.
- Keep Groq API credentials on the backend.
- Use Lambda IAM roles in AWS.
- Validate all API inputs.
- Ensure job and document ownership checks are included when authentication is introduced.
- Avoid exposing documents or summaries across users.
- Do not log document contents or secrets.

Authentication is not yet finalized. Keep the API design ready for future authentication, but do not invent a new authentication provider or make the frontend integration depend on an unapproved authentication implementation.

---

## 15. Testing Requirements

Implement tests for:

1. Upload URL generation.
2. File type and file size validation.
3. S3 upload completion verification.
4. Document metadata persistence.
5. Summary job creation.
6. SQS message publishing.
7. SQS processing.
8. Docling extraction.
9. Bedrock summary generation.
10. Groq fallback behavior.
11. LLM output validation.
12. MySQL result persistence.
13. Job status retrieval.
14. Follow-up questions.
15. Retry and DLQ behavior.
16. Duplicate SQS message handling.

Use mocked LLM responses for unit tests.

Use LocalStack and local MySQL for integration tests.

Run intentional real Bedrock/Groq integration tests separately to avoid unnecessary API costs.

---

## 16. Implementation Instructions

Follow this implementation order:

### Phase 1 — Project foundation
- Inspect the current repository before making changes.
- Set up Python project structure.
- Configure virtual environment and dependencies.
- Configure Serverless Framework.
- Configure Serverless Offline.
- Set up Docker Compose with LocalStack and MySQL.
- Verify local services are accessible.

### Phase 2 — Storage and database
- Create local S3 bucket.
- Create local SQS queue and DLQ.
- Create MySQL schema and migrations.
- Implement S3 and MySQL service layers.

### Phase 3 — Upload APIs
- Implement `POST /uploads`.
- Implement `POST /documents/{documentId}/complete`.
- Test direct frontend-compatible S3 presigned uploads.

### Phase 4 — Asynchronous summary jobs
- Implement `POST /summaries`.
- Implement SQS publishing.
- Implement `GET /summaries/{jobId}`.
- Implement SQS-triggered processing Lambda.

### Phase 5 — AI integration
- Integrate Docling.
- Implement the common LLM interface.
- Integrate Bedrock.
- Implement Groq fallback.
- Validate and persist structured summaries.

### Phase 6 — Follow-up questions
- Implement `POST /summaries/{jobId}/questions`.
- Ground answers in the corresponding document.

### Phase 7 — Testing and documentation
- Add unit and integration tests.
- Test complete upload-to-summary workflow.
- Document local setup and deployment.
- Verify production configuration.

---

## 17. Important Development Constraints

1. This is a separate backend repository. Do not modify the existing Next.js frontend repository.
2. Do not introduce DynamoDB. MySQL is our chosen database.
3. Do not use Node.js or Express for application Lambda functions.
4. Do not use MySQL2; use a suitable Python MySQL driver.
5. Do not generate summaries automatically during upload.
6. Generate summaries only after the user explicitly clicks Generate Summary.
7. Keep `documentId`, `jobId`, and `s3Key` separate.
8. Keep API handlers lightweight.
9. Run expensive Docling and LLM operations in the processing Lambda.
10. Use SQS for background processing.
11. Use Bedrock as primary and Groq as fallback.
12. Do not expose credentials in frontend code or Git.
13. Do not assume an unverified Bedrock model ID.
14. Do not deploy resources to AWS without first getting explicit approval.
15. Do not modify global AWS CLI, Git or SSH configuration.
16. Do not modify the existing company AWS profile or company resources.
17. Preserve a clear separation between local development and production configuration.
18. Do not add unnecessary services or dependencies.

## 18. Expected Deliverables

At the end of implementation, provide:

- Complete Python backend source code.
- Serverless Framework configuration.
- LocalStack and MySQL Docker Compose configuration.
- MySQL schema and migration files.
- All API Lambda handlers.
- SQS processing Lambda.
- S3, SQS and MySQL service implementations.
- Docling integration.
- Bedrock and Groq integrations.
- Unit and integration tests.
- `.env.example`.
- A detailed README explaining setup, running locally, testing and AWS deployment.
- A list of implemented routes.
- A list of required AWS resources and IAM permissions.
- Any remaining limitations or configuration steps.

**First inspect the repository and existing environment. Then implement in phases. Do not blindly create everything in one step. Report the initial plan and any important blockers before making major changes.**
