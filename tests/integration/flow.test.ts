/**
 * Opt-in end-to-end test against LocalStack (S3/SQS) and the local MySQL database.
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
import { silentLog } from '../helpers';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('upload → complete → summary job (LocalStack + MySQL)', () => {
  if (enabled) {
    process.loadEnvFile('.env');
    setConfigForTests(loadConfig({ ...process.env, NODE_ENV: 'development' }));
  }

  afterAll(async () => {
    await closePool();
  });

  it('runs the full API flow and publishes identifiers to SQS', async () => {
    const content = Buffer.from('DocuMind integration test document.\n');

    const upload = await createUpload({ fileName: 'integration.txt', contentType: 'text/plain', size: content.length }, silentLog);

    // Before the PUT, completion must fail.
    await expect(completeUpload(upload.documentId, silentLog)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });

    const put = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content });
    expect(put.status).toBe(200);

    await expect(completeUpload(upload.documentId, silentLog)).resolves.toMatchObject({ status: 'uploaded' });
    // Idempotent.
    await expect(completeUpload(upload.documentId, silentLog)).resolves.toMatchObject({ status: 'uploaded' });

    const job = await createSummaryJob({ documentId: upload.documentId, style: 'bullets' }, silentLog);
    expect(job.status).toBe('queued');

    // Double click returns the same active job.
    const again = await createSummaryJob({ documentId: upload.documentId, style: 'bullets' }, silentLog);
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

    await expect(getSummaryJob(job.jobId, silentLog)).resolves.toMatchObject({ status: 'queued' });

    // Simulate the Python worker completing the job.
    await execute(
      getPool(),
      `UPDATE summary_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP(3),
         result = JSON_OBJECT('overview', 'Test overview', 'keyPoints', JSON_ARRAY('a'),
                              'findings', JSON_ARRAY(), 'actionItems', JSON_ARRAY())
       WHERE job_id = ?`,
      [job.jobId],
    );
    const done = await getSummaryJob(job.jobId, silentLog);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ documentName: 'integration.txt', style: 'bullets', overview: 'Test overview' });
  });
});
