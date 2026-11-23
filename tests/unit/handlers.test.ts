import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC_ID, httpEvent, JOB_ID, jwtRequestContext, lambdaContext, OTHER_USER_ID, unauthenticatedEvent, USER_ID } from '../helpers';

vi.mock('../../src/services/uploadService', () => ({ createUpload: vi.fn(), completeUpload: vi.fn() }));
vi.mock('../../src/services/summaryService', () => ({ createSummaryJob: vi.fn(), getSummaryJob: vi.fn() }));

const uploadService = await import('../../src/services/uploadService');
const summaryService = await import('../../src/services/summaryService');
const createUpload = (await import('../../src/handlers/createUpload')).handler;
const completeUpload = (await import('../../src/handlers/completeUpload')).handler;
const createSummary = (await import('../../src/handlers/createSummary')).handler;
const getSummary = (await import('../../src/handlers/getSummary')).handler;

type Result = { statusCode: number; body: string; headers: Record<string, string> };
const call = async (h: typeof createUpload, event = httpEvent()) => (await h(event, lambdaContext)) as Result;
const json = (r: Result) => JSON.parse(r.body);

beforeEach(() => vi.resetAllMocks());

describe('POST /uploads', () => {
  it('returns 201 with the frontend shape (no envelope)', async () => {
    const payload = { documentId: DOC_ID, key: 'k', uploadUrl: 'u', expiresIn: 900 };
    vi.mocked(uploadService.createUpload).mockResolvedValue(payload);
    const res = await call(createUpload, httpEvent({ body: JSON.stringify({ fileName: 'a.pdf', contentType: 'application/pdf', size: 10 }) }));
    expect(res.statusCode).toBe(201);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(json(res)).toEqual(payload);
  });

  it('returns 400 { message, code } for invalid JSON', async () => {
    const res = await call(createUpload, httpEvent({ body: '{bad' }));
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ message: 'Request body must be valid JSON.', code: 'VALIDATION_ERROR' });
  });

  it('returns 400 for a missing size', async () => {
    const res = await call(createUpload, httpEvent({ body: JSON.stringify({ fileName: 'a.pdf', contentType: 'application/pdf' }) }));
    expect(res.statusCode).toBe(400);
    expect(json(res).message).toMatch(/^size:/);
  });

  it('hides unexpected errors behind a generic 500', async () => {
    vi.mocked(uploadService.createUpload).mockRejectedValue(new Error('ER_PARSE_ERROR near SELECT secret'));
    const res = await call(createUpload, httpEvent({ body: JSON.stringify({ fileName: 'a.pdf', contentType: 'application/pdf', size: 1 }) }));
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ message: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' });
  });
});

