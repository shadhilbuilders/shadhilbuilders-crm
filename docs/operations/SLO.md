# Service Level Objectives - Shadhil Builders CRM

Last updated: 2026-10-01. Owner: PaalStack (Hermes, PaalStack OS).
Applies to: the production stack on the Hostinger VPS via Coolify
(`crm.`, `api.crm.`, `sse.crm.` at `shadhilbuilders.in`).

## Why this document exists

The requirement from the owner is "24/7 uptime, and if it fails it recovers."
This document turns that into numbers, so that:

- "up" has a measurable definition instead of a feeling,
- we know which failures are within budget and which are not,
- an outage has a defined response instead of an improvised one,
- and nobody promises the client more than the architecture delivers.

**The number in this document is an internal engineering target, not a
contractual SLA.** If the client needs a contractual figure, the architecture
must change first (see "What would void these targets").

## Scope: what is measured

| # | Service | What the user experiences | In scope |
|---|---|---|---|
| SLO-1 | `shadhil-web` (`crm.`) | the app loads and pages render | yes |
| SLO-2 | `shadhil-api` (`api.crm.`) | data loads, saves, approves, sends | yes |
| SLO-3 | `shadhil-realtime-sse` (`sse.crm.`) | live chat and notification badges update | degraded-only |
| SLO-4 | `shadhil-postgres` + `shadhil-pgbouncer` | everything above depends on it | best-effort |
| SLO-5 | Background jobs (reminders, overdue alerts, WhatsApp outbound) | an action happens on schedule | best-effort |

SLO-3 is deliberately weaker: losing the live stream degrades the product but the
UI degrades gracefully (the client reconnects with backoff and replays missed
events via `Last-Event-ID`), so a stream outage is not a page outage.

## The targets

