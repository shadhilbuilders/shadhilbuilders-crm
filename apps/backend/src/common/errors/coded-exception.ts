// CodedException - T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit Trail
// #39 in IMPLEMENTATION-PLAN-v1.md), plan Dependencies: "Make Nest emit the
// existing { code, message, details, requestId } envelope and extend web
// ApiError to preserve it."
//
// Formalizes the ad-hoc pattern already used by JwtAuthGuard's
// PASSWORD_CHANGE_REQUIRED error: NestJS returns an HttpException's object
// body AS-IS (no wrapping), so `throw new HttpException({ code, message },
// status)` already produces exactly the envelope shape we want - no global
// exception filter needed. This class is just the reusable, typed
// constructor for that same pattern, so every new stable-error-code
// throw site (team removal, project-team linking) stays consistent
// instead of re-typing the object literal.
//
// `requestId` is intentionally NOT a constructor param: only the
// idempotent reassign-and-remove endpoint has a client-supplied requestId
// to echo back, and it does so explicitly in its own response/error path.
// A generic request-correlation id for every error everywhere is future
// scope (would need request-id middleware), not part of this cut.
import { HttpException } from '@nestjs/common';

export interface CodedErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class CodedException extends HttpException {
  constructor(status: number, code: string, message: string, details?: unknown) {
    const body: CodedErrorBody =
      details === undefined ? { code, message } : { code, message, details };
    super(body, status);
  }
}

/** 409 with a stable code - e.g. PROJECT_TEAM_HAS_LEADS, STALE_PREVIEW. */
export class CodedConflictException extends CodedException {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

/** 400 with a stable code - e.g. TARGET_ROLE_INELIGIBLE, SELF_REPLACEMENT. */
export class CodedBadRequestException extends CodedException {
  constructor(code: string, message: string, details?: unknown) {
    super(400, code, message, details);
  }
}

/** 403 with a stable code - e.g. TARGET_NOT_TEAM_MEMBER (scope violation). */
export class CodedForbiddenException extends CodedException {
  constructor(code: string, message: string, details?: unknown) {
    super(403, code, message, details);
  }
}

/** 404 with a stable code - e.g. PROJECT_TEAM_NOT_LINKED. */
export class CodedNotFoundException extends CodedException {
  constructor(code: string, message: string, details?: unknown) {
    super(404, code, message, details);
  }
}
