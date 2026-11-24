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
vi.mock('../../src/repositories/summaryUsageRepository', () => ({
  incrementDailyUsage: vi.fn(),
  getDailyUsage: vi.fn(),
  releaseDailyUsage: vi.fn(),
}));
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
const usageRepo = await import('../../src/repositories/summaryUsageRepository');
const { createSummaryJob, getSummaryJob } = await import('../../src/services/summaryService');

const sqsMock = mockClient(SQSClient);

const uploadedDoc = { document_id: DOC_ID, user_id: USER_ID, status: 'uploaded' } as DocumentRow;

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
  for (const fn of Object.values(jobRepo)) vi.mocked(fn as () => unknown).mockReset();
  vi.mocked(docRepo.findDocument).mockReset().mockResolvedValue(uploadedDoc);
  vi.mocked(jobRepo.markJobPublishFailed).mockResolvedValue(true);
  // Default: the user has 0/5 used today, so the increment takes them to 1.
  vi.mocked(usageRepo.incrementDailyUsage).mockReset().mockResolvedValue(1);
  vi.mocked(usageRepo.getDailyUsage).mockReset().mockResolvedValue(0);
  vi.mocked(usageRepo.releaseDailyUsage).mockReset().mockResolvedValue(undefined);
});

describe('createSummaryJob', () => {
  it('commits a queued job, then publishes identifiers only', async () => {
    const res = await createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'bullets' }, silentLog);

    expect(res).toEqual({
      jobId: expect.stringMatching(/^job_[0-9a-f]{32}$/),
      documentId: DOC_ID,
      status: 'queued',
      dailyLimit: 5,
      dailyUsed: 1,
      dailyRemaining: 4,
    });
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
    await expect(createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'concise' }, silentLog)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('returns 409 when the upload was not completed', async () => {
    vi.mocked(docRepo.findDocument).mockResolvedValue({ ...uploadedDoc, status: 'pending_upload' });
    await expect(createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'concise' }, silentLog)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOCUMENT_NOT_UPLOADED',
    });
  });

  it('returns the existing job for a repeated Idempotency-Key without publishing', async () => {
    vi.mocked(jobRepo.findJobByIdempotencyKey).mockResolvedValue(jobRow({ status: 'processing' }));
    vi.mocked(usageRepo.getDailyUsage).mockResolvedValue(2);
    const res = await createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'concise', idempotencyKey: 'k1' }, silentLog);
    expect(res).toEqual({ jobId: JOB_ID, documentId: DOC_ID, status: 'processing', dailyLimit: 5, dailyUsed: 2, dailyRemaining: 3 });
    // A replay never consumes quota.
    expect(usageRepo.incrementDailyUsage).not.toHaveBeenCalled();
    expect(jobRepo.insertQueuedJob).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('reuses an active duplicate job (double-click protection)', async () => {
    vi.mocked(jobRepo.findActiveDuplicateJob).mockResolvedValue(jobRow());
    const res = await createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'bullets', instructions: '  focus  ' }, silentLog);
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
    await expect(createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'detailed' }, silentLog)).rejects.toMatchObject({
      statusCode: 503,
      code: 'QUEUE_UNAVAILABLE',
    });
    const jobId = vi.mocked(jobRepo.insertQueuedJob).mock.calls[0]![1].jobId;
    expect(jobRepo.markJobPublishFailed).toHaveBeenCalledWith(expect.anything(), jobId);
    expect(jobRepo.markJobPublished).not.toHaveBeenCalled();
  });

  it('still succeeds if recording published_at fails after a successful publish', async () => {
    vi.mocked(jobRepo.markJobPublished).mockRejectedValue(new Error('db blip'));
    await expect(createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'concise' }, silentLog)).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('returns the winning job when an idempotency-key insert races', async () => {
    vi.mocked(jobRepo.findJobByIdempotencyKey).mockResolvedValueOnce(undefined).mockResolvedValueOnce(jobRow());
    vi.mocked(jobRepo.insertQueuedJob).mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));
    const res = await createSummaryJob({ userId: USER_ID, isAdmin: false, documentId: DOC_ID, style: 'concise', idempotencyKey: 'k1' }, silentLog);
    expect(res.jobId).toBe(JOB_ID);
    expect(sqsMock.calls()).toHaveLength(0);
  });
});

