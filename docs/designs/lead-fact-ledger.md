# Lead fact ledger

Status: implemented in `feat/lead-fact-ledger` (T-LEAD-FACTS, 2026-11-05).
Source of the pattern: [trycompai/crm](https://github.com/trycompai/crm),
`apps/agent/lib/evidence.ts` and `apps/agent/lib/facts.ts` (MIT). We took the
mechanism, not the code.

## The problem

Any path that writes `Lead.name`, `Lead.email` or `Lead.source` today writes
what a source said, with nothing stored about why it was believed. That is fine
for a value a telecaller typed after speaking to the customer. It is not fine
for a value that arrived from a WhatsApp profile, an anonymous landing form, or
a model's reading of a message: once it is in the column, it is
indistinguishable from a verified fact. The next person to open the lead cannot
tell "the customer confirmed this" from "somebody guessed".

A confidently wrong phone number or name is worse than a blank one, because
nobody downstream knows to check it.

## The model

`LeadFact` stores the observation, the evidence that priced it, and the
decision, as three separate things:

| Column | Meaning |
| --- | --- |
| `field` | which Lead column the observation is about (`name`, `email`, `source`) |
| `value` | what the source said, verbatim |
| `evidence` | one entry per independent source: `{ kind, detail, sourceUrl? }` |
| `score`, `band` | priced by the server, never supplied by the caller |
| `method` | who observed it (`whatsapp.profile-name`, `enquiry-form`, ...) |
| `status` | `PROPOSED` (waiting on a rep), `APPLIED` (on the record), `DISMISSED`, `SUPERSEDED` |

A `PROPOSED` row is a suggestion shown under the field. `APPLIED` means the
column was written from it. `SUPERSEDED` is history: only one `APPLIED` row per
field per lead is ever live.

## Field mapping

Comp AI's ten fields (`title`, `seniority`, `function`, `linkedinUrl`, ...) are
sales-enrichment fields that do not exist on a construction lead. Mapping them
would mean inventing columns, so the ledger starts with the three columns that
exist and can honestly be filled from a source:

| Field | Lead column | Today | Why it matters here |
| --- | --- | --- | --- |
| `name` | `name` (required) | always typed by a person at create | never overwritten automatically; a strong conflicting source becomes a suggestion, which is the only way anyone finds out the name on the lead is the WhatsApp profile name |
| `email` | `email` (nullable) | often blank | the first real win: a blank field is filled by anything that clears the floor for keeping |
| `source` | `source` (required text) | typed, or forced to `WHATSAPP` by the convert flow | low value, kept for completeness |

Deliberately excluded: `phone` and `phoneE164`. They are the identity key
(the inbound webhook resolves a lead by `phoneE164`), so a wrong phone is not a
data-quality problem, it is two customers merged. Nothing in the ledger may
write them. Adding `budget`, `requirement` or `possession` needs a product
decision about whether those become columns or a custom-field table; they are
not in this slice.

## The four rules

Enforced in `apps/backend/src/leads/lead-facts.rules.ts`, so they hold for
every caller and are testable without a database.

1. **Never store what is not really known.** Below the floor for keeping
   (score under 0.30) the claim is refused and not written at all.
2. **Never overwrite what a person typed.** A value on the record with no
   `APPLIED` fact behind it outranks any automatic write. A strong conflicting
   source (`PROBABLE` or better) is offered as a suggestion instead, because
   "the record says X, a source says Y" is information the rep should have.
3. **Never re-offer a dismissal.** A value a person dismissed is refused at the
   write path, not deduplicated on read, so dismissing is permanent.
4. **Never offer a rep the value already in the field.** Comparison is by
   `canonicalValue` (case, whitespace, URL scheme, `www.`, trailing slash,
   query string, `twitter.com` as `x.com`), so the suggestion sheet cannot
   offer back something that is already there.

## Evidence kinds and weights

| Kind | Weight | Primary | Reads as |
| --- | --- | --- | --- |
| `lead.reply-from-number` | 0.90 | yes | they replied from this number on a thread we hold |
| `enquiry.form-email` | 0.90 | yes | the enquiry form itself carried this address |
| `booking.contact-match` | 0.85 | yes | a booking exists under this name and number |
| `site-visit.signin` | 0.75 | yes | they signed in at a site visit |
| `call.note-mentions` | 0.55 | no | a telecaller's note says so |
| `whatsapp.message-mentions` | 0.45 | no | their own message says so |
| `whatsapp.profile-name` | 0.40 | no | their WhatsApp profile name says so |
| `handle.name-form` | 0.25 | no | the handle is a form of the name |
| `contradiction` | 0.00 | no | another source disagrees |

Bands: `VERIFIED` at 0.85 with at least one primary source, `PROBABLE` at 0.55,
`POSSIBLE` at 0.30. Independent sources combine multiplicatively
(`1 - product(1 - w)`), so two weak observations cannot add up to certainty.

`handle.name-form` sits below the floor on purpose: `github.com/ramesh` is a
form of every Ramesh's name, so alone it is never worth storing.

## Two deliberate differences from the source pattern

1. **A contradiction holds the fact completely.** Comp AI caps a contradicted
   claim at 0.45, which still clears their `POSSIBLE` floor and so lets it fill
   a blank field. Here the cap is 0.20, below the floor, so "held" means held.
2. **A strong source may propose against a human value.** Comp AI refuses
   outright when a person owns the field. That is right for optional
   enrichment on 400 contacts. Here the fields are identity fields on a lead,
   the volume is one suggestion per lead at most, and the conflict is the
   product: a lead named "Ramesh" with a thread signed "Ramesh Kumar" is
   exactly what someone should be told. Weakening evidence still gets refused.

## What today's intake does that this fixes

1. **`LeadsService.update` records the change but not its provenance.** The
   audit row says `name` went from A to B; it cannot say whether B came from a
   call or from a guess. After this slice, a ledger-written change carries its
   method and band in the audit `reason`.
2. **A value typed from a WhatsApp thread is indistinguishable from one typed
   after a call.** `WhatsappUnknownContact` has no profile-name column at all
   (`phoneE164`, `firstMessageBody`, `notes`), so the only name that reaches a
   Lead is the one the telecaller typed. That is safe today, and it is why the
   first producer for this ledger should be the enquiry form rather than
   WhatsApp.
3. **Nothing can express "the record says X, a source says Y".** Every write
   path either writes or refuses. `PROPOSED` is the missing third option.

## What this change does and does not do

Does: the table, its GRANTs and RLS policies in one migration; the pure
evidence and rules modules with tests; `LeadFactsService` as the only write
path; `GET/POST /leads/:leadId/facts` and `PATCH /leads/:leadId/facts/:factId`;
friendly labels and a badge variant for the two new enums; an RLS matrix block
covering every role, including ENGINEER being denied.

Does not: wire any producer. No intake path calls `record()` yet, so behaviour
in production is unchanged until the next slice. That is deliberate: the write
path and its guards land first, reviewed, with nothing flowing through it.

## Next slice

1. `public-leads`: record `enquiry.form-email` evidence for the email on a
   landing-form submission instead of writing the column directly.
2. `leads` detail sheet: render `facts` under each field with its band, the
   rationale sentence, and accept/dismiss.
3. Only then consider a model-derived producer, and only through `record()`,
   which cannot exceed `POSSIBLE` without a primary source.
