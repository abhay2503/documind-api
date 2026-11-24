import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { UnauthorizedError } from './errors';

/** The JWT claims API Gateway's Cognito authorizer attaches after validating the access token. */
type JwtRequestContext = { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };

/** Cognito group whose members get the admin daily summary limit. */
export const ADMIN_GROUP = 'admin';

export interface AuthenticatedUser {
  /** Cognito `sub`. */
  userId: string;
  /** True when the validated token's `cognito:groups` contains the `admin` group. */
  isAdmin: boolean;
}

function verifiedClaims(event: APIGatewayProxyEventV2): Record<string, unknown> | undefined {
  return (event.requestContext as JwtRequestContext | undefined)?.authorizer?.jwt?.claims;
}

/**
 * Returns the authenticated user's Cognito `sub`, taken only from the claims API Gateway verified.
 * Never reads identity from the body, query string or headers. Throws 401 if the claim is missing,
 * which only happens if a route is reachable without the authorizer.
 */
export function getAuthenticatedUserId(event: APIGatewayProxyEventV2): string {
  const sub = verifiedClaims(event)?.sub;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new UnauthorizedError();
  }
  return sub;
}

/**
 * Parses `cognito:groups`. HTTP API passes array claims to Lambda flattened into a string such as
 * "[admin editors]"; a real JSON array is accepted too (e.g. in tests or a future payload format).
 */
function parseGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((g): g is string => typeof g === 'string');
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((g) => g.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** The authenticated user and their role, derived only from the verified JWT claims (never the request). */
export function getAuthenticatedUser(event: APIGatewayProxyEventV2): AuthenticatedUser {
  const userId = getAuthenticatedUserId(event);
  const isAdmin = parseGroups(verifiedClaims(event)?.['cognito:groups']).includes(ADMIN_GROUP);
  return { userId, isAdmin };
}
