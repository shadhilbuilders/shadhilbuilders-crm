/**
 * Standalone p95 load smoke for the T-DEMOSET BFF endpoints.
 *
 * NOT part of the regular vitest suite — run manually before the demo:
 *
 *   pnpm --filter @shadhil/backend load:smoke
 *
 * Acceptance gate: p95 < 500 ms on GET /api/bff/leads × 100 concurrent.
 * The 4 other new endpoints run as a bonus so we have a full perf snapshot.
 *
 * Design notes:
 *   - No new npm deps. Uses Node 22+ built-ins (fetch, crypto, util.parseArgs).
 *   - Signs in via better-auth against the WEB app (port 3000) and reuses
 *     the session cookie for the BFF call — the BFF route exchanges the
 *     cookie for a JWT and forwards to NestJS. This is what a real browser
 *     does, so the latency numbers include the cookie → JWT mint + proxy hop.
 *   - 3 warmup requests before the leads gate to absorb JIT and PG plan cache.
 *   - Per-request correlation ID (UUID) so a slow request can be matched
 *     against backend logs if needed.
 *   - Exit code: 0 if leads p95 < 500 ms, 1 otherwise. CI-friendly.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const DEMO_EMAIL = process.env.LOAD_SMOKE_EMAIL ?? 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = process.env.LOAD_SMOKE_PASSWORD ?? 'demo123';

const LEADS_P95_GATE_MS = 500;
const WARMUP_REQUESTS = 3;
const DEFAULT_CONCURRENCY = 100;

type Endpoint = {
  /** label for the summary table */
  name: string;
  /** path under /api/bff on the web app */
  path: string;
  /** how many concurrent requests to fire in the batch */
  concurrency: number;
  /** warmup before the batch (defaults to 0 — leads uses WARMUP_REQUESTS) */
  warmup?: number;
};

const ENDPOINTS: Endpoint[] = [
  { name: 'leads',          path: '/leads',                              concurrency: DEFAULT_CONCURRENCY, warmup: WARMUP_REQUESTS },
  { name: 'notifications',  path: '/notifications?unreadOnly=false',     concurrency: DEFAULT_CONCURRENCY },
  { name: 'bookings',       path: '/bookings',                           concurrency: DEFAULT_CONCURRENCY },
  { name: 'audit',          path: '/audit?limit=50',                     concurrency: 50 },
  { name: 'chat',           path: '/chat/cmtmqs2sr0000xwu8z1pdmsrs',     concurrency: 50 },
];

type Sample = {
  status: number;
  latencyMs: number;
  bytes: number;
  requestId: string;
};

async function signIn(): Promise<string> {
  const res = await fetch(`${WEB_ORIGIN}${SIGN_IN_PATH}`, {
    method: 'POST',
    // better-auth rejects cross-origin-looking POSTs without an Origin
    // header with 403 MISSING_OR_NULL_ORIGIN. Curl gets a pass via its
    // own request shape; Node fetch is treated as a server-side caller
    // and must declare the origin explicitly.
    headers: {
      'Content-Type': 'application/json',
      Origin: WEB_ORIGIN,
    },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `sign-in failed: ${res.status} ${res.statusText} ` +
        `(is the web app running at ${WEB_ORIGIN}?)`,
    );
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('sign-in succeeded but no session cookie was set');
  }
  // The Set-Cookie header may include multiple cookies joined by ', '. The
  // session cookie we need starts with "better-auth.session_token=".
  const match = setCookie.match(/better-auth\.session_token=[^;]+/);
  if (!match) {
    throw new Error(`could not parse session cookie from: ${setCookie}`);
  }
  return match[0];
}

async function ping(url: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `preflight ping failed: ${res.status} ${res.statusText} for ${url}`,
    );
  }
  await res.body?.cancel();
}

function pct(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)]!;
}

function summarise(samples: Sample[]): {
  count: number;
  okCount: number;
  errCount: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
} {
  const okSamples = samples.filter((s) => s.status >= 200 && s.status < 400);
  const lats = okSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const sum = lats.reduce((acc, v) => acc + v, 0);
  return {
    count: samples.length,
    okCount: okSamples.length,
    errCount: samples.length - okSamples.length,
    p50: pct(lats, 50),
    p95: pct(lats, 95),
    p99: pct(lats, 99),
    max: lats.length > 0 ? lats[lats.length - 1]! : 0,
    avg: lats.length > 0 ? sum / lats.length : 0,
  };
}

