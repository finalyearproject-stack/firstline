/**
 * Error types and the central error handler.
 *
 * Two rules drive the design (spec s17: secure error handling):
 *   1. Clients receive a stable error `code` and a message safe to display. They never
 *      receive a stack trace, a SQL fragment, or a driver message.
 *   2. The server logs the full detail, with patient data omitted.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config.ts';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: FieldError[] | undefined;

  constructor(code: ErrorCode, message: string, fields?: FieldError[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.fields = fields;
  }

  static validation(message: string, fields?: FieldError[]): ApiError {
    return new ApiError('VALIDATION_FAILED', message, fields);
  }
  static unauthenticated(message = 'Authentication is required.'): ApiError {
    return new ApiError('UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have permission to do that.'): ApiError {
    return new ApiError('FORBIDDEN', message);
  }
  static notFound(what = 'Resource'): ApiError {
    return new ApiError('NOT_FOUND', `${what} not found.`);
  }
  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message);
  }
}

interface BodyParserError extends Error {
  type: string;
  status: number;
}

/** body-parser tags its errors with `type` and an HTTP `status`. */
function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    typeof (error as BodyParserError).type === 'string' &&
    (error as BodyParserError).type.startsWith('entity.')
  );
}

function zodFields(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Express error handler. Must keep all four parameters to be recognised as one. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Some of the information sent was not valid.',
        fields: zodFields(error),
      },
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      },
    });
    return;
  }

  // body-parser rejects a malformed or oversized body before any route runs. These are
  // client errors, not server faults, and must not be reported as 500 — a CHW client
  // treats 5xx as "the server is broken, retry later" and would requeue a payload that
  // will never be accepted.
  if (isBodyParserError(error)) {
    const tooLarge = error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
        message: tooLarge
          ? 'The request body is too large.'
          : 'The request body could not be read as JSON.',
      },
    });
    return;
  }

  // Anything reaching here is unexpected. Log it in full, disclose nothing.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[error] ${req.method} ${req.path}\n${detail}`);

  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on the server. The request was not completed.',
      // Never in production: the stack is for the developer's terminal, not the wire.
      ...(config.isProduction ? {} : { detail: detail.split('\n')[0] }),
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}.` },
  });
}

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function asyncRoute<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req as T, res, next).catch(next);
  };
}
