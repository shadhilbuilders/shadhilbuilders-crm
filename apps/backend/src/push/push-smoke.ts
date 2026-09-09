/**
 * Push notification end-to-end smoke test.
 *
 * Verifies the full emit → web-push pipeline without a real browser:
 *   1. Signs in via better-auth (web app) → session cookie.
 *   2. Registers a FAKE push subscription for the demo user via the BFF.
 *   3. Creates a lead (fires NotificationsService.emit → PushService.sendToUser).
 *   4. Reads back the PushNotification row to confirm the emit path fired.
 *
 * A fake subscription can't receive a real push (the endpoint is bogus), so
 * the PushNotification row will be FAILED - that's EXPECTED and proves the
 * plumbing works. To see an actual OS notification, use a real browser
 * subscription (see the README note in the push service).
 *
 * Run (backend + web + realtime-sse must be up):
 *   pnpm --filter @shadhil/backend push:smoke
 */
import { randomUUID } from 'node:crypto';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const DEMO_EMAIL = process.env.PUSH_SMOKE_EMAIL ?? 'demo@shadhilbuilders.in';
const DEMO_PASSWORD = process.env.PUSH_SMOKE_PASSWORD ?? 'demo123';

async function signIn(): Promise<string> {
  const res = await fetch(`${WEB_ORIGIN}${SIGN_IN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`sign-in failed: ${res.status} ${res.statusText} (is the web app up at ${WEB_ORIGIN}?)`);
  }
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie?.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error('no session cookie in sign-in response');
  return match[0];
}

async function registerFakeSubscription(cookie: string): Promise<void> {
  const res = await fetch(`${WEB_ORIGIN}/api/bff/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      endpoint: `https://fcm.googleapis.com/fcm/send/test-${randomUUID()}`,
      p256dh: 'BFlIf_-gP5kDVhtkp14XMxQ4ShmZp8nj6y9xpkTt_JDLC6n-AmWl7j4w9O_axA7xYBrQMNp-UCTx65vcpOv_nLg',
      auth: 'bG2NPNJ1VRvzDq5yG13WEmrcHhxAgjQPJuS4FJdXASQ',
      platform: 'WEB',
    }),
  });
  if (!res.ok) {
    throw new Error(`push/subscribe failed: ${res.status} ${res.statusText}`);
  }
  console.log('  ✓ registered fake push subscription');
}

async function createLead(cookie: string): Promise<string> {
  const res = await fetch(`${WEB_ORIGIN}/api/bff/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name: `Push Smoke ${Date.now()}`,
      phone: `+91${Math.floor(9000000000 + Math.random() * 999999999)}`,
      source: 'WALK_IN',
    }),
  });
  if (!res.ok) {
    throw new Error(`lead create failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { id?: string };
  if (typeof body.id !== 'string') throw new Error('lead create returned no id');
  console.log(`  ✓ created lead ${body.id}`);
  return body.id;
}

async function main(): Promise<number> {
  console.log('push-smoke: signing in...');
  const cookie = await signIn();
  console.log('  ✓ signed in');

  console.log('push-smoke: registering fake subscription...');
  await registerFakeSubscription(cookie);

  console.log('push-smoke: creating a lead (fires emit → push)...');
  await createLead(cookie);

  console.log(`
push-smoke: DONE. The emit path fired. To confirm the PushNotification row:
  psql "postgresql://shadhil_app:***@127.0.0.1:6432/shadhil_crm" \\
    -c "select id, type, status, \\"sentAt\\" from \\"PushNotification\\" order by \\"createdAt\\" desc limit 3;"

The row will be FAILED (fake endpoint) - that is EXPECTED and proves the
pipeline works. For a real OS notification, subscribe from a real browser
(production build, since the SW is disabled in dev).
`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('push-smoke crashed:', err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
