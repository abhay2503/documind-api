import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRow } from '../../src/types/db';
import { DOC_ID, JOB_ID, jobRow, OTHER_USER_ID, silentLog, USER_ID } from '../helpers';

vi.mock('../../src/database/pool', () => ({
  getPool: () => ({}),
  withTransaction: async (fn: (conn: unknown) => Promise<unknown>) => fn({}),
  isDuplicateKeyError: (err: { code?: string }) => err?.code === 'ER_DUP_ENTRY',
}));
vi.mock('../../src/repositories/documentRepository', () => ({ findDocument: vi.fn() }));
vi.mock('../../src/repositories/summaryJobRepository', () => ({
  insertQueuedJob: vi.fn(),
  findJobByIdempotencyKey: vi.fn(),
  findActiveDuplicateJob: vi.fn(),
  findJobWithDocument: vi.fn(),
  markJobPublished: vi.fn(),
  markJobPublishFailed: vi.fn(),
  claimRepublish: vi.fn(),
}));

const docRepo = await import('../../src/repositories/documentRepository');
const jobRepo = await import('../../src/repositories/summaryJobRepository');
const { createSummaryJob, getSummaryJob } = await import('../../src/services/summaryService');

const sqsMock = mockClient(SQSClient);

const uploadedDoc = { document_id: DOC_ID, user_id: USER_ID, status: 'uploaded' } as DocumentRow;

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
  for (const fn of Object.values(jobRepo)) vi.mocked(fn as () => unknown).mockReset();
  vi.mocked(docRepo.findDocument).mockReset().mockResolvedValue(uploadedDoc);
  vi.mocked(jobRepo.markJobPublishFailed).mockResolvedValue(true);
});

describe('createSummaryJob', () => {
  it('commits a queued job, then publishes identifiers only', async () => {
    const res = await createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'bullets' }, silentLog);

    expect(res).toEqual({ jobId: expect.stringMatching(/^job_[0-9a-f]{32}$/), documentId: DOC_ID, status: 'queued' });
    expect(docRepo.findDocument).toHaveBeenCalledWith(expect.anything(), DOC_ID, { userId: USER_ID, forUpdate: true });
    expect(jobRepo.insertQueuedJob).toHaveBeenCalledWith(expect.anything(), {
      jobId: res.jobId,
      documentId: DOC_ID,
      style: 'bullet_points',
      instructions: null,
      instructionsHash: null,
      idempotencyKey: null,
    });
    const sent = sqsMock.commandCalls(SendMessageCommand);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.args[0].input.MessageBody!)).toEqual({ jobId: res.jobId, documentId: DOC_ID });
    expect(jobRepo.markJobPublished).toHaveBeenCalledWith(expect.anything(), res.jobId);
  });

  it('returns 404 for an unknown document', async () => {
    vi.mocked(docRepo.findDocument).mockResolvedValue(undefined);
    await expect(createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'concise' }, silentLog)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('returns 409 when the upload was not completed', async () => {
    vi.mocked(docRepo.findDocument).mockResolvedValue({ ...uploadedDoc, status: 'pending_upload' });
    await expect(createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'concise' }, silentLog)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCUMENT_NOT_UPLOADED',
    });
  });

  it('returns the existing job for a repeated Idempotency-Key without publishing', async () => {
    vi.mocked(jobRepo.findJobByIdempotencyKey).mockResolvedValue(jobRow({ status: 'processing' }));
    const res = await createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'concise', idempotencyKey: 'k1' }, silentLog);
    expect(res).toEqual({ jobId: JOB_ID, documentId: DOC_ID, status: 'processing' });
    expect(jobRepo.insertQueuedJob).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('reuses an active duplicate job (double-click protection)', async () => {
    vi.mocked(jobRepo.findActiveDuplicateJob).mockResolvedValue(jobRow());
    const res = await createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'bullets', instructions: '  focus  ' }, silentLog);
    expect(res.jobId).toBe(JOB_ID);
    expect(jobRepo.findActiveDuplicateJob).toHaveBeenCalledWith(
      expect.anything(),
      DOC_ID,
      'bullet_points',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('marks the job failed and returns 503 when SQS publishing fails', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs down'));
    await expect(createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'detailed' }, silentLog)).rejects.toMatchObject({
      statusCode: 503,
      code: 'QUEUE_UNAVAILABLE',
    });
    const jobId = vi.mocked(jobRepo.insertQueuedJob).mock.calls[0]![1].jobId;
    expect(jobRepo.markJobPublishFailed).toHaveBeenCalledWith(expect.anything(), jobId);
    expect(jobRepo.markJobPublished).not.toHaveBeenCalled();
  });

  it('still succeeds if recording published_at fails after a successful publish', async () => {
    vi.mocked(jobRepo.markJobPublished).mockRejectedValue(new Error('db blip'));
    await expect(createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'concise' }, silentLog)).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('returns the winning job when an idempotency-key insert races', async () => {
    vi.mocked(jobRepo.findJobByIdempotencyKey).mockResolvedValueOnce(undefined).mockResolvedValueOnce(jobRow());
    vi.mocked(jobRepo.insertQueuedJob).mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));
    const res = await createSummaryJob({ userId: USER_ID, documentId: DOC_ID, style: 'concise', idempotencyKey: 'k1' }, silentLog);
    expect(res.jobId).toBe(JOB_ID);
    expect(sqsMock.calls()).toHaveLength(0);
  });
});

