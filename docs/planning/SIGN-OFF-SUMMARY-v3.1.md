# Shadhil Builders CRM - v3.1 Executive Summary for Sign-Off

**For:** Shadhil promoters, sales leadership, finance lead
**From:** PaalStack delivery
**Date:** 2026-08-29
**Status:** Build-ready pending your answers to 6 questions below
**Full design:** `DESIGN.md` (1,026 lines, 28 locked decisions)

---

## Situation

Shadhil currently runs sales on Google Sheets, personal phone calls, and individual WhatsApp. Shadhil Metro Heights (RERA + CMDA approved) is generating leads at growing volume, and leadership has asked for a CRM that gives managers real-time visibility into pipeline, holds the sales team accountable to a process, and survives RERA + CMDA compliance scrutiny. We (PaalStack) have spent 13 rounds of design review with you arriving at the v3 brief in `DESIGN.md`. This summary is what we want your sign-off on.

## Complication

A CRM is only as good as the discipline it enforces. Three things will determine whether this project succeeds or becomes shelfware:

1. **Whether every lead, every message, every call flows through the system** - not personal WhatsApp on the side. This is what "monitor by application" means.
2. **Whether the sales process changes to match Model C** - telecaller books and confirms, sales exec conducts the visit, ownership transfers automatically when the visit outcome is logged. This is non-negotiable for the no-show rate to drop from industry-baseline 30–40% to the target <25%.
3. **Whether RERA + CMDA registration details become first-class data in the system** - not buried in a Google Drive folder. RERA TN inspectors ask for project-level data exports on complaint. We can produce one in 7 days if the schema supports it; we cannot if it doesn't.

## Question

Are Shadhil's promoter, sales leadership, and finance lead willing to (a) commit the team to the Model C process in writing, (b) capture every customer interaction through the system, and (c) provide the 6 inputs below before Week 1 of build?

## Answer (the v3.1 build, in 5 lines)

A web + mobile CRM for Shadhil Metro Heights and any future RERA + CMDA approved project. 9 modules (lead inbox, lead detail, site visit scheduler, inventory, in-app chat, booking pipeline, reminders, audit log, notification center). Next.js 16 web app + Expo mobile app + NestJS backend on a Hostinger VPS via Coolify. 13 weeks to v1. ~₹30,000/month hosting + ₹15,300/month telephony (FreJun, locked). 5–15 users in v1, designed to scale to 50–200 without re-architecture.

---

## What you are signing off on

**Decisions locked in v3 (28 total, full list in DESIGN.md §20):**

- **Architecture:** NestJS + REST on Hostinger VPS via Coolify (self-hosted, India region, ~$30/month)
- **Auth:** better-auth embedded in the same Next.js app as the web UI
- **Realtime:** Server-Sent Events for chat, notifications, reminders (one-way server → client is enough)
- **Database:** Postgres in Docker via PgBouncer with row-level security enforced from day 1
- **Telephony:** FreJun (₹1,149/user/month) with call recording + AI transcription on by default, archived 7 years to Cloudflare R2
- **Mobile:** PWA in v1 (4–5 weeks) + Expo app in v1.1 (not optional, both ship)
- **Lead lifecycle:** Model C hybrid handoff (telecaller owns through visit outcome, exec conducts visit, ownership transfers automatically) - removes the perverse incentive behind the 30–40% no-show rate
- **Reminders:** 4 types in v1 (pre-visit staff + customer, reschedule follow-up, no-show)
- **Push notifications:** Expo Push as the universal service for iOS + Android + Web, 12 triggers in v1
- **Audit retention:** 7 years (RERA upper bound), immutable, R2-archived
- **Compliance:** RERA Tamil Nadu + CMDA Act built into v1 (consent capture, right-to-erasure, audit log)

**What you get at v1 launch (Week 13):**
- Every agent has a login, sees their own queue, logs activity in the system
- Manager sees the funnel, handoff latency, per-exec bookings, source ROI in real time
- WhatsApp messages flow through the CRM number (new, separate from landing site)
- Calls auto-record with AI transcription
- 12 push triggers fire on the right events at the right times
- Audit log captures every login, lead view, state transition, message, call, consent change
- Admin can export per-project data on demand for RERA inspection
- CMDA right-to-erasure workflow available to Admin

**Success metrics PaalStack is committing to (DESIGN.md §13):**
- Time-to-first-touch: <30 min median by Day 30, <15 min by Day 90
- No-show rate: <25% by Day 60, <20% by Day 90 (industry baseline 30–40%)
- Handoff response latency: <30 min by Day 30, <15 min by Day 60
- Daily active agent use: ≥4 of 5 agents with ≥5 meaningful actions/day, 5 days/week by Day 30
- Activity completeness: ≥80% of leads with ≥3 logged activities within first 7 days by Day 60

---

