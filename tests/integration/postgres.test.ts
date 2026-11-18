/**
 * Opt-in PostgreSQL check. Works against local Postgres or Aiven: only the DB_* env vars change.
 * Prerequisites: npm run migrate. Run with: npm run test:postgres
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, setConfigForTests } from '../../src/config';
import { closePool, execute, getPool, isDuplicateKeyError, queryOne, withTransaction } from '../../src/database/pool';
import { findDocument, insertPendingDocument, markDocumentUploaded } from '../../src/repositories/documentRepository';
import { findJobWithDocument, insertQueuedJob } from '../../src/repositories/summaryJobRepository';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('PostgreSQL connection and repositories', () => {
  if (enabled) {
    process.loadEnvFile('.env');
    setConfigForTests(loadConfig({ ...process.env, NODE_ENV: 'development' }));
  }
  const tag = Math.random().toString(16).slice(2, 10);
  const documentId = `doc_pgtest_${tag}`;

  afterAll(async () => {
    await execute(getPool(), 'DELETE FROM documents WHERE document_id = $1', [documentId]); // cascades to jobs
    await closePool();
  });

  it('connects to the documind database', async () => {
    const v = await queryOne<{ version: string }>(getPool(), 'SELECT version() AS version');
    expect(v?.version).toMatch(/^PostgreSQL/);
    const d = await queryOne<{ db: string }>(getPool(), 'SELECT current_database() AS db');
    expect(d?.db).toBe(process.env.DB_NAME ?? 'documind');
  });

  it('inserts, reads, transitions and enforces constraints', async () => {
    await insertPendingDocument(getPool(), {
      documentId, userId: null, fileName: 'a.pdf', contentType: 'application/pdf', fileSize: 123, s3Key: `documents/${documentId}/a.pdf`,
    });
    const doc = await findDocument(getPool(), documentId, { userId: null });
    expect(doc).toMatchObject({ document_id: documentId, status: 'pending_upload', file_size: 123 }); // BIGINT -> number
    expect(doc?.created_at).toBeInstanceOf(Date);
    expect(await findDocument(getPool(), documentId, { userId: 'someone' })).toBeUndefined();

    expect(await markDocumentUploaded(getPool(), documentId)).toBe(true);
    expect(await markDocumentUploaded(getPool(), documentId)).toBe(false); // compare-and-set

    await insertQueuedJob(getPool(), {
      jobId: `job_pgtest_${tag}`, documentId, style: 'concise', instructions: null, instructionsHash: null, idempotencyKey: 'k1',
    });
    await expect(
      insertQueuedJob(getPool(), { jobId: `job_pgtest_${tag}2`, documentId, style: 'concise', instructions: null, instructionsHash: null, idempotencyKey: 'k1' }),
    ).rejects.toSatisfy(isDuplicateKeyError);
    expect(await findJobWithDocument(getPool(), `job_pgtest_${tag}`)).toMatchObject({ status: 'queued', file_name: 'a.pdf' });
  });

  it('updated_at trigger advances on update', async () => {
    const before = await queryOne<{ updated_at: Date }>(getPool(), 'SELECT updated_at FROM documents WHERE document_id = $1', [documentId]);
    await new Promise((r) => setTimeout(r, 20));
    await execute(getPool(), "UPDATE documents SET file_name = 'b.pdf' WHERE document_id = $1", [documentId]);
    const after = await queryOne<{ updated_at: Date }>(getPool(), 'SELECT updated_at FROM documents WHERE document_id = $1', [documentId]);
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });

  it('commits on success and rolls back on error', async () => {
    await withTransaction((c) => execute(c, "UPDATE documents SET file_name = 'committed.pdf' WHERE document_id = $1", [documentId]));
    await expect(
      withTransaction(async (c) => {
        await execute(c, "UPDATE documents SET file_name = 'rolled-back.pdf' WHERE document_id = $1", [documentId]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const row = await queryOne<{ file_name: string }>(getPool(), 'SELECT file_name FROM documents WHERE document_id = $1', [documentId]);
    expect(row?.file_name).toBe('committed.pdf');
  });
});
