# Local dev proxy — Traefik v3 + mkcert

T-PERF-2 #5 (2026-09-04). Why this exists, what it gives you, and how
to use it.

## The why

The 6-connection-per-origin limit on HTTP/1.1 cleartext (marked "Won't
fix" in Chrome + Firefox per MDN) bites hard during dev with multiple
browser tabs and 3 SSE channels each. The fix is HTTP/2 multiplexing,
which requires TLS because browsers refuse HTTP/2 cleartext.

`mkcert` is the standard dev-TLS tool: it gives you locally-trusted
certs in 2 minutes without the Let's Encrypt DNS dance. Traefik is the
prod reverse proxy (Coolify is built around it), so picking Traefik for
dev too means the same label-based config syntax you'll use in prod.

## What you get

After setup, the following dev URLs work over HTTPS with valid certs:

| URL | Proxies to |
|---|---|
| `https://crm.local` | `apps/web:3000` (Next.js) |
| `https://api.crm.local` | `apps/backend:8080` (NestJS) |
| `https://sse.crm.local` | `apps/realtime-sse:8090` |

All three share one h2 connection per browser tab. The 6-conn limit
disappears. SSE works over h2 multiplexed to the browser.

## One-time setup

### 1. Install mkcert

```bash
# macOS
brew install mkcert

# Linux (Debian/Ubuntu — see https://github.com/FiloSottile/mkcert for others)
sudo apt install mkcert
```

### 2. Install the local CA (one-time, per machine)

```bash
mkcert -install
```

This adds a local CA to your system + browser trust stores. Certs you
generate will be trusted automatically.

### 3. Generate the certs for our three dev hostnames

```bash
cd ~/workspace/shadhil-projects/shadhilbuilders-crm
mkcert \
  -cert-file ./certs/crm.local.pem \
  -key-file ./certs/crm.local-key.pem \
  crm.local api.crm.local sse.crm.local
```

The files land in `./docker/certs/` (gitignored; see `.gitignore` in
this directory).

### 4. Add the dev hostnames to /etc/hosts

```bash
# Add these three lines to /etc/hosts (sudo required)
127.0.0.1 crm.local api.crm.local sse.crm.local
```

Or use `dnsmasq` / `systemd-resolved` to make `*.local` resolve to
127.0.0.1 without editing `/etc/hosts`. The Wikipedia list of
distros that do this by default is growing every year.

### 5. Set dev env vars

Add to `.env` (or use a `.env.local` overlay):

```bash
# apps/web reads this at build time
NEXT_PUBLIC_API_BASE_URL=https://api.crm.local

# apps/realtime-sse reads this at runtime
SSE_BACKEND_URL=http://localhost:8090   # unchanged from plain dev
```

### 6. Start the dev proxy

```bash
cd ~/workspace/shadhil-projects/shadhilbuilders-crm
docker compose -f docker/docker-compose.dev-proxy.yml up -d
```

Traefik runs in the foreground; the three app services come up via
the compose. Visit `https://crm.local` in your browser — TLS works,
no cert warnings, h2 multiplexed.

## What this does NOT do

- **It does NOT replace the existing Caddy dev container** in
  `docker/docker-compose.yml`. That Caddy serves the plain-HTTP
  dev URLs (no TLS). You can run both side-by-side if you want to
  switch between plain and h2 dev.
- **It does NOT start Postgres / Redis / PgBouncer.** Run those via
  `pnpm docker:up` or the existing `docker/docker-compose.yml` first.
- **It does NOT generate prod certs.** That's Let's Encrypt via
  Coolify's Traefik in production (see
  `~/.hermes/skills/devops/shadhil-crm-dev/references/prod-deployment.md`).

## Troubleshooting

**"Your connection is not private"** — you didn't run `mkcert -install`
yet, OR your browser doesn't trust the system store. On Firefox, go to
`about:preferences#privacy` → Certificates → View Certificates →
Authorities → Import → select the CA file from `mkcert -install` output.

**"Connection refused" on crm.local** — the apps didn't start. Check
`docker compose -f docker/docker-compose.dev-proxy.yml logs apps-web`.
Common cause: the pnpm install is still running (first boot is slow).
Give it 60s.

**Traefik dashboard** — not exposed by default (we set
`exposedbydefault=false`). If you want to see the Traefik dashboard
during dev, add these command flags:
```
- "--api.dashboard=true"
- "--api.insecure=true"
```
and port `:8080` (which the apps/web service also uses — change
to `:8089` or another free port).

## Cleanup

To stop the dev proxy and remove the certs:

```bash
docker compose -f docker/docker-compose.dev-proxy.yml down
mkcert -uninstall   # removes the local CA from system + browsers
rm -rf ./docker/certs
```

Leaving the CA installed is fine — it only issues certs for hostnames
you explicitly ask for. But uninstalling is a 10-second op if you want
to be tidy.
