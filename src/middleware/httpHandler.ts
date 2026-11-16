import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { z } from 'zod';
import type { ErrorResponse } from '../types/api';
import { AppError, ValidationError } from '../utils/errors';
import { logger, type Logger } from '../utils/logger';

export interface HttpRequest {
  event: APIGatewayProxyEventV2;
  /** Parsed JSON body (undefined when the request has no body). */
  body: unknown;
  log: Logger;
}

export interface HttpResponse<T> {
  statusCode: number;
  body: T;
}

type Route<T> = (req: HttpRequest) => Promise<HttpResponse<T>>;

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
}

/**
 * Wraps a route with JSON parsing, structured request logging and centralized error handling.
 * Clients only ever see { message, code } for errors — never stack traces, SQL or AWS details.
 */
export function withHttp<T>(route: Route<T>) {
  return async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResultV2> => {
    const started = Date.now();
    const log = logger.child({
      requestId: context.awsRequestId,
      route: event.routeKey,
    });

    try {
      const body = parseBody(event);
      const result = await route({ event, body, log });
      log.info('Request completed', { statusCode: result.statusCode, durationMs: Date.now() - started });
      return respond(result.statusCode, result.body);
    } catch (err) {
      if (err instanceof AppError) {
        const level = err.statusCode >= 500 ? 'error' : 'info';
        log[level]('Request failed', {
          statusCode: err.statusCode,
          code: err.code,
          durationMs: Date.now() - started,
          ...(err.statusCode >= 500 ? { err: (err as Error & { cause?: unknown }).cause ?? err } : {}),
        });
        const payload: ErrorResponse = { message: err.message, code: err.code };
        return respond(err.statusCode, payload);
      }
      log.error('Unhandled error', { err, durationMs: Date.now() - started });
      const payload: ErrorResponse = { message: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' };
      return respond(500, payload);
    }
  };
}

/** Validates input against a zod schema, converting failures into a 400 with the first problem. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.');
    throw new ValidationError(field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Invalid request.'));
  }
  return parsed.data;
}
