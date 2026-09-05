/**
 * Standalone p95 load smoke for the T-DEMOSET BFF endpoints.
 *
 * NOT part of the regular vitest suite - run manually before the demo:
 *
 *   pnpm --filter @shadhil/backend load:smoke
 *
 * Acceptance gate: median p95 < 500 ms on GET /api/bff/leads × 100
 * concurrent, measured across 3 runs after a 10-sequential +
 * 10-concurrent warmup. The 4 other new endpoints run as a bonus so
 * we have a full perf snapshot.
 *
 * Design notes:
 *   - No new npm deps. Uses Node 22+ built-ins (fetch, crypto, util.parseArgs).
 *   - Signs in via better-auth against the WEB app (port 3000) and reuses
 *     the session cookie for the BFF call - the BFF route exchanges the
 *     cookie for a JWT and forwards to NestJS. This is what a real browser
 *     does, so the latency numbers include the cookie → JWT mint + proxy hop.
 *   - The leads gate runs 3 times and reports the median p95. The first
 *     batch after a cold process can be 5-10x slower than steady state
 *     (JIT + Postgres plan cache); the warmup() step before the gate
 *     absorbs that. We still take the median across the 3 gate runs
 *     so a single GC pause or background task can't fail the gate.
 *   - Per-request correlation ID (UUID) so a slow request can be matched
 *     against backend logs if needed.
 *   - Exit code: 0 if leads median p95 < 500 ms, 1 otherwise. CI-friendly.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const DEMO_EMAIL = process.env.LOAD_SMOKE_EMAIL ?? 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = process.env.LOAD_SMOKE_PASSWORD ?? 'demo123';

const LEADS_P95_GATE_MS = 500;
// Warmup needs to absorb BOTH the first-request JIT spike AND the
// Postgres plan-cache + Prisma connection pool warmup. The first 1-3
// requests after a cold process can take 1-4s; steady state is
// <300ms. 10 sequential + a 10-concurrent warmup batch is what reliably
// gets us into the steady-state window before the measurement batch
// fires. Without this the first measurement run can read 5-10x higher
// than the true steady-state p95.
const WARMUP_SEQUENTIAL = 10;
const WARMUP_BURST = 10;
const DEFAULT_CONCURRENCY = 100;
// Run the leads gate 3 times, take the median p95 - a single run can be
// skewed by a cold fork or a GC pause; 3 runs + median is the standard
// "ignore the outliers" idiom for ad-hoc load smoke.
const LEADS_GATE_RUNS = 3;

type Endpoint = {
  /** label for the summary table */
  name: string;
  /** path under /api/bff on the web app */
  path: string;
  /** how many concurrent requests to fire in the batch */
  concurrency: number;
  /** warmup before the batch (defaults to 0 - leads uses the global warmup) */
  warmup?: number;
};

