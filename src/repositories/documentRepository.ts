import { execute, queryOne, type Queryable } from '../database/pool';
import type { DocumentRow } from '../types/db';

const COLUMNS =
  'document_id, user_id, file_name, content_type, file_size, s3_key, status, uploaded_at, created_at';

export interface NewDocument {
  documentId: string;
  userId: string | null;
  fileName: string;
  contentType: string;
  fileSize: number;
  s3Key: string;
}

export async function insertPendingDocument(db: Queryable, doc: NewDocument): Promise<void> {
  await execute(
    db,
    `INSERT INTO documents (document_id, user_id, file_name, content_type, file_size, s3_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_upload')`,
    [doc.documentId, doc.userId, doc.fileName, doc.contentType, doc.fileSize, doc.s3Key],
  );
}

/**
 * userId is reserved for future ownership checks: when provided, only that user's document matches.
 * `forUpdate` locks the row (only meaningful inside a transaction).
 */
export async function findDocument(
  db: Queryable,
  documentId: string,
  opts: { userId?: string | null; forUpdate?: boolean } = {},
): Promise<DocumentRow | undefined> {
  const params: (string | null)[] = [documentId];
  let sql = `SELECT ${COLUMNS} FROM documents WHERE document_id = $1`;
  if (opts.userId !== undefined) {
    sql += ' AND user_id IS NOT DISTINCT FROM $2';
    params.push(opts.userId);
  }
  if (opts.forUpdate) sql += ' FOR UPDATE';
  return queryOne<DocumentRow>(db, sql, params);
}

/** Returns true when this call transitioned the document to `uploaded`. */
export async function markDocumentUploaded(db: Queryable, documentId: string): Promise<boolean> {
  const result = await execute(
    db,
    `UPDATE documents SET status = 'uploaded', uploaded_at = CURRENT_TIMESTAMP(3)
     WHERE document_id = $1 AND status = 'pending_upload'`,
    [documentId],
  );
  return result.rowCount === 1;
}
