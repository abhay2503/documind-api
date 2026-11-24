-- Per-user daily summary quota (Phase 3). One row per (Cognito sub, UTC calendar day).
-- summary_count is incremented atomically by the API when it accepts a new summary job, guarded by
-- the daily limit in the same statement (INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit).
-- The limit itself (5 users / 50 admins) lives in application code, not in this table.
CREATE TABLE user_summary_usage (
  id             BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        VARCHAR(128)    NOT NULL,
  usage_date     DATE            NOT NULL,
  summary_count  INTEGER         NOT NULL DEFAULT 0 CHECK (summary_count >= 0),
  created_at     TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMPTZ(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_user_summary_usage_user_date UNIQUE (user_id, usage_date)
);
COMMENT ON COLUMN user_summary_usage.user_id    IS 'Cognito sub (same value as documents.user_id)';
COMMENT ON COLUMN user_summary_usage.usage_date IS 'UTC calendar day the summary jobs were accepted';
CREATE TRIGGER trg_user_summary_usage_updated_at BEFORE UPDATE ON user_summary_usage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
