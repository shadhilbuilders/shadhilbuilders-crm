# Deploying Shadhil CRM to Hostinger VPS + Coolify

Last verified: 2026-09-02. Author: Hermes (PaalStack OS).

## Why this setup

- Vercel CLI failed on this pnpm monorepo (see "Vercel CLI history" at the bottom).
- The app is **Next.js 16 + NestJS 12 + Supabase Postgres + Redis**, with a
  WhatsApp webhook — two long-running Node servers and a webhook that should not
  cold-start. One VPS hosting all three is cheaper than three managed services
  and avoids cold starts.
- Coolify gives us Vercel-like UX (git push → auto-build → preview URL) on our
  own VPS, with no per-seat or per-invocation metering.

## Cost

| Component | Plan | Cost |
|---|---|---|
| Hostinger VPS | KVM2 — 4 GB / 2 vCPU / 50 GB SSD, Ubuntu 22.04 | ~₹500/mo |
| Coolify | Self-hosted (free tier) | ₹0 |
| Supabase | Free tier (keep as-is) | ₹0 |
| Cloudflare R2 | Free tier (keep as-is) | ₹0 |
| Domain | One you already own | (existing) |
| **Total ongoing** | | **~₹500/mo** |

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │ Hostinger VPS (Ubuntu 22.04, KVM2)          │
                    │                                             │
   Internet ─────►  │  Nginx (Coolify reverse proxy, :80/:443)    │
                    │     │                                       │
                    │     ├──► crm.yourdomain.com  → Next.js :3000│
                    │     ├──► api.yourdomain.com  → NestJS :8080 │
                    │     └──► coolify.yourdomain.com → Coolify UI│
                    │                                             │
                    │  Coolify (Docker, :8000 internal)           │
                    │  ├─ app: shadhil-web   (Next.js container)  │
                    │  ├─ app: shadhil-api   (NestJS container)   │
                    │  └─ svc: shadhil-redis (Redis container)    │
                    └─────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────────┐
                    │ Supabase (managed)   │
                    │ Postgres + Auth      │
                    └──────────────────────┘
                              ▲
                              │ (DB only — no app traffic)
                              │
                              │
                    ┌──────────────────────┐
                    │ Cloudflare R2        │
                    │ Photo uploads        │
                    └──────────────────────┘
```

## Prerequisites — what you need to bring

1. **Hostinger KVM2 VPS**, Ubuntu 22.04 LTS. After purchase you'll get:
   - VPS public IP (e.g. `72.62.xx.xx`)
   - Root password (or you can set up SSH key)
2. **One domain you own** that you can point subdomains at:
   - `crm.<yourdomain>` → public, the Next.js app users hit
   - `api.<yourdomain>` → public, called by Next.js + WhatsApp webhook
   - `coolify.<yourdomain>` → semi-private (Coolify dashboard)
3. **GitHub PAT** with `repo` + `read:org` scopes, so Coolify can clone
   `shadhilbuilders/shadhilbuilders-crm`. If you'd rather not give Coolify a
   PAT, use the deploy-key flow instead (Coolify generates a key you add to
   the repo).

## Phase 1 — Provision VPS

Buy Hostinger KVM2 from hpanel.hostinger.com. After checkout:

1. Set the hostname in hPanel to something like `shadhil-prod-01`.
2. Note the public IPv4 address — you'll need it for DNS and SSH.
3. Choose Ubuntu 22.04 LTS x86_64 as the OS.
4. Set the root password (long, random — you'll use this once then disable
   password auth).

Send Hermes the **public IP** + **root password**. Do not send it in chat —
use the secure channel he provides.

## Phase 2 — Harden VPS + install Coolify

Hermes will SSH in and run (one-time, ~20 min):

1. **Hardening baseline** — non-negotiable before Coolify install:
   - `apt update && apt upgrade -y`
   - Create non-root user `deploy` with sudo, copy SSH key
   - `ufw allow 22,80,443,8000/tcp`; `ufw default deny incoming`
   - Install `fail2ban` with default SSH jail
   - `sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`
   - Test SSH key login as `deploy`, then `sudo reboot`
2. **Install Docker** via Coolify's official installer:
   ```bash
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker deploy
   ```
3. **Install Coolify v4** (self-hosted, free):
   ```bash
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
   ```
   Coolify listens on `:8000` internally; nginx (installed by Coolify) fronts
   it on `:80`/`:443`.
4. **Set up Coolify admin**: first-run wizard at `http://<vps-ip>:8000`.
   Create the admin user, save the password in your password manager.
5. **Verify HTTPS for Coolify**: once DNS is pointed (Phase 4), Coolify
   auto-issues Let's Encrypt certs. Manual cert check:
   ```bash
   ssh deploy@<vps-ip> 'docker logs coolify-proxy 2>&1 | grep -i cert'
   ```

