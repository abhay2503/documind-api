import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { SummaryJobWithDocumentRow } from '../src/types/db';
import { createLogger } from '../src/utils/logger';

export const silentLog = createLogger({}, 'error');

export const DOC_ID = 'doc_0123456789abcdef0123456789abcdef';
export const JOB_ID = 'job_0123456789abcdef0123456789abcdef';

export function jobRow(overrides: Partial<SummaryJobWithDocumentRow> = {}): SummaryJobWithDocumentRow {
  return {
    job_id: JOB_ID,
    document_id: DOC_ID,
    status: 'queued',
    stage: null,
    summary_style: 'bullet_points',
    instructions: null,
    result: null,
    error_code: null,
    error_message: null,
    publish_attempts: 1,
    published_at: new Date('2026-01-01T10:00:01Z'),
    created_at: new Date('2026-01-01T10:00:00Z'),
    completed_at: null,
    file_name: 'invoice.pdf',
    user_id: null,
    ...overrides,
  };
}

export function httpEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /test',
    rawPath: '/test',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {} as APIGatewayProxyEventV2['requestContext'],
    ...overrides,
  };
}

export const lambdaContext = { awsRequestId: 'req-test' } as Context;
