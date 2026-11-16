import { getConfig } from '../config';

/**
 * Shared AWS SDK client options. In AWS, credentials come from the Lambda execution role.
 * Locally (LOCAL_AWS_ENDPOINT set) clients target LocalStack with its dummy credentials.
 */
export function awsClientOptions() {
  const config = getConfig();
  if (!config.localAwsEndpoint) {
    return { region: config.awsRegion };
  }
  return {
    region: config.awsRegion,
    endpoint: config.localAwsEndpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
}