const ENDPOINTS: Endpoint[] = [
  { name: 'leads',          path: '/leads',                              concurrency: DEFAULT_CONCURRENCY },
  { name: 'notifications',  path: '/notifications?unreadOnly=false',     concurrency: DEFAULT_CONCURRENCY },
  { name: 'bookings',       path: '/bookings',                           concurrency: DEFAULT_CONCURRENCY },
  { name: 'audit',          path: '/audit?limit=50',                     concurrency: 50 },
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

/**
 * Look up a real lead id from the leads list so the chat endpoint
 * has a valid cuid to query (a hardcoded fixture id is brittle and
 * would 404 on a fresh DB).
 */
async function resolveChatLeadId(cookie: string): Promise<string> {
  const res = await fetch(`${WEB_ORIGIN}/api/bff/leads?limit=1`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) {
    throw new Error(`could not resolve chat lead id: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { rows?: Array<{ id: string }> };
  const id = body.rows?.[0]?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('no leads returned to use as chat lead id');
  }
  return id;
}

/**
 * Global warmup: fires WARMUP_SEQUENTIAL single requests then a
 * WARMUP_BURST concurrent batch. Run once before the leads gate so
 * the measurement batch lands inside the warm window.
 */
async function warmup(cookie: string): Promise<void> {
  const url = `${WEB_ORIGIN}/api/bff/leads`;
  const headers = { Cookie: cookie };
  for (let i = 0; i < WARMUP_SEQUENTIAL; i++) {
    try {
      await ping(url, headers);
    } catch {
      /* swallow - warmup is best-effort */
    }
  }
  // concurrent warmup burst: load the connection pool + JIT
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < WARMUP_BURST; i++) {
    tasks.push(ping(url, headers).catch(() => undefined));
  }
  await Promise.all(tasks);
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

  // warmup (best-effort - ignore failures here; the timed batch is what matters)
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

  // preflight - fail fast if the leads endpoint itself is unreachable
  try {
    await ping(`${WEB_ORIGIN}/api/bff${ENDPOINTS[0]!.path}`, { Cookie: cookie });
  } catch (err) {
    console.error(`\nFATAL: preflight on /api/bff${ENDPOINTS[0]!.path} failed: ${(err as Error).message}\n`);
    return 1;
  }

  // Global warmup - see warmup() docstring. The first batch of requests
  // after a cold process can take 5-10x the steady-state latency due
  // to JIT compilation and Postgres plan cache cold-start. Running
  // this once before the leads gate puts every measurement batch
  // inside the warm window.
  const warmStart = performance.now();
  await warmup(cookie);
  console.log(`load-smoke: warmed up (${(performance.now() - warmStart).toFixed(0)}ms)`);

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

    // The leads gate is the prompt's "Done when" criterion. It runs
    // LEADS_GATE_RUNS times and we gate against the median p95 to
    // absorb the cold-JIT penalty and one-off GC pauses.
    if (ep.name === 'leads') {
      const gateP95s: number[] = [stats.p95];
      const gateErrors: number[] = [stats.errCount];
      for (let i = 1; i < LEADS_GATE_RUNS; i++) {
        const rep = await runEndpoint(ep, cookie);
        gateP95s.push(rep.stats.p95);
        gateErrors.push(rep.stats.errCount);
        results.push({ ep, stats: rep.stats, wallMs: rep.wallMs });
        console.log(
          printRow(
            `${ep.name} (run ${i + 1})`,
            rep.stats.count,
            ep.concurrency,
            rep.stats.p50,
            rep.stats.p95,
            rep.stats.p99,
            rep.stats.max,
            rep.wallMs,
            rep.stats.okCount,
            rep.stats.errCount,
          ),
        );
      }
      const totalErrs = gateErrors.reduce((a, b) => a + b, 0);
      const sortedP95 = [...gateP95s].sort((a, b) => a - b);
      const medianP95 = sortedP95[Math.floor(sortedP95.length / 2)]!;
      if (totalErrs > 0) {
        gateOk = false;
        console.error(
          `\n[gate] /api/bff/leads FAIL - ${totalErrs}/${LEADS_GATE_RUNS * ep.concurrency} requests errored across ${LEADS_GATE_RUNS} runs`,
        );
      } else if (medianP95 >= LEADS_P95_GATE_MS) {
        gateOk = false;
        console.error(
          `\n[gate] /api/bff/leads FAIL - median p95 ${medianP95.toFixed(1)}ms >= ${LEADS_P95_GATE_MS}ms (runs: ${gateP95s.map((p) => p.toFixed(0)).join(', ')}ms)`,
        );
      } else {
        console.log(
          `\n[gate] /api/bff/leads PASS - median p95 ${medianP95.toFixed(1)}ms < ${LEADS_P95_GATE_MS}ms (runs: ${gateP95s.map((p) => p.toFixed(0)).join(', ')}ms)`,
        );
      }
    }
    if (cli.failFast && !gateOk) break;
  }

  // Bonus: chat endpoint with a runtime-resolved lead id (the
  // RLS-scoped list endpoint picks the first lead visible to the
  // demo user). Runs at the end so its lead-id lookup doesn't
  // contribute to the leads-gate warmup.
  if (!cli.only || 'chat'.startsWith(cli.only)) {
    try {
      const chatLeadId = await resolveChatLeadId(cookie);
      const chatEp: Endpoint = {
        name: 'chat',
        path: `/chat/${chatLeadId}`,
        concurrency: 50,
      };
      const { stats, wallMs } = await runEndpoint(chatEp, cookie);
      results.push({ ep: chatEp, stats, wallMs });
      console.log(
        printRow(
          chatEp.name,
          stats.count,
          chatEp.concurrency,
          stats.p50,
          stats.p95,
          stats.p99,
          stats.max,
          wallMs,
          stats.okCount,
          stats.errCount,
        ),
      );
    } catch (err) {
      console.error(`\n[chat] skipped - ${(err as Error).message}\n`);
    }
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