describe('createSummaryJob ownership', () => {
  it("rejects another user's document with 404 before creating a job or touching SQS", async () => {
    // findDocument filters by owner in SQL, so another user's document is returned as missing.
    vi.mocked(docRepo.findDocument).mockResolvedValue(undefined);
    await expect(
      createSummaryJob({ userId: OTHER_USER_ID, documentId: DOC_ID, style: 'concise', idempotencyKey: 'k1' }, silentLog),
    ).rejects.toMatchObject({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(docRepo.findDocument).toHaveBeenCalledWith(expect.anything(), DOC_ID, { userId: OTHER_USER_ID, forUpdate: true });
    expect(jobRepo.findJobByIdempotencyKey).not.toHaveBeenCalled();
    expect(jobRepo.findActiveDuplicateJob).not.toHaveBeenCalled();
    expect(jobRepo.insertQueuedJob).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });
});

describe('getSummaryJob ownership', () => {
  it('returns the authenticated user\'s own job, looked up scoped to that user', async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(jobRow({ status: 'processing' }));
    await expect(getSummaryJob(JOB_ID, USER_ID, silentLog)).resolves.toMatchObject({ jobId: JOB_ID, status: 'processing' });
    expect(jobRepo.findJobWithDocument).toHaveBeenCalledWith(expect.anything(), JOB_ID, { userId: USER_ID });
  });

  it("returns 404 for another user's job and never triggers recovery for it", async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(undefined);
    await expect(getSummaryJob(JOB_ID, OTHER_USER_ID, silentLog)).rejects.toMatchObject({
      statusCode: 404,
      code: 'JOB_NOT_FOUND',
      message: 'The requested summary job was not found.',
    });
    expect(jobRepo.findJobWithDocument).toHaveBeenCalledWith(expect.anything(), JOB_ID, { userId: OTHER_USER_ID });
    expect(jobRepo.claimRepublish).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });
});

describe('getSummaryJob', () => {
  it('returns 404 for unknown jobs', async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(undefined);
    await expect(getSummaryJob(JOB_ID, USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });
  });

  it('does not attempt recovery for published jobs', async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(jobRow());
    await expect(getSummaryJob(JOB_ID, USER_ID, silentLog)).resolves.toMatchObject({ status: 'queued' });
    expect(jobRepo.claimRepublish).not.toHaveBeenCalled();
  });

  it('republishes a stuck unpublished job when the claim succeeds', async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(jobRow({ published_at: null, publish_attempts: 1 }));
    vi.mocked(jobRepo.claimRepublish).mockResolvedValue(true);
    await expect(getSummaryJob(JOB_ID, USER_ID, silentLog)).resolves.toMatchObject({ status: 'queued' });
    expect(jobRepo.claimRepublish).toHaveBeenCalledWith(expect.anything(), JOB_ID, 1, 60);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    expect(jobRepo.markJobPublished).toHaveBeenCalled();
  });

  it('does not republish when another poller holds the claim', async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(jobRow({ published_at: null }));
    vi.mocked(jobRepo.claimRepublish).mockResolvedValue(false);
    await getSummaryJob(JOB_ID, USER_ID, silentLog);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('fails the job after exhausting publish attempts', async () => {
    vi.mocked(jobRepo.findJobWithDocument)
      .mockResolvedValueOnce(jobRow({ published_at: null, publish_attempts: 3 }))
      .mockResolvedValueOnce(jobRow({ published_at: null, publish_attempts: 3, status: 'failed', error_code: 'QUEUE_PUBLISH_FAILED' }));
    const res = await getSummaryJob(JOB_ID, USER_ID, silentLog);
    expect(jobRepo.markJobPublishFailed).toHaveBeenCalledWith(expect.anything(), JOB_ID);
    expect(res.status).toBe('failed');
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('keeps serving status if recovery itself errors', async () => {
    vi.mocked(jobRepo.findJobWithDocument).mockResolvedValue(jobRow({ published_at: null }));
    vi.mocked(jobRepo.claimRepublish).mockResolvedValue(true);
    sqsMock.on(SendMessageCommand).rejects(new Error('still down'));
    await expect(getSummaryJob(JOB_ID, USER_ID, silentLog)).resolves.toMatchObject({ status: 'queued' });
  });
});
