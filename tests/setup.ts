import { setConfigForTests } from '../src/config';

process.env.LOG_LEVEL = 'error';

// Presigning a URL is a local signing operation that still needs credentials (no network call, so
// aws-sdk-client-mock cannot intercept it). Use obviously fake ones so unit tests behave the same on a
// developer machine (~/.aws) and in CI (no credentials), and never pick up real credentials.
process.env.AWS_ACCESS_KEY_ID = 'unit-test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'unit-test-secret-key';
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;

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
