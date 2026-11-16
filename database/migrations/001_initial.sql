-- DocuMind schema v1. Owned by the API repo; shared with the Python AI worker
-- (see agent-os/specs/2026-11-16-1358-documind-node-api/worker-contract.md).
-- Vocabulary: statuses queued|processing|completed|failed; styles concise|detailed|bullet_points|key_insights.

CREATE TABLE documents (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id     VARCHAR(64)     NOT NULL,
  user_id         VARCHAR(128)    NULL COMMENT 'Owner; NULL until authentication is introduced',
  file_name       VARCHAR(255)    NOT NULL,
  content_type    VARCHAR(127)    NOT NULL,
  file_size       BIGINT UNSIGNED NOT NULL COMMENT 'Declared at POST /uploads; verified against S3 on completion',
  s3_key          VARCHAR(1024)   NOT NULL,
  status          ENUM('pending_upload','uploaded') NOT NULL DEFAULT 'pending_upload',
  uploaded_at     DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_document_id (document_id),
  KEY idx_documents_user_created (user_id, created_at),
  KEY idx_documents_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE summary_jobs (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id                 VARCHAR(64)     NOT NULL,
  document_id            VARCHAR(64)     NOT NULL,
  status                 ENUM('queued','processing','completed','failed') NOT NULL DEFAULT 'queued',
  stage                  VARCHAR(32)     NULL COMMENT 'Optional progress hint written by the worker',
  summary_style          ENUM('concise','detailed','bullet_points','key_insights') NOT NULL,
  instructions           TEXT            NULL,
  instructions_hash      CHAR(64)        NULL COMMENT 'sha256 of instructions; duplicate-job detection',
  idempotency_key        VARCHAR(128)    NULL,
  result                 JSON            NULL,
  extracted_content_key  VARCHAR(1024)   NULL,
  llm_provider           VARCHAR(32)     NULL,
  llm_model              VARCHAR(255)    NULL,
  llm_usage              JSON            NULL,
  error_code             VARCHAR(64)     NULL,
  error_message          VARCHAR(1024)   NULL COMMENT 'User-safe; returned to the frontend',
  retry_count            INT UNSIGNED    NOT NULL DEFAULT 0,
  publish_attempts       INT UNSIGNED    NOT NULL DEFAULT 0,
  published_at           DATETIME(3)     NULL,
  created_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at             DATETIME(3)     NULL,
  completed_at           DATETIME(3)     NULL,
  updated_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_summary_jobs_job_id (job_id),
  UNIQUE KEY uq_summary_jobs_idempotency (document_id, idempotency_key),
  KEY idx_summary_jobs_document_status (document_id, status),
  KEY idx_summary_jobs_status_created (status, created_at),
  CONSTRAINT fk_summary_jobs_document FOREIGN KEY (document_id)
    REFERENCES documents (document_id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