## What you are explicitly NOT getting in v1 (deferred to v1.1+)

- Document Vault full version (use Google Drive + link in notes for v1)
- E-sign integration (lawyer-mediated agreements, as today)
- Per-trigger notification settings (all 12 triggers on by default; Mark-all-as-read for noise control)
- Agreement template generation
- Tamil UI (sales team English-comfortable; deferred to v1.2)
- AI lead scoring (no validated signal until 90 days of conversion data exist)
- Customer / buyer portal (post-booking tracking lives with the sales exec, not in a customer-facing app)
- Broker / channel-partner portal (out of scope for v1)

---

## What we need from you to start Week 1

These are the 6 inputs that block build. PaalStack can wait for answers on the others (D6, D7 in `REVIEW-OF-DESIGN.md`), but these six cannot wait past Week 1:

1. **RERA registration number for Shadhil Metro Heights** (TN/02/XXXX/YYYY format), CMDA plan approval number, validity dates. RERA display on every customer-facing surface (WhatsApp templates, landing site, push titles) is mandatory under TN RERA Rules 2017.
2. **Signed process adoption of Model C.** Telecaller books + confirms visit, sales exec conducts visit, ownership transfers automatically on visit outcome, no manager gate. If this process is not enforced, the no-show rate metric does not improve and the project fails its primary objective. Needs signature from sales leadership, not just verbal agreement.
3. **WhatsApp Business number provisioning confirmation.** A new, separate WhatsApp Business number for the CRM (not the landing site's +91 9025012311). Production approval from Meta takes 1–2 weeks. Week 1 of build submits 4 new templates for approval; the number itself needs to be active by then.
4. **FreJun sign-off.** Decision #7 in the design brief. ~₹15,300/month at 10 users. Needs signed vendor contract or letter of intent before telephony integration begins.
5. **First manager + telecaller + sales exec roster.** Names, emails, phone numbers. Admin creates all roles in-app on Day 1, including the first manager. We need at least 3 users provisioned by end of Week 3.
6. **Sales exec + telecaller phone numbers for FreJun KYC.** FreJun requires Aadhaar or PAN + phone for Indian number provisioning. Submit in Week 1 or telephony integration blocks in Week 5.

---

## Cost summary

| Line item | Monthly | Notes |
|---|---|---|
| Hostinger VPS 8GB (India) | ~₹2,500 | Coolify handles SSL, backups, deploys |
| Backblaze B2 / Cloudflare R2 | ~₹500 | Postgres dumps + call recording archive |
| FreJun telephony | ~₹15,300 | At 10 users: plan + usage + 1 number |
| Expo Push | Free | Up to 1M pushes/month on free tier |
| Better Stack uptime monitoring | Free | Free tier sufficient for v1 |
| Sentry error tracking | Free | Free tier sufficient for v1 |
| **Total recurring** | **~₹18,300/month** | At 10 users |

One-time: ~₹60,000–₹80,000 PaalStack delivery for v1. v1.1 scoped separately.

---

## Risks we are explicitly carrying

Per DESIGN.md §19:

- **Stack is NestJS + REST on a self-hosted VPS** - defensible but slower to ship than Supabase + Next.js full-stack. If at Week 3 the friction is real, the data model and auth design transfer to the alternative stack with ~1 week of rework.
- **Coolify is a real product, but you (Shadhil) are the on-call.** Budget 4–8 hours/month for VPS maintenance, Postgres backup verification, Coolify upgrades. If that's not realistic for your bandwidth, this stack isn't the right pick.
- **"1 ms literally" is impossible.** We deliver 99.95% uptime (52 min/year) for v1. Multi-region HA for true zero-downtime is a v3 conversation.
- **99.95% uptime assumes the single-VPS design works as intended.** Backup verification is a weekly cron, not a hope.

---

## Next steps if you sign off

- **This week:** PaalStack delivers `REVIEW-OF-DESIGN.md` (the PM critique that produced this summary) and the v3.1 patched doc set (fixes 6 internal inconsistencies in the design brief - 30-minute mechanical fix).
- **Week 1 of build:** VPS + Coolify + DNS + SSL provisioned, monorepo scaffolded, 4 WhatsApp templates submitted to Meta for approval.
- **Weekly Friday update:** PaalStack sends async status to Shadhil promoter + sales lead. No one asks "what's the status" - we publish before anyone asks.
- **Week 13:** v1 live, runbook delivered, monitoring + alerting active, first production deployment.

---

## Sign-off

| Role | Name | Signature | Date |
|---|---|---|---|
| Shadhil promoter | | | |
| Shadhil sales lead | | | |
| Shadhil finance lead | | | |
| PaalStack delivery | | | |

By signing, Shadhil commits to the 6 inputs above and to enforcing the Model C process. PaalStack commits to the 13-week timeline and the success metrics in DESIGN.md §13.