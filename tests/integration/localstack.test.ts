/**
 * Opt-in test of the S3/SQS integrations against LocalStack only (no database needed).
 * Prerequisites: docker compose up -d, a filled-in .env. Run with: npm run test:localstack
 */
import { DeleteMessageCommand, PurgeQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { loadConfig, setConfigForTests } from '../../src/config';
import { awsClientOptions } from '../../src/services/awsClientOptions';
import { deleteObject, headObject, presignPutUrl } from '../../src/services/s3Service';
import { publishSummaryJob } from '../../src/services/sqsService';
import { documentS3Key } from '../../src/utils/fileTypes';
import { newDocumentId, newJobId } from '../../src/utils/ids';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('LocalStack S3 + SQS', () => {
  if (enabled) {
    process.loadEnvFile('.env');
    setConfigForTests(loadConfig({ ...process.env, NODE_ENV: 'development' }));
  }
  const config = () => loadConfig({ ...process.env, NODE_ENV: 'development' });

  it('presigned URL points at localhost (browser-reachable, path-style)', async () => {
    const url = new URL(await presignPutUrl('documents/doc_x/a.txt', 'text/plain', 900));
    expect(url.origin).toBe('http://localhost:4566');
    expect(url.pathname).toBe(`/${config().s3BucketName}/documents/doc_x/a.txt`);
  });

  it('answers the browser CORS preflight for the frontend origin', async () => {
    const key = documentS3Key(newDocumentId(), 'cors.txt');
    const url = await presignPutUrl(key, 'text/plain', 900);
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });

  it('accepts a PUT with the signed Content-Type, then HEAD/DELETE work', async () => {
    const key = documentS3Key(newDocumentId(), 'sample.txt');
    const body = Buffer.from('hello documind\n');
    const put = await fetch(await presignPutUrl(key, 'text/plain', 900), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    expect(put.status).toBe(200);

    const head = await headObject(key);
    expect(head).toEqual({ contentLength: body.length, contentType: 'text/plain' });

    await deleteObject(key);
    expect(await headObject(key)).toBeNull();
  });

  it('rejects a PUT whose Content-Type differs from the signed one', async () => {
    const key = documentS3Key(newDocumentId(), 'evil.pdf');
    const put = await fetch(await presignPutUrl(key, 'application/pdf', 900), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<script></script>',
    });
    expect(put.status).toBe(403);
    expect(await headObject(key)).toBeNull();
  });

  it('returns null from headObject for a missing key', async () => {
    expect(await headObject('documents/doc_missing/none.pdf')).toBeNull();
  });

  it('publishes only {jobId, documentId} to the summary queue', async () => {
    const sqs = new SQSClient(awsClientOptions());
    const queueUrl = config().sqsQueueUrl;
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);

    const message = { jobId: newJobId(), documentId: newDocumentId() };
    await publishSummaryJob(message);

    let found: unknown;
    for (let i = 0; i < 5 && found === undefined; i++) {
      const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
      for (const m of out.Messages ?? []) {
        const parsed = JSON.parse(m.Body ?? '{}');
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
        if (parsed.jobId === message.jobId) found = parsed;
      }
    }
    expect(found).toEqual(message);
  });
});
