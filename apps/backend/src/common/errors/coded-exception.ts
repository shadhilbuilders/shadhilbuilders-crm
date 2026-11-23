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
  /**
   * Whether repeating the SAME request can succeed (2026-11-23, site update
   * video). Optional so every existing error keeps its exact wire shape; a
   * client that wants to decide its retry button from a typed field reads this
   * instead of matching on a code string.
   */
  retryable?: boolean;
}

export class CodedException extends HttpException {
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    retryable?: boolean,
  ) {
    const body: CodedErrorBody = {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(retryable === undefined ? {} : { retryable }),
    };
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

/**
 * 410 Gone with a stable code (2026-11-20, staff invites).
 *
 * A staff-invite link that has expired, been revoked, or already been used is
 * not "missing" - the caller holds a real credential for a resource that
 * USED TO exist and is now permanently unavailable. 404 would tell the
 * invitee their link was never valid (sending them back to the admin for a
 * typo they did not make), and 403 would imply they lack permission rather
 * than that the window closed. 410 is the honest answer, and the accept page
 * maps it to a specific card per code.
 */
export class CodedGoneException extends CodedException {
  constructor(code: string, message: string, details?: unknown) {
    super(410, code, message, details);
  }
}
