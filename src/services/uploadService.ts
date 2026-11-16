import { getConfig } from '../config';
import { getPool } from '../database/pool';
import { findDocument, insertPendingDocument, markDocumentUploaded } from '../repositories/documentRepository';
import type { CompleteUploadResponse, CreateUploadResponse } from '../types/api';
import { ConflictError, FileTooLargeError, NotFoundError, ValidationError } from '../utils/errors';
import { documentS3Key, fileTypeForName, normalizeContentType, sanitizeFileName } from '../utils/fileTypes';
import { newDocumentId } from '../utils/ids';
import type { Logger } from '../utils/logger';
import { deleteObject, headObject, presignPutUrl } from './s3Service';

export interface CreateUploadInput {
  fileName: string;
  contentType: string;
  size: number;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Validates the requested upload, records it as pending, and returns a presigned PUT URL. No AI processing. */
export async function createUpload(input: CreateUploadInput, log: Logger): Promise<CreateUploadResponse> {
  const config = getConfig();

  const fileType = fileTypeForName(input.fileName);
  if (!fileType) {
    throw new ValidationError('Unsupported file type. Upload a PDF, DOCX or TXT file.');
  }
  if (normalizeContentType(input.contentType) !== fileType.mimeType) {
    throw new ValidationError(`Content type does not match a ${fileType.extension} file.`);
  }
  if (input.size > config.maxUploadBytes) {
    throw new FileTooLargeError(`The file is too large. The maximum size is ${mb(config.maxUploadBytes)}.`);
  }

  const documentId = newDocumentId();
  const key = documentS3Key(documentId, sanitizeFileName(input.fileName, fileType.extension));

  await insertPendingDocument(getPool(), {
    documentId,
    userId: null,
    fileName: input.fileName,
    contentType: fileType.mimeType,
    fileSize: input.size,
    s3Key: key,
  });

  const uploadUrl = await presignPutUrl(key, fileType.mimeType, config.uploadUrlExpiresSeconds);
  log.info('Upload URL issued', { documentId, sizeBytes: input.size, contentType: fileType.mimeType });

  return { documentId, key, uploadUrl, expiresIn: config.uploadUrlExpiresSeconds };
}

/**
 * Verifies the uploaded object against the server-side record (never a client-supplied key)
 * and marks the document uploaded. Idempotent. Does NOT start processing.
 */
export async function completeUpload(documentId: string, log: Logger): Promise<CompleteUploadResponse> {
  const config = getConfig();
  const doc = await findDocument(getPool(), documentId);
  if (!doc) {
    throw new NotFoundError('DOCUMENT_NOT_FOUND', 'The requested document was not found.');
  }
  if (doc.status === 'uploaded') {
    return { documentId, status: 'uploaded', fileName: doc.file_name };
  }

  const object = await headObject(doc.s3_key);
  if (!object) {
    throw new ConflictError('UPLOAD_NOT_FOUND', 'The file has not been uploaded yet. Please upload it and try again.');
  }

  const rejectUpload = async (reason: string) => {
    log.warn('Uploaded object rejected', { documentId, reason, actualBytes: object.contentLength });
    await deleteObject(doc.s3_key);
  };

  if (object.contentLength > config.maxUploadBytes) {
    await rejectUpload('too_large');
    throw new FileTooLargeError(`The file is too large. The maximum size is ${mb(config.maxUploadBytes)}.`);
  }
  if (object.contentLength === 0 || object.contentLength !== Number(doc.file_size)) {
    await rejectUpload('size_mismatch');
    throw new ConflictError('UPLOAD_SIZE_MISMATCH', 'The uploaded file does not match the expected size. Please upload it again.');
  }
  if (normalizeContentType(object.contentType) !== doc.content_type) {
    await rejectUpload('content_type_mismatch');
    throw new ConflictError('UPLOAD_TYPE_MISMATCH', 'The uploaded file type does not match. Please upload it again.');
  }

  await markDocumentUploaded(getPool(), documentId);
  log.info('Upload completed', { documentId, sizeBytes: object.contentLength });
  return { documentId, status: 'uploaded', fileName: doc.file_name };
}
