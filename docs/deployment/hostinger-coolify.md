# Deploying Shadhil CRM to Hostinger VPS + Coolify

Last verified: 2026-10-01 (rewritten against plan §5.0/§10 + Decision Audit #33-37).
Author: Hermes (PaalStack OS).

## Provisioned VPS (actual)

| Spec | Value |
|---|---|
| Host | Hostinger KVM2 |
| OS | **Ubuntu 26.04 LTS** |
| Memory | 8 GB |
| vCPU | 2 |
| Disk | 100 GB |
| Bandwidth | 8 TB/mo |

Two notes that matter:

- **Ubuntu 26.04 is accepted by Coolify's installer.** The docs list only
  20.04/22.04/24.04, and several blog posts claim the script refuses anything
  newer. It does not: the script gates on the distro *id* (`ubuntu`) and uses
  `VERSION_ID` only for its banner. Verified by reading
  `https://cdn.coollabs.io/coolify/install.sh` (2026-10-01). If a future release
  starts refusing 26.04, fall back to the manual install path.
- **2 vCPU makes images build more slowly here than on CI.** Coolify builds on
  the VPS, so budget 8-15 min for the first `shadhil-web` build rather than the
  4-8 min a 4-vCPU box would take. Subsequent builds reuse layers.

> **What changed in this revision.** The previous version described a two-service
> stack (web + api) on Supabase Postgres behind a "Caddy" proxy. None of that
> matched the repo: the plan of record locks **three** services behind **Traefik**
> with self-hosted Postgres + PgBouncer, and two of the three Dockerfiles did not
> build at all. Discard any cached copy.

## Why this setup

- The app is **Next.js 16 + NestJS 12 + Postgres 16 + Redis 7**, plus a
  **standalone SSE service** (`apps/realtime-sse`) for live chat and
  notifications. Three long-running Node processes and a webhook that must not
  cold-start.
- One VPS hosting all of them is cheaper than three managed services and removes
  cold starts.
- Coolify gives Vercel-like UX (git push, auto-build, preview URLs) on our own
  VPS, with no per-seat or per-invocation metering.

## Cost

| Component | Plan | Cost |
|---|---|---|
| Hostinger VPS | **KVM2 - 8 GB / 2 vCPU / 100 GB** (purchased; 2 vCPU builds slower than plan §10's 4 vCPU) | ~₹2,500/mo |
| Coolify | Self-hosted | ₹0 |
| Postgres + PgBouncer + Redis | Containers on the same VPS | ₹0 |
| Cloudflare R2 / Backblaze B2 | Chat media + encrypted Postgres dumps | ~₹500/mo |
| Domain | One you already own | (existing) |
| **Total ongoing, excluding telephony** | | **~₹3,000/mo** |

FreJun telephony is the real cost centre (~₹15,300/mo at 10 users, plan §10) and
is billed separately.

## Architecture

```
                    ┌──────────────────────────────────────────────────┐
                    │ Hostinger VPS (Ubuntu 26.04, KVM2 8GB / 2 vCPU)   │
                    │                                                  │
   Internet ──────► │  Traefik (Coolify's default proxy, :80/:443)      │
                    │     │                                            │
                    │     ├──► crm.shadhilbuilders.in     → web  :3000 │
                    │     ├──► api.crm.shadhilbuilders.in → api  :8080 │
                    │     ├──► sse.crm.shadhilbuilders.in → sse  :8090 │
                    │     └──► coolify.shadhilbuilders.in → Coolify UI │
                    │                                                  │
                    │  Coolify (Docker)                                │
                    │  ├─ container: shadhil-web          (Next.js)    │
                    │  ├─ container: shadhil-api          (NestJS)     │
                    │  ├─ container: shadhil-realtime-sse (SSE)        │
                    │  ├─ container: shadhil-redis        (Redis 7)    │
                    │  ├─ container: shadhil-pgbouncer    (session)    │
                    │  └─ container: shadhil-postgres     (Postgres 16)│
                    └──────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────────┐
                    │ Cloudflare R2        │  media + DB dumps
                    └──────────────────────┘
```

Service-to-service edges (all inside the Docker network, never over the internet):

```
browser ──► web :3000 ──┬─► /api/backend/* ──► api :8080   (next.config.ts rewrite)
                        └─► /api/sse/*     ──► sse :8090   (SSE_BACKEND_URL)
browser ──► api :8080                                      (XHR + Swagger UI)
api :8080 ──► pgbouncer :6432 ──► postgres :5432
api :8080 ──► redis :6379
sse :8090 ──► pgbouncer :6432 ──► postgres :5432
```

**Three subdomains, not one** (Decision #33). The SSE service gets its own origin
so the browser never sends the `better-auth` session cookie to it and so a
misbehaving stream cannot exhaust the API's HTTP/2 connection pool. The session
cookie is explicitly scoped to `crm.shadhilbuilders.in` (Decision #37).

## Prerequisites

1. **Hostinger KVM2 VPS** (8 GB / 2 vCPU, 100 GB disk), Ubuntu 26.04 LTS -
   already purchased. You have:
   - VPS public IP (e.g. `72.62.xx.xx`)
   - Root password (or set up an SSH key)
2. **One domain** you can point subdomains at:
   - `crm.<yourdomain>` - public, the Next.js app users hit
   - `api.crm.<yourdomain>` - public, called by the browser + WhatsApp webhook
   - `sse.crm.<yourdomain>` - public, long-lived EventSource connections
   - `coolify.<yourdomain>` - semi-private, the Coolify dashboard
3. **GitHub access** so Coolify can clone `shadhilbuilders/shadhilbuilders-crm`.
   Preferred: a GitHub App. Alternatives: a PAT with `repo` + `read:org`, or a
   deploy key that Coolify generates for you to add to the repo.
4. **The secrets** listed in Phase 3. Generate with `openssl rand -base64 32`.
   `JWT_SECRET` and `BETTER_AUTH_SECRET` must each be >= 32 chars or the API
   refuses to boot (`apps/backend/src/boot-env.ts`).

Send Hermes the **public IP** + **root password** through the secure channel you
set up. Do not paste them in chat.

## Phase 1 - Provision the VPS

Already purchased (KVM2, Ubuntu 26.04). Confirm in hPanel:

1. Set the hostname in hPanel to `shadhil-prod-01`.
2. Note the public IPv4 - needed for DNS and SSH.
3. Confirm the OS is Ubuntu 26.04 LTS x86_64.
4. Set a long random root password (used once, then password auth is disabled).

## Phase 2 - Harden the VPS and install Coolify

Hermes will SSH in and run this one-time (~20 min):

1. **Hardening baseline** - non-negotiable before Coolify:
   - `apt update && apt upgrade -y`
   - Create non-root user `deploy` with sudo, copy the SSH key
   - `ufw allow 22,80,443/tcp`; `ufw default deny incoming`
   - Install `fail2ban` with the default SSH jail
   - `sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`
   - Verify SSH key login as `deploy`, then `sudo reboot`
2. **Install Docker**:
   ```bash
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker deploy
   ```
3. **Install Coolify v4**:
   ```bash
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
   ```
   Coolify's dashboard listens on `:8000`; it installs and manages a **Traefik**
   proxy that owns `:80`/`:443`.
4. **Create the Coolify admin** at `http://<vps-ip>:8000`, save it in your
   password manager, then close port 8000 in ufw (the dashboard is reached at
   `coolify.<yourdomain>` from here on).
5. **Confirm the proxy is Traefik.** It is Coolify's default and the best-tested
   path (Decision Audit #36). Do not swap in Nginx or Caddy:
   ```bash
   ssh deploy@<vps-ip> 'docker ps --format "{{.Names}}" | grep -i proxy'
   # expect: coolify-proxy
   ```

## Phase 3 - Provision the stack in Coolify

Add the GitHub source once (`shadhilbuilders/shadhilbuilders-crm`, branch `main`),
then create the resources below.

All three app builds use **build context = repo root (`.`)**, not the app
subdirectory. The apps import workspace packages through pnpm symlinks and
`next.config.ts` transpiles their source, so the workspace root must be in the
build context.

> **Images are built in CI.** `.github/workflows/ci.yml` -> job `docker-images`
> builds all three Dockerfiles from a clean checkout on every PR. A broken
> Dockerfile fails CI before it reaches the VPS.

### 3a. Service - `shadhil-postgres`

- **Type**: Service -> PostgreSQL 16
- **No domain** (internal only)
- `POSTGRES_USER=shadhil`, `POSTGRES_DB=shadhil_crm`, and a **real**
  `POSTGRES_PASSWORD` (not the dev value `shadhil`)
- The non-owner app role `shadhil_app` is created on first volume init by
  `docker/postgres-init/00-init.sql`. Confirm it exists:
  ```bash
  docker exec -it shadhil-postgres psql -U shadhil -d shadhil_crm \
    -c "SELECT rolname FROM pg_roles WHERE rolname IN ('shadhil','shadhil_app');"
  ```
- `max_connections=300`, `shared_buffers=256MB`, `work_mem=4MB` (supports ~150
  concurrent users at 2 SSE streams each)

### 3b. Service - `shadhil-pgbouncer`

**Required, not optional.** The app connects as the non-owner role `shadhil_app`
through PgBouncer in **session** pooling mode. Under transaction pooling the RLS
session variables do not survive a pooled transaction, which is why
`POOL_MODE=session` is enforced at boot and the API refuses to start otherwise.

- **Type**: Service -> `edoburu/pgbouncer:v1.25.2-p0`
- **No domain** (internal only; reached as `shadhil-pgbouncer:6432`)
- Mount `docker/pgbouncer.ini` and `docker/userlist.txt`. Regenerate
  `userlist.txt` with your real passwords - the committed one is dev-only and its
  own header says so.

### 3c. Service - `shadhil-redis`

- **Type**: Service -> Redis 7-alpine
- **No domain** (internal only; `redis://shadhil-redis:6379`)
- Used for BullMQ queues, cron locks, rate limiting, and SSE pub/sub.

### 3d. Application - `shadhil-api` (NestJS)

- **Build pack**: Dockerfile
- **Dockerfile location**: `apps/backend/Dockerfile`
- **Build context**: `.`
- **Port**: `8080`
- **Domain**: `api.crm.shadhilbuilders.in`
- **Health check path**: `/api/health`

The global route prefix is `api`, so every path below is a real route.

```
NODE_ENV=production
API_PORT=8080
POOL_MODE=session
DATABASE_URL=postgresql://shadhil_app:<pw>@shadhil-pgbouncer:6432/shadhil_crm?schema=public
DIRECT_DATABASE_URL=postgresql://shadhil:<owner-pw>@shadhil-postgres:5432/shadhil_crm?schema=public
REDIS_URL=redis://shadhil-redis:6379
JWT_SECRET=<openssl rand -base64 32>
JWT_ISSUER=shadhil-crm
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://api.crm.shadhilbuilders.in
CORS_ORIGINS=https://crm.shadhilbuilders.in
PUBLIC_API_KEY=<openssl rand -hex 32>
PUBLIC_ORG_ID=<your org ULID (26 chars) or UUID (36 chars)>
# Optional but recommended
LEADS_FALLBACK_OWNER_ID=<a real staff user id>
# WhatsApp Cloud API
WA_PHONE_NUMBER_ID=<from Meta>
WA_ACCESS_TOKEN=<from Meta>
WA_WEBHOOK_VERIFY_TOKEN=<you choose this>
WA_APP_SECRET=<Meta app secret - signs inbound webhooks>
# Telephony
FREJUN_API_KEY=<from FreJun>
FREJUN_WEBHOOK_SECRET=<from FreJun>
# Chat media (see "Media storage" below)
MEDIA_STORAGE=imagekit
IMAGEKIT_PUBLIC_KEY=<from ImageKit>
IMAGEKIT_PRIVATE_KEY=<from ImageKit>
IMAGEKIT_URL_ENDPOINT=<from ImageKit>
# Optional
TELEGRAM_BOT_TOKEN=<optional - alerts no-op when absent>
TELEGRAM_CHANNEL_ID=<optional>
```

Two things that bite:

- `CORS_ORIGINS` must be set. Without it the API falls back to localhost, the
  browser's calls are rejected, and the API still looks perfectly healthy.
- `PUBLIC_API_KEY` and `PUBLIC_ORG_ID` are **required at boot** (`assertBootEnv`).
  Omit either and the container exits with a list naming every missing var.

There is no `WA_BUSINESS_ACCOUNT_ID` - the backend does not read it.

### 3e. Application - `shadhil-web` (Next.js)

- **Build pack**: Dockerfile
- **Dockerfile location**: `apps/web/Dockerfile`
- **Build context**: `.`
- **Port**: `3000`
- **Domain**: `crm.shadhilbuilders.in`
- **Health check path**: `/api/health`

**Build arguments** (baked into the bundle at build time - a runtime env var is
too late):

```
NEXT_PUBLIC_APP_URL=https://crm.shadhilbuilders.in
NEXT_PUBLIC_APP_NAME=Shadhil Builders
NEXT_PUBLIC_API_BASE_URL=https://api.crm.shadhilbuilders.in
BACKEND_API_URL=http://shadhil-api:8080
NEXT_PUBLIC_DEBUG_MODE=false
```

`BACKEND_API_URL` is server-side but still read at **build** time: `next.config.ts`
interpolates it into the rewrite table. Leave it out and the image bakes
`http://localhost:8080`, so every BFF call targets the web container itself and
502s while the container reports healthy.

**Runtime environment variables:**

```
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
BETTER_AUTH_SECRET=<same value as the API>
BETTER_AUTH_URL=https://crm.shadhilbuilders.in
JWT_SECRET=<same value as the API>
JWT_ISSUER=shadhil-crm
DIRECT_DATABASE_URL=<same owner URL as the API>   # web resolves tenant slugs
BACKEND_API_URL=http://shadhil-api:8080
SSE_BACKEND_URL=http://shadhil-realtime-sse:8090
NEXT_PUBLIC_API_BASE_URL=https://api.crm.shadhilbuilders.in
NEXT_PUBLIC_APP_URL=https://crm.shadhilbuilders.in
NEXT_PUBLIC_APP_NAME=Shadhil Builders
```

`SSE_BACKEND_URL` is read at **runtime** (verified in the built bundle), so point
it at whatever name Coolify assigns the SSE container. `BETTER_AUTH_*` and
`JWT_*` must match the API's values exactly or sessions will not validate.

### 3f. Application - `shadhil-realtime-sse`

- **Build pack**: Dockerfile
- **Dockerfile location**: `apps/realtime-sse/Dockerfile`
- **Build context**: `.`
- **Port**: `8090`
- **Domain**: `sse.crm.shadhilbuilders.in`
- **Health check path**: `/api/sse/healthz`

```
NODE_ENV=production
REALTIME_SSE_PORT=8090
CORS_ORIGINS=https://crm.shadhilbuilders.in
DATABASE_URL=<same pooled URL as the API>
POOL_MODE=session
```

Set **`ulimit -n 65536`** on this container. Plan §10 calls this out: Docker
defaults to 1024 file descriptors, and at 2 fds per connection the service hits
EMFILE at roughly 500 concurrent streams. In Coolify's advanced settings, or in
compose:

```yaml
ulimits:
  nofile:
    soft: 65536
    hard: 65536
```

### 3g. Networking

All services must share one Docker network so the names above resolve. Coolify
puts each resource on its own network by default, so attach the five app/service
containers to a shared network (`shadhil-net`) in each resource's network
settings, or reference them by the container name Coolify shows.

`docker/docker-compose.yml` already carries the full six-service stack with the
per-service Traefik labels (from `references/prod-deployment.md`). Where Coolify
manages the proxy it sets those labels itself and the compose ones are inert.
The hostnames there are `${CRM_HOST:-crm.shadhilbuilders.in}`-style, so the same
file works unchanged for production and for a local `CRM_HOST=crm.local` run.
Use it as the reference for what Coolify's settings should contain.

## Phase 4 - DNS

At your registrar, add A records pointing at the VPS IP:

| Host | Type | Value |
|---|---|---|
| `crm` | A | `<vps-ip>` |
| `api.crm` | A | `<vps-ip>` |
| `sse.crm` | A | `<vps-ip>` |
| `coolify` | A | `<vps-ip>` |

Propagation is minutes to 48h depending on TTL. Check with
`dig crm.shadhilbuilders.in +short`. Traefik answers the HTTP-01 challenge for
Let's Encrypt, so only ports 80 and 443 need to be open.

Certificates issue automatically once DNS resolves:

```bash
curl -vI https://crm.shadhilbuilders.in 2>&1 | grep -E 'issuer|subject'
# expect: issuer: Let's Encrypt ; subject: CN=crm.shadhilbuilders.in
```

## Phase 5 - Verify end to end

From your laptop. Every path below is a real route.

```bash
# 1. Web is up
curl -I https://crm.shadhilbuilders.in
# expect: HTTP/2 200

# 2. Web health
curl https://crm.shadhilbuilders.in/api/health
# expect: {"status":"ok",...}

# 3. API is up
curl https://api.crm.shadhilbuilders.in/api/health
# expect: {"status":"ok","uptimeSec":N,"timestamp":"..."}

# 4. API reached the database (401 = DB ok, 500 = DB broken)
curl -i https://api.crm.shadhilbuilders.in/api/users/me
# expect: HTTP/2 401

# 5. Swagger is served
curl -I https://api.crm.shadhilbuilders.in/api/docs
# expect: HTTP/2 200 (HTML)

# 6. The BFF actually reaches the API container
curl https://crm.shadhilbuilders.in/api/backend/health
# A 502 here means BACKEND_API_URL was not passed as a BUILD arg on the web image.

# 7. The SSE service is up
curl https://sse.crm.shadhilbuilders.in/api/sse/healthz

# 8. The BFF reaches the SSE container
curl -i https://crm.shadhilbuilders.in/api/sse/healthz
# A 502 here means SSE_BACKEND_URL is wrong or the SSE container is down.

# 9. WhatsApp webhook
# Meta Business Suite -> WhatsApp -> Configuration -> Webhook:
#   URL: https://api.crm.shadhilbuilders.in/api/webhook/whatsapp
#   Verify token: <WA_WEBHOOK_VERIFY_TOKEN>
# Send a test message from your test number, then watch the Delivery column in
# the chat UI: sent -> delivered -> read.
```

Steps 6 and 8 are the two that catch the silent build-time faults. Run them on
every deploy.

## Phase 6 - Auto-deploy on git push

For each app in Coolify: **Settings -> Webhooks -> copy the URL**, then add it in
GitHub under Settings -> Webhooks (content type `application/json`, "Just the push
event"). Every push to `main` now triggers a rebuild.

Preview deployments can be enabled per app (**Settings -> Previews**).

> **Check GitHub Actions billing first.** CI on this repo has previously failed
> with `The job was not started because recent account payments have failed` on
> every job. If a push is not deploying, confirm Actions is actually running
> before debugging Coolify.

## Ongoing operations

### Deploying a change

`git push origin main`. Coolify rebuilds and redeploys in 2-5 minutes.

### Schema changes

The container does **not** run migrations on boot. After the backend deploys:

```bash
docker exec -it shadhil-api sh -lc \
  'cd /app/packages/database && node_modules/.bin/prisma migrate deploy'
```

`migrate deploy` needs the owner-role `DIRECT_DATABASE_URL`, which the API
already has.

### Backups

- **Postgres**: daily `pg_dump` piped to encrypted Backblaze B2 or R2. Restore
  test weekly, and do one real restore before you go live.
- **Media**: enable versioning on the R2 media bucket if you need undo.
- **VPS**: Hostinger snapshots weekly, or `borgbackup` to R2.

### Logs

```bash
ssh deploy@<vps-ip>
docker logs -f --tail 200 shadhil-api
docker logs -f --tail 200 shadhil-web
docker logs -f --tail 200 shadhil-realtime-sse
```

Or Coolify UI -> resource -> Logs.

### Monitoring

- Uptime: `crm.<domain>/api/health` and `api.crm.<domain>/api/health` every 30s
- Alert on any `5xx` under `/api/sse/` - that means a live client's stream died
- SSE metrics live at `/api/sse/metrics` (connection count, tick latency)
- Telegram alerts are wired through the API's optional `TELEGRAM_*` vars

### Scaling

8 GB is comfortable for web + api + sse + Redis + PgBouncer + Postgres + Coolify
at the 150-user target. The 2 vCPUs are the tighter resource: they slow image
builds and cap SSE event-loop throughput. If either becomes a problem, Hostinger
can upgrade the core count in place. Past that:

1. Raise Prisma's `connection_limit` on `DATABASE_URL`
2. Add a second VPS so the builds and Postgres stop competing with the app
3. Above ~2000 concurrent SSE connections, move the poll to Postgres
   `LISTEN/NOTIFY` (plan T-PERF-3)

## Reliability: what must never go down, and how it recovers

> **Targets and budgets live in `docs/operations/SLO.md`** (99.9% web/api, 99.5%
> SSE, rolling 30-day window). This section is the deployment-side mechanics; the
> SLO doc is the numbers, the error budget, and the incident ladder.

Target: **the CRM stays up 24/7 and heals itself.** A user should never see a
dead page because a container died, a deploy went out, or the DB blipped.

### The five guarantees

| # | Guarantee | Mechanism |
|---|---|---|
| 1 | A dead container comes back | `restart: unless-stopped` on all six services |
| 2 | A container stuck in a bad state gets replaced | Coolify health checks + restart |
| 3 | A client's live stream reconnects on its own | EventSource retry with backoff + `Last-Event-ID` replay (`apps/web/src/lib/sse.ts`) |
| 4 | In-flight work is not lost on redeploy | graceful shutdown hooks (`app.enableShutdownHooks()`) |
| 5 | A silent failure gets noticed | uptime monitor on both apps + Telegram alerts |

### What is ALREADY handled in the code

- **SSE client recovery is real, not aspirational.** `apps/web/src/lib/sse.ts`
  reconnects with exponential backoff, sends `Last-Event-ID` so the server
  replays missed events, and distinguishes "tab was closed" from "stream died"
  (an `AbortError` is swallowed rather than retried). This is the hardest part of
  SSE reliability and it is already built and tested
  (`sse.test.ts`, `use-realtime-channel.ts`).
- **The SSE server drains on shutdown.** `apps/realtime-sse/src/server.ts`
  handles SIGTERM/SIGINT: `server.close()` waits for open streams, then
  `prisma.$disconnect()`, with a 5s hard-exit fallback so it can never hang a
  deploy.
- **The API refuses to boot misconfigured** (`assertBootEnv`) instead of running
  half-dead with a localhost Redis URL - the failure mode that makes a bad deploy
  look like a working one.
- **Cron work is idempotent under crash.** Reminder processing claims rows with
  `updateMany(SCHEDULED → PROCESSING)` and a Redis lease, so a double tick (or a
  restart mid-job) sees zero rows and exits cleanly.
- **Every service restarts on crash.** `restart: unless-stopped` is set on
  postgres, pgbouncer, redis, api, web and realtime-sse.

### What you MUST configure (not automatic)

These are the gaps between "containers restart" and "24/7". None of them work by
default:

1. **Health checks on the API and web containers.** Docker cannot restart what it
   cannot detect as unhealthy. Only Postgres and Redis declare health checks
   today. Set the health check path in Coolify per app:

   | App | Health check path |
   |---|---|
   | `shadhil-web` | `/api/health` |
   | `shadhil-api` | `/api/health` |
   | `shadhil-realtime-sse` | `/api/sse/healthz` |

   A health check that hits `/` on an app that renders a full page (or returns
   200 from a static route) proves nothing. Point it at a route that touches the
   real dependency where possible.

2. **Docker log rotation.** Nothing caps container logs right now, so a
   crash-looping container fills the 100 GB disk and then *every* service fails -
   the classic "the disk killed the database" outage. Set this on the VPS's
   Docker daemon so it applies to every container including Coolify's:

   ```json
   // /etc/docker/daemon.json
   { "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
   ```

   Then `sudo systemctl restart docker`.

3. **The uptime monitor and its alert.** Better Stack on the free tier, polling
   both apps every 30s, **with Telegram alerting wired up**. Monitoring without a
   working alert is decoration - the plan budgets this (plan §10) but it is not
   installed on the VPS yet.

4. **DB connection pool ceiling.** `DATABASE_URL` carries no `connection_limit`
   today, so Prisma uses its default pool of 10 and it is shared by every
   request. Under load that exhausts before Postgres does. Add
   `?connection_limit=20` (plan T-PERF-2) and watch it.

### Deliberately NOT in scope for v1

Say these out loud rather than implying they are covered:

- **No high availability, and it cannot be built on one VPS.** One box is one
  point of failure: if the VPS itself dies, the site is down until you restore a
  snapshot on a new one. Real HA means a second node with managed Postgres
  replication and a load balancer - a different cost bracket (multiples of the
  current ~₹3,000/mo), and out of scope for v1.
- **No multi-node app tier.** A single instance per service; no load balancer.
- **No automated failover or self-healing for the database.** Postgres runs in a
  single container with `restart: unless-stopped`. That recovers from a crashed
  process, not from a corrupted volume.
- **Restore is manual.** Backups are automated; the restore test is not. Until
  it is, your real recovery time is unmeasured.

**So the honest definition of "24/7" here:** a *process-level* self-healing
system, plus backups for the catastrophic case. It is not an availability
guarantee on the infrastructure. If the client needs a contractual uptime figure
(99.9% or similar), that requires the second node and managed Postgres, and it
should be costed before it is promised.

### Recovery procedures

**A service is crash-looping.**

```bash
ssh deploy@<vps-ip>
docker ps --filter 'name=shadhil' --format '{{.Names}}\t{{.Status}}'
docker logs --tail 100 shadhil-api        # the actual cause
docker restart shadhil-api                # first action; usually enough
```

If it keeps dying, check in this order: disk (`df -h`), memory (`free -m`, look
for an OOM kill in `dmesg`), then the app log itself.

**The database is unreachable.** The API and SSE both fail loudly rather than
serving bad data. Check `shadhil-postgres` first, then `shadhil-pgbouncer`.
PgBouncer in session mode holds a slot per client, so its restart is safe but
expect a brief reconnect storm.

**A bad deploy is live.** Coolify keeps previous deployments: roll back to the
last good one from the app's Deployments tab. Rolling back a migration is harder
than rolling back code - prefer additive, backwards-compatible migrations so the
old image still works against the new schema.

**The whole VPS is gone.** Restore the latest `pg_dump` into a fresh Postgres,
repoint DNS, redeploy. This is the drill to actually rehearse once before go-live
- an untested restore is not a backup.

## Media storage

Chat attachments currently go through **ImageKit** (`MEDIA_STORAGE=imagekit`).
`next.config.ts` derives the `next/image` allow-list from `MEDIA_CDN_URL` or
`IMAGEKIT_URL_ENDPOINT`, so switching providers is an env change rather than a
code change.

Do **not** point `MEDIA_CDN_URL` at `r2.cloudflarestorage.com`: that is R2's
authenticated S3 API endpoint and browsers cannot fetch from it. Use the bucket's
public host (`pub-<hash>.r2.dev`) or a custom domain.

## NOT in scope (deliberately deferred)

- **PR preview environments.** Coolify supports them; not configured here.
- **A separate staging environment.** Would need its own namespaces or VPS; today
  there is one environment.
- **Automated restore drills.** Backups are documented above but the weekly
  restore test is manual.
- **SSE load testing.** `/api/sse/metrics` exists; no k6 run against it yet.
- **A local Traefik dev proxy.** `docker/docker-compose.yml` now labels `web`,
  `api` and `realtime-sse`, and the hostnames are overridable
  (`CRM_HOST`/`API_HOST`/`SSE_HOST`), so a local Traefik run is possible. Not
  wired up yet. (`.github/workflows/vercel.yml` was deleted on 2026-10-01.)

## Build defects fixed on 2026-10-01

Recorded because these are the failure modes to watch if the Dockerfiles are
edited again. All were found by actually running `docker build`, which nothing in
CI did before:

| # | Defect | Fix |
|---|---|---|
| 1 | `apps/backend/Dockerfile` ran `tsc` before `prisma generate`. The generated Prisma client is gitignored, so the clean-context build failed with five `TS2307` errors. | Added `pnpm --filter @shadhil/database generate` before the database build. Verified: `tsc` exits 2 without it, 0 with it. |
| 2 | `apps/web/next.config.ts` had `output: 'standalone'` commented out while the Dockerfile copied `.next/standalone`. | Enabled it. CI now asserts the file exists so the failure names the cause. |
| 3 | Web install copied `package.json` + `pnpm-lock.yaml` but not `pnpm-workspace.yaml`, where the `overrides` block the lockfile records lives -> `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, blocking all three images. | Copy the workspace manifest too. |
| 4 | The web runner ran `node server.js`, but in a pnpm monorepo the standalone tree roots at the repo root, so the server is at `apps/web/server.js`. | Corrected the copy paths and `CMD`. |
| 5 | The web postinstall runs bash; `node:26-alpine` has no bash. | `pnpm install --ignore-scripts`. |
| 6 | `BACKEND_API_URL` had no build arg, so the image baked the localhost fallback. | Declared it as a build `ARG`. |
| 7 | Nothing in CI built any image, so every defect above was invisible. | Added the `docker-images` CI job. |
| 8 | `next build` prerenders `/api/docs` and imports the auth chain, so `@t3-oss/env-nextjs` and `assertAuthEnv()` both run at build time and killed the build with `Failed to collect page data for /api/docs` (`Invalid environment variables`). `assertAuthEnv()` has no skip switch. | The builder stage sets shape-valid placeholder server env (`BETTER_AUTH_URL`, `DIRECT_DATABASE_URL`, and 44-char placeholder secrets). They live in the builder `FROM` only, so they never reach the shipped image; real values come from Coolify at runtime. Never pass real secrets as build args. |

There was also no repo-root `.dockerignore`, so a root-context build shipped
`node_modules`, every `.next`, and the real `.env` into the builder. Fixed.

`apps/realtime-sse` had **no Dockerfile at all**, so the SSE service could never
be deployed. It has one now.

## Vercel history (why we left)

For posterity - the Vercel CLI deploys failed with two distinct errors and config
tweaks did not resolve them:

1. **`pnpm install` failed: "Headless installation requires a pnpm-lock.yaml
   file"** - `pnpm-lock.yaml` lives at the monorepo root, but the CLI run from
   `apps/web/` treated that directory as the project root. Partial fix: set
   `installCommand` to `cd ../.. && pnpm install --frozen-lockfile`.
2. **"No Next.js version detected"** - appeared after fixing (1). The Next
   builder's `require.resolve('next/package.json', { paths: [entryPath] })` fails
   inside Vercel's build container despite pnpm linking `next` locally.
   `vercel/vercel` source: `packages/next/src/index.ts` line 433.

The git-deploy path would likely work, but hosting three Node processes plus a
webhook on Vercel costs more than one VPS at this stage.

---

For questions or to resume this setup, send Hermes the VPS IP + root password
through the secure channel and reference this doc.
