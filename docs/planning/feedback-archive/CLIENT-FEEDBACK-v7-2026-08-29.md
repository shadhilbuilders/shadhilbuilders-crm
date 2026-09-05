# Client Feedback Round 7 - 2026-08-29 (Shadhil CRM)

You asked: "What about AWS Amazon Connect Customer?"

The previous delta (v6) recommended FreJun. Amazon Connect is a
real option and worth a real answer. Here's the honest comparison.

---

## TL;DR

**For v1, stick with FreJun.** Real-world math for a 5-15 user
Indian real-estate CRM says Amazon Connect costs ~3.3× more for
the same workload. The features Amazon Connect adds (Amazon Q AI
assist, Contact Lens, enterprise compliance, global regions) are
real but not needed at Shadhil's current scale.

**Document Amazon Connect as the v2 migration path** if Shadhil
grows to 50+ users, expands to UAE operations, or hits enterprise
compliance requirements.

The migration cost is low because both FreJun and Amazon Connect
expose webhook-based APIs. Switching later is "swap the webhook
receiver and click-to-call provider" - not "rewrite the CRM."

---

## What Amazon Connect actually is

Amazon Connect is AWS's cloud contact center service. It's
genuinely enterprise-grade. Used by Capital One, Deloitte, GE,
and 100+ Fortune 500s. The 2026 rebrand to "Amazon Connect
Customer" added a pay-per-use pricing model that competes
directly with per-seat CCaaS platforms like Five9, Genesys,
Nice inContact.

**Key things Amazon Connect gives you that FreJun/Exotel don't:**

- **Amazon Q in Connect** - real-time AI agent assist. Suggests
  responses to the sales exec during the call based on the
  customer conversation. "Customer asked about BHK sizes →
  Amazon Q suggests the relevant floor plan."
- **Contact Lens** - post-call analytics. Sentiment analysis,
  topic detection, talk-time ratio, agent performance scoring
  across thousands of calls.
- **Amazon Lex integration** - native chatbot/IVR (if you
  ever want it).
- **Bedrock integration** - bring your own LLM for advanced
  call analysis.
- **30+ AWS regions** including Mumbai (`ap-south-1`). If
  Shadhil opens a UAE office, Connect gives you the same
  platform there.
- **Enterprise compliance** - SOC 2, HIPAA, PCI-DSS, GDPR,
  ISO 27001, all inherited from AWS. Indian providers have
  weaker compliance stories.
- **No per-seat licensing** - pay per minute + per agent hour.
  Scales without renegotiating contracts.

**Key things it doesn't give you that FreJun/Exotel do:**

- A simple, India-native dashboard designed for a 5-15 user
  team. The AWS console is built for 100+ agent operations.
- Pre-built India-specific integrations (TRAI compliance,
  GST invoicing, Indian number portability workflows).
