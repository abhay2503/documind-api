import { z } from 'zod';

/**
 * The only module that reads process.env. Values are validated once per Lambda container
 * and the process fails fast (500 on first request, clear log line) if configuration is invalid.
 */
const optionalUrl = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== '' ? value.trim() : undefined))
  .pipe(z.url().optional());

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    AWS_REGION: z.string().min(1).default('ap-south-1'),
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().default(''),
    DB_NAME: z.string().min(1),
    DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(10).default(2),
    S3_BUCKET_NAME: z.string().min(3),
    SQS_QUEUE_URL: z.url(),
    UPLOAD_URL_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    LOCAL_AWS_ENDPOINT: optionalUrl,
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.LOCAL_AWS_ENDPOINT) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_AWS_ENDPOINT'],
        message: 'LOCAL_AWS_ENDPOINT must not be set in production',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  awsRegion: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
  };
  s3BucketName: string;
  sqsQueueUrl: string;
  uploadUrlExpiresSeconds: number;
  maxUploadBytes: number;
  /** LocalStack endpoint for local development only; undefined in AWS. */
  localAwsEndpoint?: string;
}

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    awsRegion: e.AWS_REGION,
    logLevel: e.LOG_LEVEL,
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      database: e.DB_NAME,
      connectionLimit: e.DB_CONNECTION_LIMIT,
    },
    s3BucketName: e.S3_BUCKET_NAME,
    sqsQueueUrl: e.SQS_QUEUE_URL,
    uploadUrlExpiresSeconds: e.UPLOAD_URL_EXPIRES_SECONDS,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    localAwsEndpoint: e.LOCAL_AWS_ENDPOINT,
  };
}

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: override or clear the cached configuration. */
export function setConfigForTests(config: AppConfig | undefined): void {
  cached = config;
}