async function runEndpoint(
  ep: Endpoint,
  cookie: string,
): Promise<{ ep: Endpoint; stats: ReturnType<typeof summarise>; samples: Sample[]; wallMs: number }> {
  const headers = {
    Cookie: cookie,
    'X-Load-Smoke': '1',
  };
  const url = `${WEB_ORIGIN}/api/bff${ep.path}`;

  // warmup (best-effort — ignore failures here; the timed batch is what matters)
  const warmupN = ep.warmup ?? 0;
  for (let i = 0; i < warmupN; i++) {
    try {
      await ping(url, headers);
    } catch {
      /* swallow */
    }
  }

  const samples: Sample[] = new Array(ep.concurrency);
  const start = performance.now();
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < ep.concurrency; i++) {
    const requestId = randomUUID();
    tasks.push(
      (async () => {
        const t0 = performance.now();
        try {
          const res = await fetch(url, { headers });
          const buf = await res.arrayBuffer();
          samples[i] = {
            status: res.status,
            latencyMs: performance.now() - t0,
            bytes: buf.byteLength,
            requestId,
          };
        } catch (err) {
          samples[i] = {
            status: 0,
            latencyMs: performance.now() - t0,
            bytes: 0,
            requestId,
          };
        }
      })(),
    );
  }
  await Promise.all(tasks);
  const wallMs = performance.now() - start;
  return { ep, stats: summarise(samples), samples, wallMs };
}

type RowInput = string | number;

function fmtCell(input: RowInput, width: number, side: 'start' | 'end'): string {
  const s = typeof input === 'number' ? String(input) : input;
  return side === 'start' ? s.padStart(width) : s.padEnd(width);
}

function printRow(
  name: RowInput,
  n: RowInput,
  conc: RowInput,
  p50: RowInput,
  p95: RowInput,
  p99: RowInput,
  max: RowInput,
  wall: RowInput,
  ok: RowInput,
  err: RowInput,
): string {
  return [
    fmtCell(name, 14, 'end'),
    fmtCell(n, 5, 'start'),
    fmtCell(conc, 4, 'start'),
    fmtCell(typeof p50 === 'number' ? `${p50.toFixed(1)}ms` : p50, 8, 'start'),
    fmtCell(typeof p95 === 'number' ? `${p95.toFixed(1)}ms` : p95, 8, 'start'),
    fmtCell(typeof p99 === 'number' ? `${p99.toFixed(1)}ms` : p99, 8, 'start'),
    fmtCell(typeof max === 'number' ? `${max.toFixed(1)}ms` : max, 8, 'start'),
    fmtCell(typeof wall === 'number' ? `${(wall / 1000).toFixed(2)}s` : wall, 8, 'start'),
    fmtCell(`ok=${ok}`, 6, 'start'),
    fmtCell(`err=${err}`, 6, 'start'),
  ].join('  ');
}

function parseCli(): { failFast: boolean; only?: string } {
  const { values } = parseArgs({
    options: {
      'fail-fast': { type: 'boolean', default: false },
      'only': { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });
  return {
    failFast: Boolean(values['fail-fast']),
    only: typeof values.only === 'string' ? values.only : undefined,
  };
}

async function main(): Promise<number> {
  const cli = parseCli();
  console.log(`load-smoke: target=${WEB_ORIGIN} user=${DEMO_EMAIL}`);

  let cookie: string;
  try {
    cookie = await signIn();
  } catch (err) {
    console.error(`\nFATAL: ${(err as Error).message}\n`);
    return 1;
  }
  console.log(`load-smoke: signed in (cookie len=${cookie.length})`);

  // preflight — fail fast if the leads endpoint itself is unreachable
  try {
    await ping(`${WEB_ORIGIN}/api/bff${ENDPOINTS[0]!.path}`, { Cookie: cookie });
  } catch (err) {
    console.error(`\nFATAL: preflight on /api/bff${ENDPOINTS[0]!.path} failed: ${(err as Error).message}\n`);
    return 1;
  }

  const header = printRow('endpoint', 'n', 'conc', 'p50', 'p95', 'p99', 'max', 'wall', 'ok', 'err');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  let gateOk = true;
  const results: Array<{
    ep: Endpoint;
    stats: ReturnType<typeof summarise>;
    wallMs: number;
  }> = [];

  for (const ep of ENDPOINTS) {
    if (cli.only && !ep.name.startsWith(cli.only)) continue;
    const { stats, wallMs } = await runEndpoint(ep, cookie);
    results.push({ ep, stats, wallMs });
    console.log(
      printRow(
        ep.name,
        stats.count,
        ep.concurrency,
        stats.p50,
        stats.p95,
        stats.p99,
        stats.max,
        wallMs,
        stats.okCount,
        stats.errCount,
      ),
    );

    const isGate = ep.name === 'leads';
    if (isGate) {
      if (stats.errCount > 0) {
        gateOk = false;
        console.error(
          `\n[gate] /api/bff/leads FAIL — ${stats.errCount}/${stats.count} requests errored`,
        );
      } else if (stats.p95 >= LEADS_P95_GATE_MS) {
        gateOk = false;
        console.error(
          `\n[gate] /api/bff/leads FAIL — p95 ${stats.p95.toFixed(1)}ms >= ${LEADS_P95_GATE_MS}ms`,
        );
      } else {
        console.log(
          `\n[gate] /api/bff/leads PASS — p95 ${stats.p95.toFixed(1)}ms < ${LEADS_P95_GATE_MS}ms`,
        );
      }
    }
    if (cli.failFast && !gateOk) break;
  }

  console.log('');
  return gateOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('load-smoke crashed:', err);
    process.exit(2);
  },
);