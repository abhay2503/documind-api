/** Row shapes and vocabulary shared with the Python worker (see worker-contract.md). */
export type DocumentStatus = 'pending_upload' | 'uploaded';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type DbSummaryStyle = 'concise' | 'detailed' | 'bullet_points' | 'key_insights';

export interface DocumentRow {
  document_id: string;
  user_id: string | null;
  file_name: string;
  content_type: string;
  file_size: number;
  s3_key: string;
  status: DocumentStatus;
  uploaded_at: Date | null;
  created_at: Date;
}

export interface SummaryJobRow {
  job_id: string;
  document_id: string;
  status: JobStatus;
  stage: string | null;
  summary_style: DbSummaryStyle;
  instructions: string | null;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  publish_attempts: number;
  published_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
}

/** A job joined with the document fields the API needs to build its response. */
export interface SummaryJobWithDocumentRow extends SummaryJobRow {
  file_name: string;
  user_id: string | null;
}
