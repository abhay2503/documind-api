import { describe, expect, it } from 'vitest';
import { toApiStatus, toApiStyle, toApiSummaryJob, toDbStyle } from '../../src/utils/contract';
import { jobRow, silentLog } from '../helpers';

describe('contract mapping', () => {
  it('translates styles both ways', () => {
    expect(toDbStyle('bullets')).toBe('bullet_points');
    expect(toDbStyle('insights')).toBe('key_insights');
    expect(toApiStyle('key_insights')).toBe('insights');
    expect(toApiStyle('concise')).toBe('concise');
  });

  it('maps completed to done', () => {
    expect(toApiStatus('completed')).toBe('done');
    expect(toApiStatus('queued')).toBe('queued');
  });

  it('returns queued job without result or stage', () => {
    expect(toApiSummaryJob(jobRow())).toEqual({ jobId: jobRow().job_id, documentId: jobRow().document_id, status: 'queued' });
  });

  it('includes a known stage only while processing', () => {
    expect(toApiSummaryJob(jobRow({ status: 'processing', stage: 'extracting' })).stage).toBe('extracting');
    expect(toApiSummaryJob(jobRow({ status: 'processing', stage: 'bogus' })).stage).toBeUndefined();
  });

  it('composes the frontend result for a completed job', () => {
    const completedAt = new Date('2026-11-16T10:05:00Z');
    const job = toApiSummaryJob(
      jobRow({
        status: 'completed',
        completed_at: completedAt,
        result: {
          overview: 'Overview',
          keyPoints: ['a'],
          findings: [{ title: 'T', detail: 'D' }],
          actionItems: ['do x'],
        },
      }),
    );
    expect(job.status).toBe('done');
    expect(job.result).toEqual({
      documentName: 'invoice.pdf',
      style: 'bullets',
      overview: 'Overview',
      keyPoints: ['a'],
      findings: [{ title: 'T', detail: 'D' }],
      actionItems: ['do x'],
      generatedAt: completedAt.toISOString(),
    });
  });

  it('accepts a result stored as a JSON string', () => {
    const job = toApiSummaryJob(jobRow({ status: 'completed', result: JSON.stringify({ overview: 'O' }) }));
    expect(job.result?.overview).toBe('O');
    expect(job.result?.keyPoints).toEqual([]);
  });

  it('reports an invalid worker result as failed', () => {
    const job = toApiSummaryJob(jobRow({ status: 'completed', result: { nope: true } }), silentLog);
    expect(job.status).toBe('failed');
    expect(job.result).toBeUndefined();
    expect(job.error).toBeTruthy();
  });

  it('uses a friendly message for publish failures and the worker message otherwise', () => {
    expect(toApiSummaryJob(jobRow({ status: 'failed', error_code: 'QUEUE_PUBLISH_FAILED' })).error).toMatch(
      /could not start processing/i,
    );
    expect(toApiSummaryJob(jobRow({ status: 'failed', error_message: 'The document is empty.' })).error).toBe(
      'The document is empty.',
    );
  });
});
