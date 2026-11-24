import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { SummaryJobWithDocumentRow } from '../src/types/db';
import { createLogger } from '../src/utils/logger';

export const silentLog = createLogger({}, 'error');

export const DOC_ID = 'doc_0123456789abcdef0123456789abcdef';
export const JOB_ID = 'job_0123456789abcdef0123456789abcdef';
/** Cognito `sub` values (UUIDs) for the authenticated user and some other user. */
export const USER_ID = '11111111-2222-4333-8444-555555555555';
export const OTHER_USER_ID = '99999999-8888-4777-8666-555555555555';

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
    user_id: USER_ID,
    ...overrides,
  };
}

/** The requestContext API Gateway's JWT authorizer produces for a validated Cognito access token. */
export function jwtRequestContext(sub: unknown = USER_ID): APIGatewayProxyEventV2['requestContext'] {
  return {
    authorizer: { jwt: { claims: { sub, client_id: 'test-client', token_use: 'access' }, scopes: null } },
  } as unknown as APIGatewayProxyEventV2['requestContext'];
}

/** Like jwtRequestContext, with a `cognito:groups` claim (HTTP API delivers it as a string like "[admin]"). */
export function jwtRequestContextWithGroups(groups: unknown, sub: unknown = USER_ID): APIGatewayProxyEventV2['requestContext'] {
  const ctx = jwtRequestContext(sub) as unknown as { authorizer: { jwt: { claims: Record<string, unknown> } } };
  ctx.authorizer.jwt.claims['cognito:groups'] = groups;
  return ctx as unknown as APIGatewayProxyEventV2['requestContext'];
}

/** An HTTP API event, authenticated as USER_ID by default (override requestContext to change that). */
export function httpEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /test',
    rawPath: '/test',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: jwtRequestContext(),
    ...overrides,
  };
}

/** An event with no authorizer claims (only possible if a route skipped the API Gateway authorizer). */
export function unauthenticatedEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return httpEvent({ requestContext: {} as APIGatewayProxyEventV2['requestContext'], ...overrides });
}

export const lambdaContext = { awsRequestId: 'req-test' } as Context;
