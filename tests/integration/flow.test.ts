/**
 * Opt-in end-to-end test against LocalStack (S3/SQS) and the local PostgreSQL database.
 * Prerequisites: docker compose up -d, database/setup-local.sql, npm run migrate, a filled-in .env.
 * Run with: npm run test:integration
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, setConfigForTests } from '../../src/config';
import { closePool, execute, getPool } from '../../src/database/pool';
import { awsClientOptions } from '../../src/services/awsClientOptions';
import { getSummaryJob, createSummaryJob } from '../../src/services/summaryService';
import { completeUpload, createUpload } from '../../src/services/uploadService';
import { OTHER_USER_ID, silentLog, USER_ID } from '../helpers';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('upload → complete → summary job (LocalStack + PostgreSQL)', () => {
  if (enabled) {
    process.loadEnvFile('.env');
    setConfigForTests(loadConfig({ ...process.env, NODE_ENV: 'development' }));
  }

  afterAll(async () => {
    await closePool();
  });

  it('runs the full API flow and publishes identifiers to SQS', async () => {
    const content = Buffer.from('DocuMind integration test document.\n');

    const upload = await createUpload({ fileName: 'integration.txt', contentType: 'text/plain', size: content.length }, USER_ID, silentLog);

    // Before the PUT, completion must fail.
    await expect(completeUpload(upload.documentId, USER_ID, silentLog)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });

    const put = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content });
    expect(put.status).toBe(200);

    await expect(completeUpload(upload.documentId, USER_ID, silentLog)).resolves.toMatchObject({ status: 'uploaded' });
    // Idempotent.
    await expect(completeUpload(upload.documentId, USER_ID, silentLog)).resolves.toMatchObject({ status: 'uploaded' });

    const job = await createSummaryJob({ userId: USER_ID, documentId: upload.documentId, style: 'bullets' }, silentLog);
    expect(job.status).toBe('queued');

    // Double click returns the same active job.
    const again = await createSummaryJob({ userId: USER_ID, documentId: upload.documentId, style: 'bullets' }, silentLog);
    expect(again.jobId).toBe(job.jobId);

    const sqs = new SQSClient(awsClientOptions());
    const queueUrl = loadConfig({ ...process.env, NODE_ENV: 'development' }).sqsQueueUrl;
    let body: unknown;
    for (let i = 0; i < 5 && body === undefined; i++) {
      const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
      for (const m of out.Messages ?? []) {
        const parsed = JSON.parse(m.Body ?? '{}');
        if (parsed.jobId === job.jobId) {
          body = parsed;
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
        }
      }
    }
    expect(body).toEqual({ jobId: job.jobId, documentId: upload.documentId });

    // Another authenticated user cannot see or act on this user's document or job.
    await expect(completeUpload(upload.documentId, OTHER_USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      createSummaryJob({ userId: OTHER_USER_ID, documentId: upload.documentId, style: 'concise' }, silentLog),
    ).rejects.toMatchObject({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    await expect(getSummaryJob(job.jobId, OTHER_USER_ID, silentLog)).rejects.toMatchObject({ statusCode: 404, code: 'JOB_NOT_FOUND' });

    await expect(getSummaryJob(job.jobId, USER_ID, silentLog)).resolves.toMatchObject({ status: 'queued' });

    // Simulate the Python worker completing the job.
    await execute(
      getPool(),
      `UPDATE summary_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP(3),
         result = jsonb_build_object('overview', 'Test overview', 'keyPoints', jsonb_build_array('a'),
                                    'findings', jsonb_build_array(), 'actionItems', jsonb_build_array())
       WHERE job_id = $1`,
      [job.jobId],
    );
    const done = await getSummaryJob(job.jobId, USER_ID, silentLog);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ documentName: 'integration.txt', style: 'bullets', overview: 'Test overview' });
  });
});