describe('POST /documents/{documentId}/complete', () => {
  it('validates the path id and needs no body', async () => {
    vi.mocked(uploadService.completeUpload).mockResolvedValue({ documentId: DOC_ID, status: 'uploaded', fileName: 'a.pdf' });
    const ok = await call(completeUpload, httpEvent({ pathParameters: { documentId: DOC_ID } }));
    expect(ok.statusCode).toBe(200);
    const bad = await call(completeUpload, httpEvent({ pathParameters: { documentId: 'doc_1' } }));
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /summaries', () => {
  it('accepts frontend style names, passes the Idempotency-Key, returns 202', async () => {
    vi.mocked(summaryService.createSummaryJob).mockResolvedValue({ jobId: JOB_ID, documentId: DOC_ID, status: 'queued' });
    const res = await call(
      createSummary,
      httpEvent({ headers: { 'idempotency-key': 'abc-123' }, body: JSON.stringify({ documentId: DOC_ID, style: 'insights' }) }),
    );
    expect(res.statusCode).toBe(202);
    expect(json(res)).toEqual({ jobId: JOB_ID, documentId: DOC_ID, status: 'queued' });
    expect(summaryService.createSummaryJob).toHaveBeenCalledWith(
      { documentId: DOC_ID, style: 'insights', idempotencyKey: 'abc-123', userId: USER_ID },
      expect.anything(),
    );
  });

  it('rejects DB-vocabulary style names and oversized instructions', async () => {
    const badStyle = await call(createSummary, httpEvent({ body: JSON.stringify({ documentId: DOC_ID, style: 'bullet_points' }) }));
    expect(badStyle.statusCode).toBe(400);
    const longInstr = await call(
      createSummary,
      httpEvent({ body: JSON.stringify({ documentId: DOC_ID, style: 'concise', instructions: 'x'.repeat(2001) }) }),
    );
    expect(longInstr.statusCode).toBe(400);
  });
});

describe('GET /summaries/{jobId}', () => {
  it('returns the job and validates the id', async () => {
    vi.mocked(summaryService.getSummaryJob).mockResolvedValue({ jobId: JOB_ID, documentId: DOC_ID, status: 'processing' });
    const ok = await call(getSummary, httpEvent({ pathParameters: { jobId: JOB_ID } }));
    expect(ok.statusCode).toBe(200);
    expect(json(ok).status).toBe('processing');
    const bad = await call(getSummary, httpEvent({ pathParameters: { jobId: 'nope' } }));
    expect(bad.statusCode).toBe(400);
  });
});

describe('authenticated identity', () => {
  const uploadBody = { fileName: 'a.pdf', contentType: 'application/pdf', size: 10 };

  it('passes the JWT sub (not a body userId) to createUpload', async () => {
    vi.mocked(uploadService.createUpload).mockResolvedValue({ documentId: DOC_ID, key: 'k', uploadUrl: 'u', expiresIn: 900 });
    const res = await call(createUpload, httpEvent({ body: JSON.stringify({ ...uploadBody, userId: OTHER_USER_ID }) }));
    expect(res.statusCode).toBe(201);
    expect(uploadService.createUpload).toHaveBeenCalledWith(uploadBody, USER_ID, expect.anything());
  });

  it('passes the JWT sub to completeUpload', async () => {
    vi.mocked(uploadService.completeUpload).mockResolvedValue({ documentId: DOC_ID, status: 'uploaded', fileName: 'a.pdf' });
    await call(completeUpload, httpEvent({ pathParameters: { documentId: DOC_ID } }));
    expect(uploadService.completeUpload).toHaveBeenCalledWith(DOC_ID, USER_ID, expect.anything());
  });

  it('passes the JWT sub (not a body userId) to createSummaryJob', async () => {
    vi.mocked(summaryService.createSummaryJob).mockResolvedValue({ jobId: JOB_ID, documentId: DOC_ID, status: 'queued' });
    await call(createSummary, httpEvent({ body: JSON.stringify({ documentId: DOC_ID, style: 'concise', userId: OTHER_USER_ID }) }));
    expect(summaryService.createSummaryJob).toHaveBeenCalledWith(
      { documentId: DOC_ID, style: 'concise', idempotencyKey: undefined, userId: USER_ID },
      expect.anything(),
    );
  });

  it('passes the JWT sub to getSummaryJob, ignoring a userId query parameter', async () => {
    vi.mocked(summaryService.getSummaryJob).mockResolvedValue({ jobId: JOB_ID, documentId: DOC_ID, status: 'queued' });
    await call(
      getSummary,
      httpEvent({
        pathParameters: { jobId: JOB_ID },
        queryStringParameters: { userId: OTHER_USER_ID },
        requestContext: jwtRequestContext(OTHER_USER_ID),
      }),
    );
    expect(summaryService.getSummaryJob).toHaveBeenCalledWith(JOB_ID, OTHER_USER_ID, expect.anything());
  });

  it.each([
    ['createUpload', () => createUpload, { body: JSON.stringify(uploadBody) }],
    ['completeUpload', () => completeUpload, { pathParameters: { documentId: DOC_ID } }],
    ['createSummary', () => createSummary, { body: JSON.stringify({ documentId: DOC_ID, style: 'concise' }) }],
    ['getSummary', () => getSummary, { pathParameters: { jobId: JOB_ID } }],
  ] as const)('%s returns 401 { message, code } and calls no service when the sub claim is missing', async (_name, h, overrides) => {
    const res = await call(h(), unauthenticatedEvent(overrides));
    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual({ message: 'Authentication is required.', code: 'UNAUTHORIZED' });
    for (const fn of [...Object.values(uploadService), ...Object.values(summaryService)]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