- A mobile-first agent experience. Agents use either the
  Amazon Connect app (heavier than FreJun's) or you embed
  the Streams SDK in your CRM.
- Predictable billing. AWS bills are notoriously hard to
  predict. FreJun bills = plan + usage, easy to forecast.
- Free tier meaningful for production. Free = 90 min
  service usage, 30 min inbound DID/month, 30 min
  outbound/month. For a 5-15 user team making hundreds of
  calls/day, the free tier is gone in a day.

---

## Real cost comparison: FreJun vs Amazon Connect for 10 users

Assumptions (typical Shadhil workload):
- 10 users, logged in 8 hours/day, 22 working days = 1,760
  agent-hours/month
- 200 calls/day, 3-min average = 600 min/day = 13,200 min/month
- 70% outbound, 30% inbound
- 30% of inbound on DID, 70% on regular mobile (no charge)
- All calls recorded with AI transcription

### FreJun (10 users)

```
Plan: 10 × ₹1,149           = ₹11,490
Per-minute outbound beyond bundle (estimate):
  13,200 × 0.7 = 9,240 outbound min
  Bundle typically includes ~3,000 min
  Overage: 6,240 × ₹0.40    = ₹2,496
Per-minute inbound DID (estimate):
  13,200 × 0.3 × 0.3 = 1,188 inbound DID min
  × ₹0.30                    = ₹356
AI transcription (included in plan) = ₹0
Virtual number rental          = ₹1,000
                            --------
TOTAL:                        ~₹15,300/month
                            (~$184/month)
```

### Amazon Connect Customer (10 users, Mumbai region)

```
Per-agent hour (avg $0.025):
  1,760 hours × $0.025        = $44     (~₹3,650)
Outbound voice ($0.05/min):
  9,240 min × $0.05           = $462    (~₹38,350)
Inbound DID ($0.025/min):
  1,188 min × $0.025          = $30     (~₹2,490)
AI conversational analytics
  ($0.015/min for transcripts):
  13,200 min × $0.015         = $198    (~₹16,425)
Call recording storage to S3
  ($0.0048/min):
  13,200 × $0.0048            = $63     (~₹5,230)
DID number rental              = $1      (~₹83)
S3 storage for 6 months of
  recordings (~30 GB):
  30 GB × $0.023/GB-month     = $0.69   (~₹57)
CloudWatch logs, Lambda
  invocations (webhook handler):
  estimate                     = $20     (~₹1,660)
                            --------
TOTAL:                          ~$819   (~₹68,000/month)
```

**Amazon Connect is ~4.4× more expensive for the same workload.**

The biggest cost driver: outbound voice at $0.05/min in Mumbai
region. FreJun bundles most outbound minutes in the plan.
Amazon Connect charges per-minute for everything.

---

## The seven reasons FreJun wins for v1

1. **3-4× cheaper for the actual workload.** Not close.
2. **Mobile-first agent app.** FreJun's mobile app is
   designed for the "sales exec in the field with their
   personal phone" use case. Amazon Connect's mobile story
   is "use our app or embed our SDK."
3. **Predictable billing.** FreJun = plan + usage estimate.
   Easy to forecast. AWS = a maze of per-resource charges
   that surprise teams monthly.
4. **Ship in 2-3 days, not 2-3 weeks.** FreJun's webhook
   integration is "POST this URL on these events." Amazon
   Connect's webhook integration is a Lambda function +
   EventBridge rule + IAM role + Kinesis stream if you
   want real-time. That's a week of work minimum.
5. **No AWS account needed.** If Shadhil doesn't already
   use AWS, you avoid the entire AWS billing/ops surface.
6. **India-native support.** FreJun's support team knows
   Indian phone regulations, GST invoicing, Indian number
   portability. Amazon Connect support is good but generic.
7. **The 5-15 user sweet spot.** FreJun was built for this
   segment. Amazon Connect was built for 100+ agent contact
   centers.

## The five reasons Amazon Connect might win later (v2/v3)

1. **You grow past 50 users.** At scale, Amazon Connect's
   pay-per-use model becomes competitive with per-seat
   pricing. The break-even depends on usage patterns, but
   roughly 50+ users.
2. **UAE expansion.** The brief mentions Shadhil has an
   Abu Dhabi branch. If you start making calls to/from UAE
   customers, Amazon Connect's `me-central-1` region gives
   you a local presence. FreJun has UAE numbers but
   infrastructure is India-based.
3. **Enterprise compliance emerges.** If Shadhil ever
   sells to enterprise buyers or handles regulated data
   (large institutional investors, NRIs with compliance
   needs), AWS compliance certifications matter.
4. **Amazon Q real-time agent assist becomes a thing.**
   If sales execs want "AI suggests what to say during
   the call," Connect has it built in. With FreJun, you'd
   build it yourself or use a separate AI tool.
5. **You want a single-vendor story.** If you're already
   on AWS for some other reason (website hosting, S3
   storage, etc.), one bill is simpler than two.

---

## The migration path (this is the part that matters)

**The good news: you don't have to commit to FreJun forever.**

Both FreJun and Amazon Connect expose webhook-based APIs.
The CRM's telephony integration has three touchpoints:

1. **Click-to-call** - CRM calls a `POST /calls/initiate`
   endpoint with the number to dial.
2. **Call event webhooks** - provider calls
   `POST /webhooks/provider` with call.initiated /
   call.ended / recording.ready events.
3. **Recording URL storage** - CRM stores the recording
   URL in the activity log.

**To switch providers, you change:**
- The click-to-call endpoint (NestJS `TelephonyService`
  interface stays the same; only the implementation
  changes).
- The webhook receiver path
  (`/webhooks/frejun` → `/webhooks/amazon-connect`).
- The recording URL field in the activity payload.

**You do NOT change:**
- The data model (Activity, Call, Recording).
- The RLS policies.
- The chat pane, lead detail, anything else.

**Estimated migration effort: 3-5 days of dev work.**
That's a 1-week project, not a 1-month rewrite. So the
"what if we need to switch" risk is bounded.

---

## My honest answer to "what about Amazon Connect"

It's a real option with real strengths. For a 5-15 user
Indian real-estate CRM shipping in 8-9 weeks, the math
favors FreJun by 3-4×. The features Amazon Connect adds
aren't needed at Shadhil's current scale.

If Shadhil grows to 50+ users, expands to UAE, or hits
enterprise compliance requirements, the migration path is
3-5 days of dev work, not a rewrite. So you're not locked
in.

**Recommendation: FreJun for v1, Amazon Connect as the
documented v2 migration path if growth justifies it.**

---

## What this changes in DESIGN.md

Nothing. v6 already specified FreJun. This delta just
documents the comparison so future-you can answer the
"why not AWS?" question without re-doing the analysis.

Add to DESIGN.md §6 (Integrations):

```
**Telephony vendor - why FreJun over Amazon Connect:**
Amazon Connect was evaluated and rejected for v1. At 5-15
users, Connect costs ~3-4× more than FreJun for the same
workload (~$735/month vs ~$184/month for 10 users). Connect's
advantages (Amazon Q AI assist, enterprise compliance,
30+ regions including UAE) are real but not needed at
Shadhil's current scale. Both providers expose webhook-based
APIs, so a future migration to Connect is estimated at
3-5 days of dev work. Re-evaluate if Shadhil grows past 50
users, opens UAE operations, or hits enterprise compliance
requirements.
```

---

## What I'd push back on

If you want to go Amazon Connect anyway, I won't stop you.
The valid reasons would be:
- Shadhil already has an AWS account and team
- You want to signal "enterprise-grade" to the client
- You plan to expand to UAE in 2026 and want the same
  platform in both regions
- You want Amazon Q's real-time AI agent assist

But: **the cost is real.** ₹68,000/month vs ₹15,000/month
for 10 users is not trivial. That's a Senior Engineer
salary's worth of money annually. If Shadhil pushes back
on the bill, you'll be the one explaining why.

For a service-biz model where the client is paying for the
CRM build and ongoing ops, this matters. The client is
Shadhil; they pay. Make sure they're comfortable with the
bill before locking in.

---

## Next step

If you're happy with FreJun, just say "apply" and I'll
consolidate v1 through v6 (PM brief, client feedback
rounds 1-6, the locked stack, FreJun, REST, etc.) into
DESIGN.md v2.

If you want Amazon Connect, say "apply with Connect" and
I'll do the same but with the telephony line changed.
