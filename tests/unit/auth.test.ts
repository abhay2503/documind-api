import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { getAuthenticatedUserId } from '../../src/utils/auth';
import { UnauthorizedError } from '../../src/utils/errors';
import { httpEvent, jwtRequestContext, unauthenticatedEvent, USER_ID } from '../helpers';

const withContext = (requestContext: unknown) =>
  httpEvent({ requestContext: requestContext as APIGatewayProxyEventV2['requestContext'] });

describe('getAuthenticatedUserId', () => {
  it('returns the Cognito sub from the API Gateway JWT authorizer claims', () => {
    expect(getAuthenticatedUserId(httpEvent())).toBe(USER_ID);
  });

  it('ignores identity supplied in the body, query string or headers', () => {
    const event = httpEvent({
      body: JSON.stringify({ userId: 'attacker' }),
      queryStringParameters: { userId: 'attacker' },
      headers: { 'x-user-id': 'attacker' },
    });
    expect(getAuthenticatedUserId(event)).toBe(USER_ID);
  });

  it.each([
    ['no authorizer', unauthenticatedEvent()],
    ['no jwt', withContext({ authorizer: {} })],
    ['no claims', withContext({ authorizer: { jwt: { scopes: null } } })],
    ['no sub', withContext({ authorizer: { jwt: { claims: { client_id: 'c' } } } })],
    ['empty sub', httpEvent({ requestContext: jwtRequestContext('  ') })],
    ['non-string sub', httpEvent({ requestContext: jwtRequestContext(123) })],
  ])('throws a 401 UnauthorizedError when there is %s', (_label, event) => {
    expect(() => getAuthenticatedUserId(event)).toThrow(UnauthorizedError);
    expect(() => getAuthenticatedUserId(event)).toThrow(expect.objectContaining({ statusCode: 401, code: 'UNAUTHORIZED' }));
  });
});