## Phase 3 — Provision apps on Coolify

In Coolify UI (`coolify.<yourdomain>` after DNS), for each app:

### 3a. Add GitHub source

- **Source** → GitHub App (preferred) or PAT
- Repo: `shadhilbuilders/shadhilbuilders-crm`
- Branch: `main`

### 3b. App 1 — `shadhil-web` (Next.js)

- **Type**: Application
- **Build pack**: `Dockerfile`
- **Dockerfile location**: `apps/web/Dockerfile`
- **Build context**: `.`  ← **important: repo root, not `apps/web/`**
- **Port**: `3000`
- **Domain**: `crm.yourdomain.com`
- **Health check path**: `/` (or `/api/health` if you add one)
- **Env vars** (set in Coolify UI — do NOT put in `.env` in the repo):
  ```
  NODE_ENV=production
  NEXT_PUBLIC_SUPABASE_URL=<from your .env>
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<from your .env>
  NEXT_PUBLIC_APP_URL=https://crm.yourdomain.com
  NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com
  BETTER_AUTH_SECRET=<from your .env>
  BETTER_AUTH_URL=https://crm.yourdomain.com
  DIRECT_DATABASE_URL=<from your .env, Supabase pooler>
  BACKEND_API_URL=http://shadhil-api:8080
  JWT_SECRET=<from your .env>
  ```
- **Build args** (Coolify "Build Arguments" section — `NEXT_PUBLIC_*` are baked at build time):
  ```
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  NEXT_PUBLIC_APP_URL=https://crm.yourdomain.com
  NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com
  NEXT_PUBLIC_DEBUG_MODE=false
  ```
- Click **Deploy**. First build takes 4–8 min (pnpm install + Next build).
  Watch the logs in Coolify's terminal pane.

### 3c. App 2 — `shadhil-api` (NestJS)

- **Type**: Application
- **Build pack**: `Dockerfile`
- **Dockerfile location**: `apps/backend/Dockerfile`
- **Build context**: `.`  ← repo root
- **Port**: `8080`
- **Domain**: `api.yourdomain.com`
- **Env vars**:
  ```
  NODE_ENV=production
  POOL_MODE=session
  API_PORT=8080
  DIRECT_DATABASE_URL=<from your .env, Supabase pooler>
  BETTER_AUTH_SECRET=<from your .env>
  WA_ACCESS_TOKEN=<Meta WhatsApp Cloud API token>
  WA_PHONE_NUMBER_ID=1344555108732643
  WA_BUSINESS_ACCOUNT_ID=<from your .env>
  WA_WEBHOOK_VERIFY_TOKEN=<from your .env>
  SUPABASE_URL=<from your .env>
  SUPABASE_SECRET_KEY=<from your .env, sb_secret_*>
  CLOUDflare_R2_* (account id, access key, secret, bucket, public URL)
  ```
- Click **Deploy**. Watch the boot logs for `Nest application successfully
  started` and absence of `PoolModeError`.

### 3d. Service — `shadhil-redis`

- **Type**: Service → Redis 7-alpine
- **No domain** (internal only — referenced as `redis://shadhil-redis:6379`)
- The NestJS app uses Redis for BullMQ queues (if any); if not, skip this
  service.

### 3e. Internal networking

Coolify puts each resource on its own Docker network by default. The two apps
need to reach each other:
- `BACKEND_API_URL=http://shadhil-api:8080` (already set in 3b)
- If NestJS needs Redis: `REDIS_URL=redis://shadhil-redis:6379`

Coolify auto-resolves service names on shared networks. If the apps can't see
each other, add both to a shared "shadhil-net" in Coolify's network settings.

## Phase 4 — DNS

In your domain registrar's DNS panel, add A records:

| Host | Type | Value |
|---|---|---|
| `crm` | A | `<vps-ip>` |
| `api` | A | `<vps-ip>` |
| `coolify` | A | `<vps-ip>` |

DNS propagation: 5 min – 48 hr depending on TTL. Check with
`dig crm.yourdomain.com`.

Once DNS resolves, Coolify's auto-issued Let's Encrypt certs will activate
within ~5 min. Verify with `curl -vI https://crm.yourdomain.com` — should
show `subject: CN=crm.yourdomain.com`, `issuer: Let's Encrypt`.

## Phase 5 — Verify end-to-end

From your laptop:

