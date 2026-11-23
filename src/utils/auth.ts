import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { UnauthorizedError } from './errors';

/** The JWT claims API Gateway's Cognito authorizer attaches after validating the access token. */
type JwtRequestContext = { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };

/**
 * Returns the authenticated user's Cognito `sub`, taken only from the claims API Gateway verified.
 * Never reads identity from the body, query string or headers. Throws 401 if the claim is missing,
 * which only happens if a route is reachable without the authorizer.
 */
export function getAuthenticatedUserId(event: APIGatewayProxyEventV2): string {
  const sub = (event.requestContext as JwtRequestContext | undefined)?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new UnauthorizedError();
  }
  return sub;
}
