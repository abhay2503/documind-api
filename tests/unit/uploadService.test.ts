import { DeleteObjectCommand, HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRow } from '../../src/types/db';
import { DOC_ID, OTHER_USER_ID, USER_ID, silentLog } from '../helpers';

vi.mock('../../src/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('../../src/repositories/documentRepository', () => ({
  insertPendingDocument: vi.fn(),
  findDocument: vi.fn(),
  markDocumentUploaded: vi.fn(),
}));

const repo = await import('../../src/repositories/documentRepository');
const { createUpload, completeUpload } = await import('../../src/services/uploadService');

const s3Mock = mockClient(S3Client);

const pendingDoc = (overrides: Partial<DocumentRow> = {}): DocumentRow => ({
  document_id: DOC_ID,
  user_id: USER_ID,
  file_name: 'invoice.pdf',
  content_type: 'application/pdf',
  file_size: 2048,
  s3_key: `documents/${DOC_ID}/invoice.pdf`,
  status: 'pending_upload',
  uploaded_at: null,
  created_at: new Date(),
  ...overrides,
});

beforeEach(() => {
  s3Mock.reset();
  vi.mocked(repo.insertPendingDocument).mockReset();
  vi.mocked(repo.findDocument).mockReset();
  vi.mocked(repo.markDocumentUploaded).mockReset();
});

describe('createUpload', () => {
  it('records a pending document and returns a presigned PUT URL', async () => {
    const res = await createUpload({ fileName: 'My Invoice.pdf', contentType: 'application/pdf', size: 2048 }, USER_ID, silentLog);

    expect(res.documentId).toMatch(/^doc_[0-9a-f]{32}$/);
    expect(res.key).toBe(`documents/${res.documentId}/My_Invoice.pdf`);
    expect(res.expiresIn).toBe(900);
    const url = new URL(res.uploadUrl);
    expect(url.pathname).toContain(encodeURIComponent('My_Invoice.pdf'));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    // No flexible-checksum params that a browser PUT could not satisfy.
    expect([...url.searchParams.keys()].some((k) => k.toLowerCase().includes('checksum'))).toBe(false);

    expect(repo.insertPendingDocument).toHaveBeenCalledWith(expect.anything(), {
      documentId: res.documentId,
      userId: USER_ID,
      fileName: 'My Invoice.pdf',
      contentType: 'application/pdf',
      fileSize: 2048,
      s3Key: res.key,
    });
  });

  it('saves the authenticated user as the document owner', async () => {
    await createUpload({ fileName: 'a.pdf', contentType: 'application/pdf', size: 10 }, OTHER_USER_ID, silentLog);
    expect(repo.insertPendingDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: OTHER_USER_ID }));
  });

  it('rejects unsupported extensions', async () => {
    await expect(createUpload({ fileName: 'a.png', contentType: 'image/png', size: 1 }, USER_ID, silentLog)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects a content type that does not match the extension', async () => {
    await expect(createUpload({ fileName: 'a.pdf', contentType: 'text/plain', size: 1 }, USER_ID, silentLog)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects files over 10 MB with 413', async () => {
    await expect(
      createUpload({ fileName: 'a.pdf', contentType: 'application/pdf', size: 10 * 1024 * 1024 + 1 }, USER_ID, silentLog),
    ).rejects.toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });
    expect(repo.insertPendingDocument).not.toHaveBeenCalled();
  });
});

describe('completeUpload', () => {
  it('returns 404 for unknown documents', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(undefined);
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
  });

  it('is idempotent for already-uploaded documents', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc({ status: 'uploaded' }));
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).resolves.toEqual({
      documentId: DOC_ID,
      status: 'uploaded',
      fileName: 'invoice.pdf',
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('returns 409 when the object is missing', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).rejects(new NotFound({ message: 'not found', $metadata: { httpStatusCode: 404 } }));
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 409, code: 'UPLOAD_NOT_FOUND' });
  });

  it('verifies against the server-side key and marks the document uploaded', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'application/pdf' });

    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).resolves.toMatchObject({ status: 'uploaded' });
    expect(s3Mock.commandCalls(HeadObjectCommand)[0]!.args[0].input).toEqual({
      Bucket: 'documind-test-bucket',
      Key: `documents/${DOC_ID}/invoice.pdf`,
    });
    expect(repo.markDocumentUploaded).toHaveBeenCalledWith(expect.anything(), DOC_ID);
  });

  it('deletes and rejects an object whose size differs from the declared size', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 999, ContentType: 'application/pdf' });
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).rejects.toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(repo.markDocumentUploaded).not.toHaveBeenCalled();
  });

  it('deletes and rejects an oversized object with 413', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 11 * 1024 * 1024, ContentType: 'application/pdf' });
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 413 });
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('rejects a content type mismatch', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'text/html' });
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).rejects.toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' });
  });

  it('maps S3 outages to 503', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).rejects(new Error('socket hang up'));
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 503, code: 'STORAGE_UNAVAILABLE' });
  });

  it('looks the document up scoped to the authenticated user and completes the owner\'s upload', async () => {
    vi.mocked(repo.findDocument).mockResolvedValue(pendingDoc());
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 2048, ContentType: 'application/pdf' });
    await expect(completeUpload(DOC_ID, USER_ID, silentLog)).resolves.toMatchObject({ status: 'uploaded' });
    expect(repo.findDocument).toHaveBeenCalledWith(expect.anything(), DOC_ID, { userId: USER_ID });
  });

  it("returns 404 (not 403) for another user's document and never touches S3", async () => {
    // The ownership filter is in SQL, so another user's document comes back as "not found".
    vi.mocked(repo.findDocument).mockResolvedValue(undefined);
    await expect(completeUpload(DOC_ID, OTHER_USER_ID, silentLog)).rejects.toMatchObject({
      statusCode: 404,
      code: 'DOCUMENT_NOT_FOUND',
    });
    expect(repo.findDocument).toHaveBeenCalledWith(expect.anything(), DOC_ID, { userId: OTHER_USER_ID });
    expect(s3Mock.calls()).toHaveLength(0);
    expect(repo.markDocumentUploaded).not.toHaveBeenCalled();
  });
});