```bash
# 1. Next.js responds
curl -I https://crm.yourdomain.com
# expect: HTTP/2 200, server: Caddy (Coolify's reverse proxy)

# 2. Next.js can reach NestJS
curl https://crm.yourdomain.com/api/backend/health
# or whatever your BFF health route is — Next rewrites /api/backend/* → shadhil-api:8080/*

# 3. NestJS health directly
curl https://api.yourdomain.com/api/docs
# expect: Swagger HTML page

# 4. Supabase connection
curl https://api.yourdomain.com/api/users/me -H "Cookie: <test-session>"
# expect: 401 (no auth) — confirms DB connection, not a 500

# 5. WhatsApp webhook
# In Meta Business Suite → WhatsApp → Configuration → Webhook:
#   URL: https://api.yourdomain.com/api/webhook/whatsapp
#   Verify token: <WA_WEBHOOK_VERIFY_TOKEN>
# Send a test message to your test number; check the Delivery status column
# in the shadhil-web UI — should transition sent → delivered → read.
```

## Phase 6 — Auto-deploy on git push (optional but recommended)

In Coolify UI, for each app: **Settings → Webhooks → copy the webhook URL**.
Then in your GitHub repo:

1. Settings → Webhooks → Add webhook
2. Payload URL: `<coolify-webhook-url>`
3. Content type: `application/json`
4. Events: "Just the push event"
5. Save.

Now every push to `main` triggers a rebuild in Coolify. Same UX as Vercel.

For PR preview deploys: Coolify supports "Preview Deployments" — turn on per
app in Settings → Previews. Each PR gets its own URL like
`https://pr-42.shadhil-web.<your-vps-ip>.traefik.me`.

## Ongoing operations

### Updating the app

Just `git push origin main`. Coolify rebuilds + redeploys in 2–5 min.

If the schema changes:
1. Push code
2. Wait for backend deploy
3. Coolify → shadhil-api → "Execute Command" → run migrations manually:
   ```
   docker exec -it <container> pnpm --filter @shadhil/database migrate
   ```

### Backups

- **Supabase**: managed daily backups (free tier keeps 7 days). Verify in
  Supabase dashboard → Settings → Database → Backups.
- **R2**: versioning off by default — turn on for the photos bucket if you
  need undo.
- **VPS itself**: use Hostinger's snapshot feature weekly, or set up
  `borgbackup` to push to R2. Hermes can set this up if you want.

### Logs

```bash
ssh deploy@<vps-ip>
docker logs -f --tail 200 shadhil-web-xxxx
docker logs -f --tail 200 shadhil-api-xxxx
```

Or in Coolify UI → app → Logs.

### Scaling up

KVM2 (4 GB) holds ~2 Next containers + 1 Nest + Redis + Coolify + nginx
comfortably. If you hit memory pressure:

1. Upgrade to KVM4 (8 GB / 4 vCPU, ~₹900/mo) — instant via Hostinger hPanel
2. Or move Supabase to a dedicated managed plan + add a 2nd VPS for backend

## Vercel CLI history (why we left)

For posterity — the Vercel CLI deploys failed with two distinct errors, and
config tweaks alone didn't resolve them:

1. **`pnpm install` failed: "Headless installation requires a pnpm-lock.yaml
   file"** — root cause: `pnpm-lock.yaml` lives at the monorepo root, but
   Vercel's local CLI (run from `apps/web/`) treated that directory as the
   project root, so install ran without the lockfile. **Partial fix**: change
   `installCommand` to `cd ../.. && pnpm install --frozen-lockfile`. pnpm
   walks up to find the workspace root.

2. **"No Next.js version detected"** — appeared after fixing (1). The Next
   builder's `require.resolve('next/package.json', { paths: [entryPath] })`
   fails inside the Vercel build container despite pnpm linking `next` into
   `apps/web/node_modules/next` locally. `vercel/vercel` source:
   `packages/next/src/index.ts` line 433 (`getRealNextVersion`). Tried
   `rootDirectory=apps/web`, `sourceFilesOutsideRootDirectory=true`, varying
   build/install commands — none resolved it.

The git-deploy path (`git push` → Vercel auto-build) would likely work, but
hosting two Node apps + a webhook on Vercel costs more than one VPS at our
stage. Hence: Coolify + Hostinger.

## Files changed for this deploy (uncommitted)

```diff
diff --git a/apps/web/vercel.json b/apps/web/vercel.json
-  "installCommand": "pnpm install --frozen-lockfile",
+  "installCommand": "cd ../.. && pnpm install --frozen-lockfile",
+  "outputDirectory": ".next",
```

You do NOT need this `vercel.json` change for Coolify — leave it as-is or
revert, Coolify uses the Dockerfile, not Vercel config. Hermes left it in
place so the file is not broken if you ever go back to Vercel CLI deploys.

---

For questions or to resume this setup, send Hermes the VPS IP + root
password through your secure channel and reference this doc.