/** Shapes exchanged with the frontend. Mirrors ../ui/src/lib/api/types.ts — keep them in sync. */
export type ApiSummaryStyle = 'concise' | 'detailed' | 'bullets' | 'insights';
export type ApiJobStatus = 'queued' | 'processing' | 'done' | 'failed';
export type ProcessingStage = 'preparing' | 'extracting' | 'structuring' | 'analyzing' | 'generating' | 'finalizing';

export interface Finding {
  title: string;
  detail: string;
}

export interface SummaryResult {
  documentName: string;
  style: ApiSummaryStyle;
  overview: string;
  keyPoints: string[];
  findings: Finding[];
  actionItems: string[];
  generatedAt: string;
}

export interface SummaryJob {
  jobId: string;
  documentId: string;
  status: ApiJobStatus;
  stage?: ProcessingStage;
  result?: SummaryResult;
  error?: string;
}

export interface CreateUploadResponse {
  documentId: string;
  key: string;
  uploadUrl: string;
  expiresIn: number;
}

export interface CompleteUploadResponse {
  documentId: string;
  status: 'uploaded';
  fileName: string;
}

export interface CreateSummaryResponse {
  jobId: string;
  documentId: string;
  status: ApiJobStatus;
}

export interface ErrorResponse {
  message: string;
  code: string;
}
