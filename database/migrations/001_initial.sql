-- DocuMind schema v1 (PostgreSQL). Owned by the API repo; shared with the Python AI worker
-- (see agent-os/specs/2026-11-16-1358-documind-node-api/worker-contract.md).
-- Vocabulary: statuses queued|processing|completed|failed; styles concise|detailed|bullet_points|key_insights.
-- Converted 1:1 from the MySQL schema (database/mysql/001_initial.sql): same tables, columns and constraints.
-- All timestamps are TIMESTAMPTZ (stored as UTC instants).

-- Replaces MySQL's "ON UPDATE CURRENT_TIMESTAMP(3)" on updated_at.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE documents (
  id              BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     VARCHAR(64)     NOT NULL,
  user_id         VARCHAR(128)    NULL,
  file_name       VARCHAR(255)    NOT NULL,
  content_type    VARCHAR(127)    NOT NULL,
  file_size       BIGINT          NOT NULL CHECK (file_size >= 0),
  s3_key          VARCHAR(1024)   NOT NULL,
  status          VARCHAR(16)     NOT NULL DEFAULT 'pending_upload'
                  CHECK (status IN ('pending_upload', 'uploaded')),
  uploaded_at     TIMESTAMPTZ(3)  NULL,
  created_at      TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_documents_document_id UNIQUE (document_id)
);
COMMENT ON COLUMN documents.user_id   IS 'Owner; NULL until authentication is introduced';
COMMENT ON COLUMN documents.file_size IS 'Declared at POST /uploads; verified against S3 on completion';
CREATE INDEX idx_documents_user_created   ON documents (user_id, created_at);
CREATE INDEX idx_documents_status_created ON documents (status, created_at);
CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE summary_jobs (
  id                     BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id                 VARCHAR(64)     NOT NULL,
  document_id            VARCHAR(64)     NOT NULL,
  status                 VARCHAR(16)     NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  stage                  VARCHAR(32)     NULL,
  summary_style          VARCHAR(16)     NOT NULL
                         CHECK (summary_style IN ('concise', 'detailed', 'bullet_points', 'key_insights')),
  instructions           TEXT            NULL,
  instructions_hash      CHAR(64)        NULL,
  idempotency_key        VARCHAR(128)    NULL,
  result                 JSONB           NULL,
  extracted_content_key  VARCHAR(1024)   NULL,
  llm_provider           VARCHAR(32)     NULL,
  llm_model              VARCHAR(255)    NULL,
  llm_usage              JSONB           NULL,
  error_code             VARCHAR(64)     NULL,
  error_message          VARCHAR(1024)   NULL,
  retry_count            INTEGER         NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  publish_attempts       INTEGER         NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  published_at           TIMESTAMPTZ(3)  NULL,
  created_at             TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at             TIMESTAMPTZ(3)  NULL,
  completed_at           TIMESTAMPTZ(3)  NULL,
  updated_at             TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_summary_jobs_job_id UNIQUE (job_id),
  CONSTRAINT uq_summary_jobs_idempotency UNIQUE (document_id, idempotency_key),
  CONSTRAINT fk_summary_jobs_document FOREIGN KEY (document_id)
    REFERENCES documents (document_id) ON DELETE CASCADE ON UPDATE RESTRICT
);
COMMENT ON COLUMN summary_jobs.stage             IS 'Optional progress hint written by the worker';
COMMENT ON COLUMN summary_jobs.instructions_hash IS 'sha256 of instructions; duplicate-job detection';
COMMENT ON COLUMN summary_jobs.error_message     IS 'User-safe; returned to the frontend';
CREATE INDEX idx_summary_jobs_document_status ON summary_jobs (document_id, status);
CREATE INDEX idx_summary_jobs_status_created  ON summary_jobs (status, created_at);
CREATE TRIGGER trg_summary_jobs_updated_at BEFORE UPDATE ON summary_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
