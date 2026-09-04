// BFF fetch client (browser → /api/bff/* → NestJS).
//
// All client-side server-state goes through the BFF: the browser sends the
// better-auth session cookie; the /api/bff route handler mints the JWT and
// bridges to NestJS. Nothing in the browser ever handles a raw JWT.
//
// Role/session lookups use better-auth's useSession (react bindings).
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type Role =
  | 'OWNER'
  | 'ADMIN'
  | 'MANAGER'
  | 'SALES_EXEC'
  | 'TELECALLER';

export const STAFF_ROLES: readonly Role[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'SALES_EXEC',
  'TELECALLER',
];

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
};

const ROLE_VALUES: readonly string[] = STAFF_ROLES;

function normalizeRole(raw: unknown): Role {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return ROLE_VALUES.includes(value) ? (value as Role) : 'TELECALLER';
}

/**
 * Pull the current session user out of a better-auth session payload.
 * `role`/`teamId` ride as additional fields on the user object
 * (@shadhil/auth user.additionalFields) — default to TELECALLER if absent.
 */
export function sessionUserFromSession(session: unknown): SessionUser | null {
  if (session === null || typeof session !== 'object') return null;
  const top = session as Record<string, unknown>;
  const user = (top.user ?? null) as Record<string, unknown> | null;
  if (user === null) return null;
  const id = typeof user.id === 'string' ? user.id : null;
  if (id === null) return null;
  const nested = (user.teamId ?? top.teamId ?? null) as unknown;
  return {
    id,
    name: typeof user.name === 'string' ? user.name : '',
    email: typeof user.email === 'string' ? user.email : '',
    role: normalizeRole(user.role),
    teamId: typeof nested === 'string' ? nested : null,
  };
}

/**
 * Authenticated fetch through the BFF. Throws ApiError on non-2xx so
 * TanStack Query surfaces a typed error.
 *
 * T29 (PR3): accepts an optional `signal` (AbortSignal) and forwards
 * it to the underlying `fetch`. This makes TanStack Query's
 * internal `signal` (passed by `queryFn({ signal })`) actually
 * cancel the request when the query is unmounted, retried, or GC'd
 * after a 30s timeout. Without this, the network request would run
 * to completion even after the React tree dropped the consumer.
 */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, signal, headers, ...rest } = init;

  const response = await fetch(`/api/bff${path}`, {
    ...rest,
    // Forward AbortSignal from the caller (TanStack Query passes one
    // via queryFn context). If the signal aborts, fetch throws
    // AbortError, which TanStack surfaces as a normal error.
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    // Let the proxy middleware bounce to /login on next navigation.
    window.location.href = `/login?next=${encodeURIComponent(
      window.location.pathname,
    )}`;
    throw new ApiError('Not authenticated', 401);
  }
  if (response.status === 403) {
    // T-S hardening (Week 5, 2026-09-04): the JwtAuthGuard returns
    // 403 + PASSWORD_CHANGE_REQUIRED when the session is valid but
    // the user's mustChangePassword flag is still true. Bounce to
    // /change-password so the seed users (owner/admin/manager/
    // telecaller/sales_exec) can rotate their placeholder password
    // on first sign-in. The demo user is exempted in the migration
    // so this redirect never fires for demo@shadhilbuilders.in.
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* not JSON — fall through to the generic 403 handler below */
    }
    if (
      body !== null &&
      typeof body === 'object' &&
      'code' in body &&
      (body as { code?: unknown }).code === 'PASSWORD_CHANGE_REQUIRED'
    ) {
      window.location.href = '/change-password';
      throw new ApiError('Password change required', 403);
    }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ApiError(
      detail.length > 0
        ? `API ${response.status}: ${detail.slice(0, 300)}`
        : `API ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Append optional list filters to a query string (skips null/undefined/''). */
export function qs(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}