describe('createSummaryJob ownership', () => {
  it("rejects another user's document with 404 before creating a job or touching SQS", async () => {
    // findDocument filters by owner in SQL, so another user's document is returned as missing.
    vi.mocked(docRepo.findDocument).mockResolvedValue(undefined);
    await expect(
      createSummaryJob({ userId: OTHER_USER_ID, isAdmin: false, documentId: DOC_ID, style: 'concise', idempotencyKey: 'k1' }, silentLog),
    ).rejects.toMatchObject({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(docRepo.findDocument).toHaveBeenCalledWith(expect.anything(), DOC_ID, { userId: OTHER_USER_ID, forUpdate: true });
    expect(jobRepo.findJobByIdempotencyKey).not.toHaveBeenCalled();
    expect(jobRepo.findActiveDuplicateJob).not.toHaveBeenCalled();
    expect(usageRepo.incrementDailyUsage).not.toHaveBeenCalled();
    expect(jobRepo.insertQueuedJob).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });
});

describe('createSummaryJob daily quota', () => {
  const create = (isAdmin = false, userId = USER_ID) =>
    createSummaryJob({ userId, isAdmin, documentId: DOC_ID, style: 'concise' }, silentLog);

  // The repository does the atomic check-and-increment; it returns the new count, or undefined at the limit.
  it.each([
    ['normal user 0/5 → 1/5', false, 1, 5, 4],
    ['normal user 4/5 → 5/5', false, 5, 5, 0],
    ['admin 49/50 → 50/50', true, 50, 50, 0],
  ])('%s: allowed, queued, and reports the remaining quota', async (_label, isAdmin, newCount, limit, remaining) => {
    vi.mocked(usageRepo.incrementDailyUsage).mockResolvedValue(newCount);
    await expect(create(isAdmin)).resolves.toMatchObject({
      status: 'queued',
      dailyLimit: limit,
      dailyUsed: newCount,
      dailyRemaining: remaining,
    });
    expect(usageRepo.incrementDailyUsage).toHaveBeenCalledWith(expect.anything(), USER_ID, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), limit);
    expect(jobRepo.insertQueuedJob).toHaveBeenCalledTimes(1);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it.each([
    ['normal user at 5/5', false, 5],
    ['admin at 50/50', true, 50],
  ])('%s: 429 DAILY_SUMMARY_LIMIT_REACHED, no job row and nothing sent to SQS', async (_label, isAdmin, limit) => {
    vi.mocked(usageRepo.incrementDailyUsage).mockResolvedValue(undefined);
    await expect(create(isAdmin)).rejects.toMatchObject({
      statusCode: 429,
      code: 'DAILY_SUMMARY_LIMIT_REACHED',
      message: 'Daily summary limit reached.',
    });
    expect(usageRepo.incrementDailyUsage).toHaveBeenCalledWith(expect.anything(), USER_ID, expect.any(String), limit);
    expect(jobRepo.insertQueuedJob).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('charges the quota of the authenticated user only (user A cannot spend user B\'s quota)', async () => {
    await create(false, OTHER_USER_ID);
    expect(usageRepo.incrementDailyUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(usageRepo.incrementDailyUsage).mock.calls[0]![1]).toBe(OTHER_USER_ID);
  });

  it('checks the quota before inserting the job, inside the same transaction', async () => {
    await create();
    const incrementOrder = vi.mocked(usageRepo.incrementDailyUsage).mock.invocationCallOrder[0]!;
    const insertOrder = vi.mocked(jobRepo.insertQueuedJob).mock.invocationCallOrder[0]!;
    expect(incrementOrder).toBeLessThan(insertOrder);
  });

  it('uses the UTC calendar day, not server or browser local time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 23:30 in New York on Nov 23 is already Nov 24 in UTC.
      vi.setSystemTime(new Date('2026-11-23T23:30:00-05:00'));
      await create();
      expect(vi.mocked(usageRepo.incrementDailyUsage).mock.calls[0]![2]).toBe('2026-11-24');

      // 05:29 IST on Nov 25 is still Nov 24 in UTC; 05:30 IST is the new UTC day.
      vi.setSystemTime(new Date('2026-11-25T05:29:59+05:30'));
      await create();
      expect(vi.mocked(usageRepo.incrementDailyUsage).mock.calls[1]![2]).toBe('2026-11-24');
      vi.setSystemTime(new Date('2026-11-25T05:30:00+05:30'));
      await create();
      expect(vi.mocked(usageRepo.incrementDailyUsage).mock.calls[2]![2]).toBe('2026-11-25');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume quota for a document the user does not own or that is not uploaded', async () => {
    vi.mocked(docRepo.findDocument).mockResolvedValueOnce({ ...uploadedDoc, status: 'pending_upload' });
    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    expect(usageRepo.incrementDailyUsage).not.toHaveBeenCalled();
  });

  it('does not consume quota for a double click on an active job', async () => {
    vi.mocked(jobRepo.findActiveDuplicateJob).mockResolvedValue(jobRow());
    vi.mocked(usageRepo.getDailyUsage).mockResolvedValue(3);
    await expect(create()).resolves.toMatchObject({ jobId: JOB_ID, dailyUsed: 3, dailyRemaining: 2 });
    expect(usageRepo.incrementDailyUsage).not.toHaveBeenCalled();
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it('refunds the quota when the job could not be queued (SQS publish failed → 503)', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs down'));
    await expect(create()).rejects.toMatchObject({ statusCode: 503 });
    const usageDate = vi.mocked(usageRepo.incrementDailyUsage).mock.calls[0]![2];
    expect(usageRepo.releaseDailyUsage).toHaveBeenCalledWith(expect.anything(), USER_ID, usageDate);
  });

  it('still returns 503 (not 500) if the refund itself fails', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs down'));
    vi.mocked(usageRepo.releaseDailyUsage).mockRejectedValue(new Error('db blip'));
    await expect(create()).rejects.toMatchObject({ statusCode: 503, code: 'QUEUE_UNAVAILABLE' });
  });

  it('does not refund when the job was queued successfully', async () => {
    await create();
    expect(usageRepo.releaseDailyUsage).not.toHaveBeenCalled();
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