| Service | Objective | Monthly error budget | Reasoning |
|---|---|---|---|
| SLO-1 web | **99.9%** | 43 min 50 s | user-facing; a dead page is the most visible failure |
| SLO-2 api | **99.9%** | 43 min 50 s | same - every screen depends on it |
| SLO-3 sse | **99.5%** | 3 h 39 min | real-time is a nicety; the UI recovers without it |
| SLO-4 data | **99.9%** | 43 min 50 s | inferred from API health (it is the API's dependency) |
| SLO-5 jobs | **99.0%** | 7 h 18 min | a late reminder is a business problem, not an outage |

**Measurement window:** a rolling 30 days.
**Availability formula:** `1 - (failed_minutes / total_minutes)`, where a minute
is *failed* if any health probe in it returns non-2xx or times out (3
consecutive failures = 1 failed minute, so one blip does not burn budget).

99.9% is the target because it is **reachable on the current single VPS** with
the work listed below. It is not reachable by accident, and it is not a
description of today.

## Current measured state: UNMEASURED

Be blunt about this. **Nothing measures availability today.** There is no uptime
monitor installed on the VPS, so the numbers above are targets with zero history
behind them. Until Phase A below is done, treat availability as unknown, and do
not quote a figure to anyone.

What we DO know from the code and the compose file:

- All six services carry `restart: unless-stopped`, so a crashed container comes
  back without a human. That is the largest single contributor to not being down.
- The SSE client reconnects on its own with exponential backoff and replays
  missed events, so an SSE restart is largely invisible to the user.
- Cron work is crash-idempotent (Redis lease + `SCHEDULED → PROCESSING` claim),
  so a restart mid-job does not double-send or drop.
- The API refuses to boot on bad config (`assertBootEnv`) rather than running
  half-dead, which turns a silent outage into a loud one.
- Graceful shutdown is now enabled (`app.enableShutdownHooks()`), so redeploys
  release in-flight work instead of stranding it.

What we DO NOT know: any actual uptime percentage. Zero data.

## Error budget policy

The budget is 43 min 50 s per rolling 30 days for the app tier.

**Under 50% consumed:** deploy freely.

**Over 50% consumed:** releases need a rollback plan noted in the PR, and
Postgres maintenance windows are scheduled rather than taken opportunistically.

**Budget exhausted:** stop feature work on the affected service. The next
deploy is a reliability fix, and only that. This is the whole point of an error
budget - it converts "be careful" into a rule with a trigger.

**The deploy tax is real and this is the trap to avoid.** On a single instance,
every container recreate is ~10-30 seconds where that route 502s:

| Deploys / month | Downtime from recreates alone | Share of the 99.9% budget |
|---|---|---|
| 10 | ~3.3 min | 8% |
| 20 | ~6.7 min | 15% |
| 40 | ~13.3 min | 30% |

You can hit 99.9% simply by deploying less. That is the wrong answer. The right
answer is Phase B below (two instances + rolling restarts), which removes the
deploy tax entirely.

## Phase A - make it measurable (do this first)

You cannot manage an SLO you do not measure. In order:

1. **Install Better Stack** (free tier) on `crm.<domain>/api/health` and
   `api.crm.<domain>/api/health`, 30-second interval, from at least two regions.
   Add `sse.crm.<domain>/api/sse/healthz`.
2. **Wire the alert to Telegram.** An alert that lands nowhere is decoration.
   The API already has optional `TELEGRAM_*` support for its own alerting; use
   the same channel (or a dedicated ops channel).
3. **Health checks on all three app containers** in Coolify. Only Postgres and
   Redis declare one today, so Docker currently cannot tell a wedged API from a
   healthy one:

   | App | Path |
   |---|---|
   | `shadhil-web` | `/api/health` |
   | `shadhil-api` | `/api/health` |
   | `shadhil-realtime-sse` | `/api/sse/healthz` |

4. **Docker log rotation, daemon-wide.** An uncapped log file fills the 100 GB
   disk and then every service fails at once - an hours-long outage, not a
   minutes-long one. This is the cheapest large win available:

   ```json
   // /etc/docker/daemon.json
   { "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
   ```

   Then `sudo systemctl restart docker`.

5. **Start recording.** A weekly line in this file or a spreadsheet: probes,
   failed minutes, incidents with cause and duration. After 30 days there is a
   real baseline instead of a target.

## Phase B - earn the 99.9%

Ordered by downtime removed per hour of work:

1. **Two instances of `web` and `api` with rolling restarts.** Removes the
   deploy tax (up to 30% of budget at current cadence) and survives a
   single-container crash with no gap. This is the highest-value change.
2. **DB connection pool ceiling.** `DATABASE_URL` carries no `connection_limit`,
   so Prisma's default pool of 10 is shared by every request and exhausts before
   Postgres does (plan T-PERF-2). Add `?connection_limit=20`, then tune against
   real load.
3. **SSE `/api/sse/metrics` into the dashboard.** The service already exports
   `realtime_sse_active_connections`, `_ticket_mint_total`,
   `_ticket_consume_total`, `_tick_duration_seconds` and `_backlog_size`. Nothing
   scrapes them, so stream degradation is currently invisible.
4. **Alert on 5xx under `/api/sse/`.** A 5xx there means a live client's stream
   died - a real incident, unlike a clean reconnect.
5. **Rehearse the restore.** Backups are automated; the restore is not tested.
   Until it is, recovery time from a data loss event is unknown, which makes the
   data SLO unverifiable.

## What would void these targets

State these to the client rather than discovering them during an incident:

- **The VPS is a single point of failure.** App tier included. If the host dies,
  the site is down until a snapshot is restored elsewhere. Nothing in Phase A or
  B changes that. Protecting against it needs a second node.
- **A contractual 99.95% or higher is not available on this architecture.** That
  requires a second node, Postgres replication and load-balanced failover - a
  different cost bracket (multiples of the current ~₹3,000/month excluding
  telephony). Cost it before promising it.
- **Telephony (FreJun) and Meta WhatsApp are third-party dependencies.** Their
  outages are outside this SLO's control and are excluded from it. If they fail,
  WhatsApp features fail, and no amount of work on our VPS changes that.
- **No automated database failover.** Postgres runs as one container. That
  recovers a crashed process, not a corrupted volume.
- **Planned maintenance counts against the budget** unless announced in advance
  and scheduled outside business hours.

## Incident response

### Who is on call (decided 2026-10-01)

**Primary: the owner (PaalStack).** There is no rotation - one person, and the
plan's own risk table flagged this (P-3, plan §10) as "4-8 h/month on-call is
enough for a self-hosted stack", challenged as High.
**Secondary / escalation: Shadhil (the client),** for anything the owner cannot
resolve within the notify target (SEV-1 > 30 min).

Paging channel: **Telegram**, using the same bot the API already has
(`AlertsService` sends via `api.telegram.org/bot<token>/sendMessage` with
`chat_id` = `TELEGRAM_CHANNEL_ID`). Because `sendMessage` posts to a `chat_id`,
that value is a **group or channel id, not a personal chat** - create an ops
group, add the bot, put the owner in it now and the client in it once they are
onboarded. Telegram must have notifications enabled for that group, or 3am
pages arrive silently.

**Not yet provisioned.** No monitoring tool exists on the VPS, so nothing pages
anyone today. Set up in this order:

1. Create the ops Telegram group; add the alert bot; confirm a test message
   arrives on a phone.
2. Install Better Stack, pointing at `crm.<domain>/api/health`,
   `api.crm.<domain>/api/health` and `sse.crm.<domain>/api/sse/healthz`, every
   30s from at least two regions.
3. Wire Better Stack's alert to that same group, and **send a test alert**. An
   alert path nobody has seen fire is not a paging path.
4. Record in this doc which phone(s) carry the Telegram group. If the owner is
   travelling or asleep with notifications off, that is an unowned SEV-1.

### Severity

| Level | Definition | Response target | Notify |
|---|---|---|---|
| SEV-1 | site unreachable, or data loss/corruption | 15 min to acknowledge | owner immediately, client if >30 min |
| SEV-2 | a major feature broken (chat, bookings, approvals) | 1 h | owner |
| SEV-3 | degraded (slow, one integration down) | next business day | owner |
| SEV-4 | cosmetic or single-user issue | normal backlog | - |

### First actions, in order

```bash
ssh deploy@<vps-ip>
docker ps --filter 'name=shadhil' --format '{{.Names}}\t{{.Status}}'
df -h            # disk full is the #1 cause of "everything is down"
free -m          # OOM kills show up in dmesg
docker logs --tail 100 shadhil-api
docker restart shadhil-api
```

Check disk and memory **before** reading application logs. A full disk and an OOM
kill both present as unrelated app errors, and both take down everything rather
than one service.

### Recovery paths

- **Container crash-looping:** `docker restart <name>`; if it recurs, inspect the
  log, do not just restart again.
- **Bad deploy:** roll back to the previous deployment in Coolify. Prefer
  additive, backwards-compatible migrations so the old image still runs against
  the new schema.
- **Database unreachable:** check `shadhil-postgres`, then `shadhil-pgbouncer`.
  PgBouncer in session mode holds a slot per client - its restart is safe but
  expect a reconnect storm.
- **Whole VPS lost:** restore the latest `pg_dump` into a fresh Postgres, repoint
  DNS, redeploy. **Rehearse this once before go-live.** An untested restore is
  not a backup.

### After every SEV-1 and SEV-2

Write it down: timeline, cause, what fixed it, and one concrete change that
prevents the repeat. Blameless - the goal is the missing guard or the missing
alert, not who ran the command. Add the durable outcome to
`docs/planning/IMPLEMENTATION-PLAN-v1.md`'s Decision Audit Trail so it is not
lost in a commit message.

## Change log

| Date | Change |
|---|---|
| 2026-10-01 | Created. Targets set at 99.9% app / 99.5% SSE / 99.9% data / 99.0% jobs. Current state recorded as UNMEASURED; Phase A not yet done. |
| 2026-10-01 | On-call named: owner primary, client escalation. Paging channel fixed to the existing Telegram bot (group chat_id, not a DM). Still not provisioned - no monitor on the VPS. |
