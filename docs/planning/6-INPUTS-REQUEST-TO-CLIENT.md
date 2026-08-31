# Shadhil CRM — 6 Inputs Tracker

**Source:** `SIGN-OFF-SUMMARY-v3.1.md` §"What we need from you to start Week 1"
**Status:** Awaiting client (Shadhil promoter + sales leadership + finance lead)
**Owner:** PaalStack delivery
**Date:** 2026-08-30
**Blocker for:** Week 1 scaffold (Inputs #1–4 block scaffold; #5 blocks Week 3 user provisioning; #6 blocks Week 5 telephony)

---

## Input #1 — RERA + CMDA registration details

**Required by:** Week 1 of build (blocks WhatsApp template submission + every customer-facing surface)
**Format:** RERA = `TN/02/XXXX/YYYY`, CMDA = alphanumeric plan approval number, validity = date range

| Field | Value | Status |
|---|---|---|
| RERA registration number | (awaiting — placeholder used) | ⏳ Pending |
| CMDA plan approval number | (awaiting) | ⏳ Pending |
| Validity start date | (awaiting) | ⏳ Pending |
| Validity end date | (awaiting) | ⏳ Pending |
| Project name as on RERA certificate | Shadhil Metro Heights | ✅ Known |

**Current placeholder in code:** `TN/02/0000/2024` (TODO, must replace before Week 5 WhatsApp template submission)

**Where it surfaces in the app:**
- WhatsApp template headers (4 templates, Meta approval pending)
- Landing site footer (already on `~/workspace/shadhil-projects/landing-page/` — verify it's correct)
- Push notification titles (lead assigned, booking approved, etc.)
- RERA compliance export (Admin → Compliance → Project data export — JSON includes RERA# per record)

---

## Input #2 — Signed Model C process adoption

**Required by:** Week 1 of build (blocks any state-machine implementation work in Week 4)
**Owner of signature:** Shadhil sales leadership (NOT just promoter verbal)

| Item | Value | Status |
|---|---|---|
| Signed document on file | (awaiting — confirmed intent) | ⏳ Pending signature |
| Telecaller role understood | "Books + confirms visit, owns through VISIT_SCHEDULED" | ✅ Confirmed |
| Sales exec role understood | "Conducts visit, takes over at VISITED" | ✅ Confirmed |
| Manager role understood | "Per-team only, no lead reassignment in v1" | ✅ Confirmed |
| Ownership transfer understood | "Automatic on visit outcome, no manager gate" | ✅ Confirmed |

**Code implication:** Until signature lands, state machine + handoff flow is built but feature-flagged OFF (`MODEL_C_ENABLED=false`). Falls back to "always-telecaller" model (legacy behavior).

---

## Input #3 — WhatsApp Business number provisioning

**Required by:** Week 1 (provisioning) + Week 5 (active + templates approved)

| Field | Value | Status |
|---|---|---|
| New CRM WhatsApp Business number | (awaiting) | ⏳ Pending |
| Separate from landing site +91 9025012311 | (verified not reused) | ⏳ Pending |
| Meta Business Manager verified | (awaiting) | ⏳ Pending |
| WhatsApp Business API access | (awaiting) | ⏳ Pending |

**Code implication:** Until number is active, WhatsApp webhook handler in NestJS is built but `WA_WEBHOOK_VERIFY_TOKEN` env is unset. Inbound messages queue in Redis but don't process.

---

## Input #4 — FreJun vendor sign-off

**Required by:** Week 1 (LOI) + Week 5 (signed contract + provisioning complete)

| Field | Value | Status |
|---|---|---|
| FreJun contract signed | (awaiting — LOI sent) | ⏳ Pending |
| 10 user plan confirmed | (awaiting) | ⏳ Pending |
| Indian phone number provisioned | (awaiting) | ⏳ Pending |
| Cost confirmed | ~₹15,300/month at 10 users | ✅ Estimated (per design) |

**Code implication:** Until contract lands, telephony webhook handler in NestJS is built but `FREJUN_API_KEY` env is unset. Call recording archive is wired but doesn't receive calls.

---

## Input #5 — First roster (Admin/Manager/Telecaller/Sales Exec)

**Required by:** Week 3 (3 users minimum provisioned) + Week 5 (full roster)

**Minimum 3 for Week 3:**

| Role | Name | Email | Phone | Status |
|---|---|---|---|---|
| Admin | (awaiting) | (awaiting) | (awaiting) | ⏳ |
| Manager | (awaiting) | (awaiting) | (awaiting) | ⏳ |
| Telecaller | (awaiting) | (awaiting) | (awaiting) | ⏳ |
| Sales exec | (awaiting) | (awaiting) | (awaiting) | ⏳ |

**Code implication:** Until names arrive, Admin user is created with placeholder `admin@shadhilbuilders.in` and the Admin signs in via the seeded link. First Manager is created via better-auth admin plugin during Week 3. Roster change is one config update via Admin UI.

---

## Input #6 — Sales exec + telecaller phone numbers for FreJun KYC

**Required by:** Week 1 (FreJun KYC) + Week 5 (numbers live)

| Role | Name | Phone | Aadhaar/PAN (last 4) | Status |
|---|---|---|---|---|
| Sales exec 1 | (awaiting) | (awaiting) | (awaiting) | ⏳ |
| Sales exec 2 | (awaiting) | (awaiting) | (awaiting) | ⏳ |
| Telecaller 1 | (awaiting) | (awaiting) | (awaiting) | ⏳ |
| Telecaller 2 | (awaiting) | (awaiting) | (awaiting) | ⏳ |

**Code implication:** Until numbers land, the FreJun dashboard agent provisioning script is built but no agents are created. Outbound calls from CRM fail gracefully with "telephony not provisioned" error.

---

## Tracking

- **Source-of-truth file:** This doc (`6-INPUTS-REQUEST-TO-CLIENT.md`)
- **Update frequency:** Every Friday (PaalStack weekly status email triggers this update)
- **Escalation path:** If any input is missing by EOD Wednesday of the week before it's needed, PaalStack flags it in the weekly status email and offers to call the promoter directly.

---

## What PaalStack is doing in parallel (doesn't need the inputs)

- Monorepo scaffold (Turborepo + pnpm) — pure code, no client inputs needed
- Prisma schema + RLS — pure schema work, no client inputs needed
- better-auth integration — JWT bridge + auth flows, only needs BETTER_AUTH_SECRET (PaalStack generates)
- NestJS module scaffold — pure code, no client inputs needed
- Docker Compose for VPS provisioning — pure infra, no client inputs needed
- WhatsApp template draft + Meta submission — needs #3 only at submission time, not draft time
- FreJun dashboard agent provisioning script — code-ready, runs as soon as #6 lands
- UI component work — uses placeholders for all 6 inputs

**Estimated parallel work before inputs land: Weeks 1–2 fully productive on backend, partial Week 4 on UI.**

---

## Where to send inputs

- **Primary:** Reply to PaalStack's weekly Friday status email (gets routed to delivery@paalstack.com)
- **Backup:** WhatsApp PaalStack delivery lead direct (+91 XXXXX XXXXX)
- **RERA# specifically:** must come from signed certificate (not screenshot) — promoter signs and forwards PDF

---

**Last updated:** 2026-08-30 (awaiting client)