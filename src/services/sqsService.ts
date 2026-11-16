import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getConfig } from '../config';
import { awsClientOptions } from './awsClientOptions';

let client: SQSClient | undefined;

function sqs(): SQSClient {
  client ??= new SQSClient({ ...awsClientOptions(), maxAttempts: 3 });
  return client;
}

/** Message consumed by the Python AI worker. Identifiers only — never document content. */
export interface SummaryJobMessage {
  jobId: string;
  documentId: string;
}

export async function publishSummaryJob(message: SummaryJobMessage): Promise<void> {
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: getConfig().sqsQueueUrl,
      MessageBody: JSON.stringify({ jobId: message.jobId, documentId: message.documentId }),
    }),
  );
}

/** Test helper. */
export function setSqsClientForTests(c: SQSClient | undefined): void {
  client = c;
}
