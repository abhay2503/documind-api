import { setConfigForTests } from '../src/config';

process.env.LOG_LEVEL = 'error';

setConfigForTests({
  nodeEnv: 'test',
  awsRegion: 'ap-south-1',
  logLevel: 'error',
  db: { host: '127.0.0.1', port: 5432, user: 'test', password: '', database: 'documind_test', sslMode: 'disable', connectionLimit: 1 },
  s3BucketName: 'documind-test-bucket',
  sqsQueueUrl: 'https://sqs.ap-south-1.amazonaws.com/000000000000/documind-summary-queue-test',
  uploadUrlExpiresSeconds: 900,
  maxUploadBytes: 10 * 1024 * 1024,
  localAwsEndpoint: undefined,
});
