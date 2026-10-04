// GlobalExceptionFilter - catch-all safety net (2026-10-04).
//
// WHY: reported bug - POST /api/users with a duplicate email threw a raw
// `PrismaClientKnownRequestError` out of UsersService.create(). With no
// global filter, Nest's default `ExceptionsHandler` serialized that as
// `{"statusCode":500,"message":"Internal server error"}` - the web BFF
// client (apps/web/src/apis/client.ts) unwraps `message` and toasts it
// VERBATIM, so the user saw a useless "Internal server error" toast
// instead of "A user with this email already exists...".
//
// users.service.ts now catches that SPECIFIC case locally (ConflictException
// with a precise message - see rethrowAsEmailConflict), because the
// business meaning ("which field, which org") is only known at the call
// site. This filter is the net for everything NOT caught locally:
//   - any other PrismaClientKnownRequestError (unique/FK/not-found) that a
//     service forgot to translate,
//   - PrismaClientValidationError (malformed query - a programming error,
//     not a client error, but must not 500 with no body),
//   - any other uncaught Error (bug, 3rd-party throw, etc.).
//
// CONTRACT: every response body is the SAME `{ code, message, details? }`
// envelope `CodedException` already produces (T-TEAM-AUTHORITATIVE #39), so
// the BFF client's unwrap logic needs no changes.
//
// `HttpException` (including `CodedException`) is passed through AS-IS:
// Nest already returns its response body unwrapped, and that body is
// exactly what the client expects - this filter must not re-wrap it or it
// would double-shape every existing coded/validation error path.
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@shadhil/database';

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
}

/** Prisma error codes this filter knows how to translate into an envelope. */
const PRISMA_STATUS_BY_CODE: Record<string, number> = {
  P2002: HttpStatus.CONFLICT, // unique constraint violation
  P2025: HttpStatus.NOT_FOUND, // record required but not found
  P2003: HttpStatus.BAD_REQUEST, // foreign key constraint violation
  P2000: HttpStatus.BAD_REQUEST, // value too long for column type
  P2011: HttpStatus.BAD_REQUEST, // null constraint violation
};

function prismaFieldTarget(err: Prisma.PrismaClientKnownRequestError): string | null {
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.join(', ');
  if (typeof target === 'string') return target;
  return null;
}

function toEnvelopeForPrismaError(
  err: Prisma.PrismaClientKnownRequestError,
): { status: number; body: ErrorEnvelope } {
  const status = PRISMA_STATUS_BY_CODE[err.code] ?? HttpStatus.BAD_REQUEST;
  const field = prismaFieldTarget(err);

  switch (err.code) {
    case 'P2002':
      return {
        status,
        body: {
          code: 'DUPLICATE_VALUE',
          message: field
            ? `A record with this ${field} already exists.`
            : 'A record with these values already exists.',
          details: { field },
        },
      };
    case 'P2025':
      return {
        status,
        body: { code: 'RECORD_NOT_FOUND', message: 'The requested record was not found.' },
      };
    case 'P2003':
      return {
        status,
        body: {
          code: 'INVALID_REFERENCE',
          message: 'This action references a record that does not exist.',
        },
      };
    default:
      return {
        status,
        body: { code: 'DATABASE_ERROR', message: 'The request could not be completed.' },
      };
  }
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 1. Already a shaped HttpException (CodedException, NotFoundException,
    //    class-validator 400 arrays, the PASSWORD_CHANGE_REQUIRED 403, ...).
    //    Nest's contract is "return the exception body AS-IS" - preserve it
    //    exactly, just log server-side for 5xx (there shouldn't be any).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        this.logger.error(
          `${request.method} ${request.url} ${status}: ${exception.message}`,
          exception.stack,
        );
      }
      response.status(status).json(exception.getResponse());
      return;
    }

    // 2. Prisma errors a service forgot to translate locally.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const { status, body } = toEnvelopeForPrismaError(exception);
      this.logger.warn(
        `${request.method} ${request.url} Prisma ${exception.code} (untranslated) -> ${status}: ${exception.message}`,
      );
      response.status(status).json(body);
      return;
    }

    if (
      exception instanceof Prisma.PrismaClientValidationError ||
      exception instanceof Prisma.PrismaClientInitializationError
    ) {
      this.logger.error(
        `${request.method} ${request.url} ${exception.constructor.name}`,
        exception.stack,
      );
      const body: ErrorEnvelope = {
        code: 'INVALID_REQUEST',
        message: 'The request could not be processed. Please check the submitted data.',
      };
      response.status(HttpStatus.BAD_REQUEST).json(body);
      return;
    }

    // 3. Truly unknown - a bug. Log the FULL error server-side (stack and
    //    all), but NEVER leak internals (stack traces, SQL, file paths) to
    //    the client - that is exactly how "Internal server error" with no
    //    useful message happened in the first place; the fix is a message
    //    that is both safe AND human, not a leakier one.
    const err = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`${request.method} ${request.url} UNHANDLED: ${err.message}`, err.stack);
    const body: ErrorEnvelope = {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our end. Please try again, or contact support if the problem persists.',
    };
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}
