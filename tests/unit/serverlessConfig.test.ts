/**
 * Static guard for the API Gateway side of authentication. API Gateway (not Lambda) rejects requests
 * with a missing or invalid JWT, so unit tests cannot exercise it; instead this asserts that the
 * deployed configuration attaches the Cognito JWT authorizer to every route and allows the
 * Authorization header through CORS. Live 401 behavior is verified after deploy (see README).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface HttpApiEvent {
  httpApi: { method: string; path: string; authorizer?: { name?: string } };
}

const config = parse(readFileSync(new URL('../../serverless.yml', import.meta.url), 'utf8'), {
  // CloudFormation intrinsic tags used elsewhere in the file; their values are irrelevant here.
  customTags: [
    { tag: '!Ref', resolve: (value: string) => ({ Ref: value }) },
    { tag: '!GetAtt', resolve: (value: string) => ({ 'Fn::GetAtt': value }) },
  ],
}) as {
  provider: {
    httpApi: {
      cors: { allowedOrigins: string[]; allowedHeaders: string[]; allowedMethods: string[] };
      authorizers: Record<string, { type: string; identitySource: string; issuerUrl: string; audience: string[] }>;
    };
    environment: Record<string, string>;
  };
  functions: Record<string, { events: HttpApiEvent[] }>;
};

const PROTECTED_ROUTES = [
  'POST /uploads',
  'POST /documents/{documentId}/complete',
  'POST /summaries',
  'GET /summaries/{jobId}',
];

describe('serverless.yml: Cognito JWT authorizer', () => {
  it('defines a native HTTP API JWT authorizer for the existing Cognito User Pool', () => {
    expect(config.provider.httpApi.authorizers.cognitoJwt).toEqual({
      type: 'jwt',
      identitySource: '$request.header.Authorization',
      issuerUrl: 'https://cognito-idp.ap-south-1.amazonaws.com/${env:COGNITO_USER_POOL_ID}',
      audience: ['${env:COGNITO_APP_CLIENT_ID}'],
    });
  });

  it('protects every route with that authorizer (no request without a valid JWT reaches Lambda)', () => {
    const routes = Object.values(config.functions).flatMap((fn) => fn.events.map((e) => e.httpApi));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...PROTECTED_ROUTES].sort());
    for (const route of routes) {
      expect(route.authorizer, `${route.method} ${route.path}`).toEqual({ name: 'cognitoJwt' });
    }
  });

  it('does not hardcode Cognito IDs or pass them to Lambda', () => {
    const raw = readFileSync(new URL('../../serverless.yml', import.meta.url), 'utf8');
    expect(raw).not.toMatch(/ap-south-1_[A-Za-z0-9]+/);
    expect(Object.keys(config.provider.environment).filter((k) => k.startsWith('COGNITO'))).toEqual([]);
  });
});

describe('serverless.yml: CORS', () => {
  it('allows the Authorization header while keeping existing headers, origins and methods', () => {
    const { cors } = config.provider.httpApi;
    expect(cors.allowedHeaders).toEqual(['Content-Type', 'Idempotency-Key', 'Authorization']);
    expect(cors.allowedOrigins).toEqual(['${env:CORS_ALLOWED_ORIGIN}']);
    expect(cors.allowedMethods).toEqual(['GET', 'POST', 'OPTIONS']);
  });
});
