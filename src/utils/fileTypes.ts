/** Accepted upload formats. Must stay in sync with the frontend (../ui/src/lib/file-validation.ts). */
export const ACCEPTED_FILE_TYPES = [
  { extension: '.pdf', mimeType: 'application/pdf' },
  { extension: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { extension: '.txt', mimeType: 'text/plain' },
] as const;

export type AcceptedFileType = (typeof ACCEPTED_FILE_TYPES)[number];

export function fileTypeForName(fileName: string): AcceptedFileType | undefined {
  const lower = fileName.toLowerCase();
  return ACCEPTED_FILE_TYPES.find((t) => lower.endsWith(t.extension));
}

/** Lower-cases and strips parameters, e.g. "Text/Plain; charset=utf-8" -> "text/plain". */
export function normalizeContentType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Builds a safe S3 object name from a user-supplied file name: strips any path,
 * replaces unsafe characters, and keeps the (validated) extension.
 */
export function sanitizeFileName(fileName: string, extension: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const stem = base.slice(0, base.length - extension.length);
  const safeStem = stem
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 150);
  return `${safeStem || 'document'}${extension}`;
}

export function documentS3Key(documentId: string, safeFileName: string): string {
  return `documents/${documentId}/${safeFileName}`;
}
