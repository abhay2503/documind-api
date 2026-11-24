import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { getAuthenticatedUser, getAuthenticatedUserId } from '../../src/utils/auth';
import { UnauthorizedError } from '../../src/utils/errors';
import { httpEvent, jwtRequestContext, jwtRequestContextWithGroups, unauthenticatedEvent, USER_ID } from '../helpers';

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

describe('getAuthenticatedUser (admin detection from cognito:groups)', () => {
  const groupsEvent = (groups: unknown) => httpEvent({ requestContext: jwtRequestContextWithGroups(groups) });

  it.each([
    ['HTTP API flattened string, single group', '[admin]'],
    ['HTTP API flattened string, several groups', '[editors admin]'],
    ['JSON array', ['users', 'admin']],
    ['JSON-style string', '["users","admin"]'],
    ['plain string', 'admin'],
  ])('isAdmin=true for %s', (_label, groups) => {
    expect(getAuthenticatedUser(groupsEvent(groups))).toEqual({ userId: USER_ID, isAdmin: true });
  });

  it.each([
    ['no groups claim', undefined],
    ['empty groups', '[]'],
    ['other groups only', '[users editors]'],
    ['similar but different names', '[administrators Admin admins]'],
    ['non-string values', [1, true]],
  ])('isAdmin=false for %s', (_label, groups) => {
    expect(getAuthenticatedUser(groupsEvent(groups)).isAdmin).toBe(false);
  });

  it('never derives admin from the body, query string or headers', () => {
    const event = httpEvent({
      body: JSON.stringify({ isAdmin: true, groups: ['admin'] }),
      queryStringParameters: { isAdmin: 'true' },
      headers: { 'cognito:groups': '[admin]', 'x-is-admin': 'true' },
    });
    expect(getAuthenticatedUser(event)).toEqual({ userId: USER_ID, isAdmin: false });
  });

  it('still throws 401 when the sub claim is missing, even with an admin group', () => {
    expect(() => getAuthenticatedUser(httpEvent({ requestContext: jwtRequestContextWithGroups('[admin]', null) }))).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
});
