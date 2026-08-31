# Shadhil CRM — Planning Master

**Single entry point for everything planning-related in this repo.**
Migrated from `~/workspace/shadhil-projects/crm/` on 2026-08-31 (folder deleted after
byte-verified migration; user decision: "only keep needed ones").

## Document index

| Document | What it is | Status |
|----------|-----------|--------|
| [`docs/planning/IMPLEMENTATION-PLAN-v1.md`](IMPLEMENTATION-PLAN-v1.md) | **THE PLAN** — 13-week build, all phases, section 0-19 + full /autoplan review (2026-08-31, APPROVED) + task list + review report | Plan of record |
| [`docs/planning/DESIGN.md`](DESIGN.md) | Source design (v3.1, 1,038 lines, 28 locked decisions) — §-referenced throughout the plan | Signed off |
| [`docs/planning/WIREFRAMES.md`](WIREFRAMES.md) | Locked ASCII wireframes + UI reference (eng/design tasks point here) | Locked |
| [`docs/planning/SIGN-OFF-SUMMARY-v3.1.md`](SIGN-OFF-SUMMARY-v3.1.md) | 1-page client sign-off + the 6 required inputs | Signed off |
| [`docs/planning/SIGN-OFF-SUMMARY-v3.1.pdf`](SIGN-OFF-SUMMARY-v3.1.pdf) | Client-facing PDF of the same | Sent |
| [`docs/planning/6-INPUTS-REQUEST-TO-CLIENT.md`](6-INPUTS-REQUEST-TO-CLIENT.md) | Live tracker for the 6 client inputs (check before Week 1) | ⏳ Awaiting client |
| [`docs/planning/ASSIGNMENT-MODEL-CHANGE.md`](ASSIGNMENT-MODEL-CHANGE.md) | Full design rationale for manual reassign + auto-assignment (§18 backing doc) | Ratified |
| [`docs/planning/DECISION-CHANGELOG.md`](DECISION-CHANGELOG.md) | Chronological trace of every design decision round | Historical |
| [`docs/planning/CLIENT-DECISIONS.md`](CLIENT-DECISIONS.md) | 16 resolved client questions + reliability design | Historical |
| [`docs/planning/WORKFLOW-DIAGRAMS.md`](WORKFLOW-DIAGRAMS.md) | 6 ELI10 diagrams (system, web auth, mobile auth, lifecycle, handoff) | Historical |
| [`docs/planning/feedback-archive/`](feedback-archive/) | All 12 client feedback rounds + archived questions (provenance only) | Archive |

## Reading order (new engineer)

1. This file (index)
2. `DESIGN.md` — what we're building and why
3. `IMPLEMENTATION-PLAN-v1.md` — how and when, plus the full review record
4. `WIREFRAMES.md` — what the screens look like
5. Traceability when needed: `DECISION-CHANGELOG.md`, `feedback-archive/`

## Post-migration path references

The plan body still contains some legacy path mentions (`crm/.plans/...`,
`~/workspace/shadhil-projects/crm/...`). As of this migration the canonical
locations are the paths in the index above. Old paths are dead; do not recreate
them. (Path sweep of the plan body: sections 16-17 refer to `.plans/…` names —
same filenames now live in `docs/planning/` — plus the restore-point comment at
the top of the plan file, which points at an out-of-repo backup and stays valid.)

## Review artifacts (outside repo, deliberately)

- Restore point: `~/.gstack/projects/shadhil-crm-plans/main-autoplan-restore-20260831-002701.md`
- Test-plan artifact + review logs + TODOS: `~/.gstack/projects/shadhil-crm-plans/`