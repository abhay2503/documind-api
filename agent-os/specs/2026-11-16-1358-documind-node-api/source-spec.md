# DocuMind API — Architecture & Implementation Instructions

> Source requirements as provided by the user on 2026-11-16. Kept verbatim; shaped decisions are in `plan.md` / `shape.md`.

## 1. Project Overview

Build the backend API for DocuMind AI as an independent Node.js + TypeScript project.

**Repository:** `documind-api`

The API will handle frontend-facing operations, authentication, document uploads, database operations, and asynchronous job management.

AI processing will be handled by a separate Python project. Do not implement AI processing inside this repository.

## 2. Technology Stack

- Node.js
- TypeScript
- Serverless Framework
- AWS Lambda
- Amazon API Gateway
- MySQL using `mysql2`
- AWS SDK for JavaScript
- Amazon S3
- Amazon SQS

Use a clean, maintainable project structure with reusable utilities, database modules, services, handlers, and configuration.

## 3. AWS Infrastructure

Use AWS region `ap-south-1`.

The API project will use:

- **AWS Lambda:** Execute Node.js API handlers.
- **API Gateway:** Expose HTTP endpoints.
- **Amazon S3:** Store uploaded documents.
- **Amazon SQS:** Send summary-processing jobs to the Python AI worker.
- **MySQL:** Store document metadata, processing jobs, and summary results.

Do not introduce unnecessary AWS services.

## 4. Environment Configuration

Keep credential management simple. Follow the `.env` and `.env.prod` approach used in our existing project.

### Local development

Use:

`documind-api/.env`

### Production deployment

Use:

`documind-api/.env.prod`

Production deployment should load `.env.prod` and inject the configured values into Lambda environment variables through Serverless Framework.

Access environment variables through `process.env`.

Example:

```env
NODE_ENV=development

AWS_REGION=ap-south-1

DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=

S3_BUCKET_NAME=
SQS_QUEUE_URL=
```

Additional configuration can be introduced when required.

Rules:
- Add `.env` and `.env.prod` to `.gitignore`.
- Maintain `.env.example` with placeholder values.
- Never hardcode credentials in source code.
- Do not introduce AWS Secrets Manager for this initial implementation.
- Use Lambda IAM execution roles for AWS service access instead of storing AWS access keys.
- Do not modify global AWS configuration.

## 5. Database

Use MySQL with `mysql2`.

Do not use Prisma or introduce an ORM.

Responsibilities:
- Manage database connections efficiently in Lambda.
- Use parameterized queries.
- Keep database queries separate from business logic.
- Handle connection failures and cleanup appropriately.
- Use transactions where multiple related database operations must succeed together.

The database will store:

- Document metadata
- S3 object keys
- Summary processing jobs
- Job statuses
- Summary results

Design the schema to support future document-related features without implementing them now.

## 6. Document Upload Flow

Uploading a document must NOT automatically start AI processing.

### Flow

1. Frontend calls `POST /uploads`.
2. API validates the request.
3. API generates a unique `documentId`.
4. API generates an S3 object key.
5. API generates a presigned S3 PUT URL.
6. API returns the upload URL and document information.
7. Frontend uploads the document directly to S3.
8. Frontend calls `POST /documents/{documentId}/complete`.
9. API verifies that the S3 object exists.
10. API saves document metadata in MySQL.

At this point, the document is uploaded and ready for processing.

**Important:** Do not publish an SQS message during document upload or completion.

## 7. Summary Generation Flow

Processing starts only when the user explicitly clicks **Generate Summary**.

### Flow

1. Frontend calls `POST /summaries`.
2. Request includes `documentId` and selected summary style.
3. API validates the document and requested style.
4. API generates a unique `jobId`.
5. API creates a job record in MySQL with `queued` status.
6. API publishes a message to SQS:

```json
{
  "jobId": "job_789",
  "documentId": "doc_123"
}
```

7. API immediately returns the `jobId` and queued status.

The Python AI worker will consume this message separately.

**Important:**
- The API must not process documents or call LLMs.
- Do not send document content through SQS.
- Only send identifiers and the minimum required processing metadata.
- Do not make synchronous HTTP requests to the Python worker for summary generation.

## 8. API Endpoints

Implement these frontend-facing endpoints:

| Method | Endpoint | Responsibility |
|---|---|---|
| POST | `/uploads` | Generate presigned S3 upload URL |
| POST | `/documents/{documentId}/complete` | Verify upload and save metadata |
| POST | `/summaries` | Create job and publish SQS message |
| GET | `/summaries/{jobId}` | Retrieve job status and summary result |

Keep API validation, business logic, database operations, and AWS integrations properly separated.

## 9. Job Status Management

Support the following statuses:

- `queued`
- `processing`
- `completed`
- `failed`

The API creates jobs with `queued` status.

The Python worker will be responsible for updating processing status and saving the generated summary.

The API should retrieve and return the latest status and result from MySQL.

## 10. Error Handling and Reliability

Implement:

- Centralized error handling.
- Request validation.
- Consistent API response formats.
- Structured logging.
- Appropriate HTTP status codes.
- Database connection handling.
- S3 upload verification.
- SQS publishing error handling.
- Protection against duplicate job creation where appropriate.

Ensure that a job is not left permanently queued if publishing to SQS fails.

Consider a reliable publishing/recovery mechanism without introducing unnecessary infrastructure.

## 11. Project Structure

Use a modular structure similar to:

```text
documind-api/
├── src/
│   ├── handlers/
│   ├── services/
│   ├── repositories/
│   ├── database/
│   ├── middleware/
│   ├── utils/
│   ├── types/
│   └── config/
├── serverless.yml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

Adjust the structure if there is a strong architectural reason, but avoid unnecessary abstractions.

## 12. Deployment

Use Serverless Framework to deploy the Node.js API.

Deployment should:
1. Load the correct environment configuration.
2. Package the Node.js application.
3. Deploy Lambda functions and API Gateway configuration.
4. Configure required IAM permissions.
5. Configure access to S3 and SQS.

Keep the API deployment independent of the Python AI project.

## 13. Development Rules

- Use TypeScript throughout the application.
- Use `mysql2`, not Prisma.
- Keep AWS integrations modular.
- Keep handlers lightweight.
- Follow consistent naming conventions.
- Avoid unnecessary dependencies.
- Do not implement Python AI functionality in this repository.
- Do not introduce Docker for the Node.js API unless a specific requirement justifies it.
- Do not create or deploy AWS resources without explicit approval.
- Use AWS CLI profile `document-ai` for personal AWS resources.
- Do not modify company AWS profiles or global AWS, Git, or SSH configuration.
- Explain major architectural decisions before implementing them.

## 14. Implementation Priority

Implement in this order:

1. Initialize the Node.js + TypeScript project.
2. Configure Serverless Framework.
3. Configure `.env` and `.env.prod`.
4. Set up MySQL connection and database utilities.
5. Implement document upload and presigned URL generation.
6. Implement upload completion and S3 verification.
7. Implement summary job creation.
8. Integrate SQS message publishing.
9. Implement job status and summary retrieval.
10. Add error handling, logging, and reliability improvements.
11. Test the complete API flow locally.

**Primary goal:** Build a clean, independently deployable Node.js API that manages documents, database operations, and asynchronous job creation while keeping all AI processing in a separate Python project.
