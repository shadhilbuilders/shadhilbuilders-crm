/**
 * @shadhil/ui-tokens — compliance helpers
 *
 * Single source of truth for RERA + CMDA regulatory text.
 *
 * Per plan §17 input #1, ALL four surfaces must read from this module:
 *   1. web footer
 *   2. WhatsApp Cloud API message templates
 *   3. mobile push notification titles
 *   4. landing site (public shadhilbuilders.com)
 *
 * Env contract (set in `.env` / Vercel project settings / Capacitor config):
 *
 *   NEXT_PUBLIC_RERA_NUMBER=TN/29/2017
 *   NEXT_PUBLIC_RERA_VALID_FROM=2026-01-01
 *   NEXT_PUBLIC_RERA_VALID_UNTIL=2027-12-31
 *   NEXT_PUBLIC_CMDA_NUMBER=CMDA/2024/0381
 *
 * Anything prefixed NEXT_PUBLIC_* is inlined at build time by Next.js and
 * available in both server and client bundles. In non-Next runtimes (NestJS
 * backend, mobile) the same keys can be provided via dotenv / secrets.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReraInfo {
  /** RERA registration number, e.g. "TN/29/2017". */
  number: string;
  /** ISO date (YYYY-MM-DD) when registration becomes valid. */
  validFrom: string;
  /** ISO date (YYYY-MM-DD) when registration expires. */
  validUntil: string;
}

export interface CmdaInfo {
  /** CMDA approval number, e.g. "CMDA/2024/0381". */
  number: string;
}

/* -------------------------------------------------------------------------- */
/*  Env access (works in Node, Next.js client, and bundles that inline envs)  */
/* -------------------------------------------------------------------------- */

type EnvRecord = Record<string, string | undefined>;

interface ProcessLike {
  env?: EnvRecord;
}

function readEnv(key: string): string | undefined {
  // 1. process.env (Node / NestJS / Next server runtime).
  //    Guarded because pure browser bundles (no process shim) throw on access.
  try {
    const proc = (globalThis as { process?: ProcessLike }).process;
    const fromProcess = proc?.env?.[key];
    if (typeof fromProcess === 'string' && fromProcess.length > 0) {
      return fromProcess;
    }
  } catch {
    /* process is not defined in this runtime — fall through */
  }

  // 2. Inline replacement: Next.js with `env:` config / DefinePlugin / similar
  //    exposes env as top-level globals on globalThis (e.g. process.env replacement).
  try {
    const g = globalThis as unknown as EnvRecord;
    const inline = g[key];
    if (typeof inline === 'string' && inline.length > 0) {
      return inline;
    }
  } catch {
    /* not enumerable — fall through */
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be ISO date YYYY-MM-DD');

const ReraSchema = z
  .object({
    number: z.string().min(1, 'RERA number is required'),
    validFrom: IsoDate,
    validUntil: IsoDate,
  })
  .refine((v: { validFrom: string; validUntil: string }) => v.validFrom <= v.validUntil, {
    message: 'validFrom must be <= validUntil',
    path: ['validUntil'],
  });

const CmdaSchema = z.object({
  number: z.string().min(1, 'CMDA number is required'),
});

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read RERA registration metadata from env and validate.
 *
 * @throws {z.ZodError} when any required env var is missing or malformed.
 *   Callers (web footer, push templates) should fail fast at boot — a missing
 *   RERA number is a regulatory defect, not a soft warning.
 */
export function getReraInfo(): ReraInfo {
  const raw = {
    number: readEnv('NEXT_PUBLIC_RERA_NUMBER'),
    validFrom: readEnv('NEXT_PUBLIC_RERA_VALID_FROM'),
    validUntil: readEnv('NEXT_PUBLIC_RERA_VALID_UNTIL'),
  };
  return ReraSchema.parse(raw);
}

/**
 * Read CMDA approval metadata from env and validate.
 *
 * @throws {z.ZodError} when NEXT_PUBLIC_CMDA_NUMBER is missing.
 */
export function getCmdaInfo(): CmdaInfo {
  const raw = { number: readEnv('NEXT_PUBLIC_CMDA_NUMBER') };
  return CmdaSchema.parse(raw);
}

/**
 * Render the canonical RERA footer string used across every surface.
 *
 * Example output: `RERA TN/29/2017 | Valid 2026-01-01 to 2027-12-31`
 *
 * @throws {z.ZodError} when env is incomplete — propagate to caller so a
 *   missing RERA number surfaces during deploy/CI, not silently in user copy.
 */
export function formatReraFooter(): string {
  const info = getReraInfo();
  return `RERA ${info.number} | Valid ${info.validFrom} to ${info.validUntil}`;
}

/**
 * Convenience: render both registrations as a single compliance footer line.
 * Useful for narrow spaces (mobile push titles, WhatsApp template previews).
 */
export function formatComplianceFooter(): string {
  const rera = getReraInfo();
  const cmda = getCmdaInfo();
  return `RERA ${rera.number} | CMDA ${cmda.number}`;
}