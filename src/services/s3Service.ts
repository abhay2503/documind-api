import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConfig } from '../config';
import { ServiceUnavailableError } from '../utils/errors';
import { awsClientOptions } from './awsClientOptions';

let client: S3Client | undefined;

function s3(): S3Client {
  client ??= new S3Client({
    ...awsClientOptions(),
    // Path-style URLs for LocalStack so presigned URLs point at http://localhost:4566/<bucket>/<key>.
    forcePathStyle: Boolean(getConfig().localAwsEndpoint),
    // Don't add flexible checksum parameters to presigned PUT URLs; browsers can't supply them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

/** Presigned PUT; the content type is part of the signature, so the browser must send the same header. */
export async function presignPutUrl(key: string, contentType: string, expiresIn: number): Promise<string> {
  const command = new PutObjectCommand({ Bucket: getConfig().s3BucketName, Key: key, ContentType: contentType });
  // signableHeaders forces Content-Type into X-Amz-SignedHeaders so S3 rejects a mismatched type.
  return getSignedUrl(s3(), command, { expiresIn, signableHeaders: new Set(['content-type']) });
}

export interface ObjectMetadata {
  contentLength: number;
  contentType: string | undefined;
}

/** Returns null when the object does not exist. */
export async function headObject(key: string): Promise<ObjectMetadata | null> {
  try {
    const out = await s3().send(new HeadObjectCommand({ Bucket: getConfig().s3BucketName, Key: key }));
    return { contentLength: out.ContentLength ?? 0, contentType: out.ContentType };
  } catch (err) {
    if (err instanceof S3ServiceException && (err.name === 'NotFound' || err.$metadata.httpStatusCode === 404)) {
      return null;
    }
    throw storageUnavailable(err);
  }
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: getConfig().s3BucketName, Key: key }));
  } catch (err) {
    throw storageUnavailable(err);
  }
}

function storageUnavailable(cause: unknown): Error {
  const error = new ServiceUnavailableError('STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.');
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/** Test helper. */
export function setS3ClientForTests(c: S3Client | undefined): void {
  client = c;
}
