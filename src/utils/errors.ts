/**
 * Application errors carry an HTTP status, a stable machine-readable code and a user-safe message.
 * Anything that is not an AppError is reported to clients as a generic 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(code: 'DOCUMENT_NOT_FOUND' | 'JOB_NOT_FOUND' | 'ROUTE_NOT_FOUND', message: string) {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(code: 'DAILY_SUMMARY_LIMIT_REACHED', message: string) {
    super(429, code, message);
  }
}

export class FileTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'FILE_TOO_LARGE', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: 'QUEUE_UNAVAILABLE' | 'DATABASE_UNAVAILABLE' | 'STORAGE_UNAVAILABLE', message: string) {
    super(503, code, message);
  }
}
