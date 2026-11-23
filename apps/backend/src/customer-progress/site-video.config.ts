// Site update video configuration (2026-11-23).
//
// The storage caps are configuration, not constants and not columns: a limit is
// an operating decision, and nothing here guesses one. When the feature is ON
// the process refuses to start without both caps, and says what is wrong in one
// message, the same posture as assertBootEnv. When it is OFF nothing is
// required and every video route answers 404.
//
// The upload-grant rate limits DO have defaults, because a sensible rate is not
// a business decision: 20 grants per user and 100 per project in 10 minutes is
// far above what an engineer filming a villa produces and far below abuse.
export const SITE_VIDEO_ENV = {
  enabled: 'SITE_VIDEO_CAPTURE',
  orgCap: 'SITE_VIDEO_ORG_CAP_BYTES',
  projectCap: 'SITE_VIDEO_PROJECT_CAP_BYTES',
  userLimit: 'SITE_VIDEO_AUTH_USER_LIMIT',
  projectLimit: 'SITE_VIDEO_AUTH_PROJECT_LIMIT',
  windowSeconds: 'SITE_VIDEO_AUTH_WINDOW_SECONDS',
} as const;

export interface SiteVideoConfig {
  enabled: boolean;
  /** Bytes of video one organisation may hold. 0 when disabled. */
  orgCapBytes: number;
  /** Bytes of video one project may hold. 0 when disabled. */
  projectCapBytes: number;
  /** Upload grants one user may request per window. */
  authPerUserLimit: number;
  /** Upload grants one project may issue per window, across all users. */
  authPerProjectLimit: number;
  authWindowSeconds: number;
}

export const SITE_VIDEO_CONFIG = 'SITE_VIDEO_CONFIG';

const DEFAULT_USER_LIMIT = 20;
const DEFAULT_PROJECT_LIMIT = 100;
const DEFAULT_WINDOW_SECONDS = 600;

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Read and validate the configuration. Throws one error listing every problem
 * when the feature is on, so a misconfigured container exits with the full
 * list instead of discovering gaps one request at a time.
 */
export function readSiteVideoConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SiteVideoConfig {
  const enabled = env[SITE_VIDEO_ENV.enabled]?.trim() === 'true';
  const disabled: SiteVideoConfig = {
    enabled: false,
    orgCapBytes: 0,
    projectCapBytes: 0,
    authPerUserLimit: DEFAULT_USER_LIMIT,
    authPerProjectLimit: DEFAULT_PROJECT_LIMIT,
    authWindowSeconds: DEFAULT_WINDOW_SECONDS,
  };
  if (!enabled) return disabled;

  const problems: string[] = [];
  const orgCap = parsePositiveInt(env[SITE_VIDEO_ENV.orgCap]);
  const projectCap = parsePositiveInt(env[SITE_VIDEO_ENV.projectCap]);
  if (orgCap === null) {
    problems.push(`${SITE_VIDEO_ENV.orgCap} must be a positive integer number of bytes`);
  }
  if (projectCap === null) {
    problems.push(`${SITE_VIDEO_ENV.projectCap} must be a positive integer number of bytes`);
  }
  if (orgCap !== null && projectCap !== null && projectCap > orgCap) {
    problems.push(
      `${SITE_VIDEO_ENV.projectCap} (${projectCap}) cannot exceed ${SITE_VIDEO_ENV.orgCap} (${orgCap}): a project cannot be allowed more than its organisation`,
    );
  }

  const optional = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = parsePositiveInt(raw);
    if (n === null) problems.push(`${name} must be a positive integer when set`);
    return n ?? fallback;
  };
  const authPerUserLimit = optional(SITE_VIDEO_ENV.userLimit, DEFAULT_USER_LIMIT);
  const authPerProjectLimit = optional(SITE_VIDEO_ENV.projectLimit, DEFAULT_PROJECT_LIMIT);
  const authWindowSeconds = optional(SITE_VIDEO_ENV.windowSeconds, DEFAULT_WINDOW_SECONDS);

  if (problems.length > 0) {
    throw new Error(
      `${SITE_VIDEO_ENV.enabled}=true but the site update video config is invalid:\n  - ${problems.join('\n  - ')}\n` +
        `Set these, or unset ${SITE_VIDEO_ENV.enabled} to switch video updates off.`,
    );
  }
  return {
    enabled: true,
    orgCapBytes: orgCap as number,
    projectCapBytes: projectCap as number,
    authPerUserLimit,
    authPerProjectLimit,
    authWindowSeconds,
  };
}
