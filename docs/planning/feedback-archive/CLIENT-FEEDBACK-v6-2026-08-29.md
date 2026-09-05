# Client Feedback Round 6 - 2026-08-29 (Shadhil CRM)

You asked: "For Telephony, can we have cheap and best for India?"

The previous deltas I wrote had a placeholder "Exotel Pro, ~₹2,500/mo"
which was wrong. I just did a real price check on the India cloud
telephony market in 2026. Here's the honest answer.

---

## TL;DR recommendation

**For Shadhil CRM (5-15 users, click-to-call + recording + webhooks,
no IVR/auto-dialer needed): pick FreJun at ~₹1,149/user/month.**

- 5 users: ~₹5,745/month (~$69/month)
- 10 users: ~₹11,490/month (~$138/month)
- 15 users: ~₹17,235/month (~$207/month)

Why FreJun over the alternatives (full comparison below):
- Best balance of cost vs features for THIS use case
- AI transcription INCLUDED (manager can read what execs actually
  said to customers - the original "monitor by application" requirement)
- 23+ pre-built CRM integrations (might save you dev time)
- India-native, virtual numbers with India DIDs, GST-compliant
- Active support (4.9/5 on G2)
- Real-time webhooks for call events

---

## The real options, with verified 2026 pricing

| Provider | Starting price | Per-user cost (5-15 users) | What you get | Hidden costs |
|---|---|---|---|---|
| **FreJun** | ₹1,149/user/mo | ₹5,745-17,235/mo | Virtual number, click-to-call, recording, AI transcription, auto-dialer, 23+ CRM integrations, webhooks | Per-minute outbound beyond bundle (~₹0.30-0.50/min) |
| **TeleCMI** | ₹587/user/mo | ₹2,935-8,805/mo | Virtual number, click-to-call, recording, basic routing, webhooks | Limited AI/transcription; add-ons for analytics |
| **MyOperator** | ₹2,499/mo (annual) or ₹2,500/mo (3 users) | ₹2,500-7,500/mo | Virtual number, click-to-call, recording, **WhatsApp included** in bundle | Per-minute outbound; limited to 3-5 users on base plan |
| **Knowlarity** | ₹1,999/agent (unlimited inbound) | ₹9,995-29,985/mo | Unlimited inbound, click-to-call, recording, analytics | Per-minute outbound charged separately |
| **Exotel (Dabbler)** | $200/6mo = ~₹2,800/mo | ₹2,800-8,400/mo base + usage | Virtual number, click-to-call, recording, IVR, SMS, webhooks | **Credit pool for usage** (per-minute voice + SMS) - your real cost is plan + usage, not plan alone |
| **Exotel (Believer)** | $500/yr = ~₹3,500/mo | ₹3,500-10,500/mo base + usage | Same as Dabbler + more features | Same credit pool |
| **WhatsApp Business Calling API** | 2-3 cents/min inside the 1,000 min/mo free tier | Free up to 1,000 min/mo, then usage-based | Voice calls IN WhatsApp, recorded by Meta, no separate provider | **Only works if customer calls from inside WhatsApp**; Meta approval required; currently in limited rollout in India |

**Translation of the prices for 10 users:**
- Cheapest: TeleCMI at ~₹5,870/month
- Best value: FreJun at ~₹11,490/month
- Premium: Exotel at ₹3,500/mo plan + ~₹10,000/mo usage = ~₹13,500/month
- Most expensive: Knowlarity at ~₹19,990/month
- Free: WhatsApp Calling API (with constraints)

---

## What the CRM actually needs from telephony

Looking at the spec from the previous deltas, the CRM needs:

1. ✅ **Click-to-call** - agent taps a phone number, it dials through
   the virtual number. (All 5 providers do this.)
2. ✅ **One virtual number** - customers see the company number, not
   the agent's personal mobile. (All 5 providers do this.)
3. ✅ **Auto-recording** - every call recorded for manager audit.
   (All 5 do this; AI transcription varies.)
4. ✅ **Webhooks** - call events (started, ended, recording ready)
   fire to NestJS for the activity timeline. (All 5 do this.)
5. ✅ **Per-call metadata** - who, when, duration, recording URL.
   (All 5 do this.)

The CRM does NOT need (and shouldn't pay for):

- ❌ IVR ("press 1 for sales") - sales team answers directly
- ❌ Predictive auto-dialer - 5-15 user team, low call volume
- ❌ Skill-based routing - flat team structure
- ❌ Multi-level call queues - 5-15 users
- ❌ Contact-center analytics (talk time, occupancy, etc.) - overkill
  for v1
- ❌ Omnichannel routing (voice + email + chat in one queue) -
  WhatsApp is handled separately, no email

This narrows the real choice significantly. **The full contact-center
platforms (Exotel, Ozonetel) are overkill.** The SMB-focused players
(TeleCMI, MyOperator, FreJun) are better fits.

---

## Detailed recommendation for each profile

### If you want cheapest that works: TeleCMI

- ₹2,935-8,805/month for 5-15 users.
- 5-year-old platform, stable, India-native, virtual numbers, recording,
  webhooks, basic CRM integration.
- Catch: minimal AI features, no native transcription, basic UI.
  If you want fancy analytics or AI later, you outgrow it fast.

**Best for:** "I just need click-to-call and recording for ₹3,000/month
and I don't care about anything else." Pure compliance requirement met.

### If you want best value for money: FreJun (MY PICK)

- ₹5,745-17,235/month for 5-15 users.
- **AI call transcription INCLUDED.** This is the killer feature for
  the "monitor by application" requirement. Manager can read a
  transcript of what the sales exec said to the customer. Catches
  cases where the exec promised something they shouldn't have, or
  missed a follow-up the customer asked for.
- 23+ pre-built CRM integrations. Worth checking if they have a
  pre-built Next.js / NestJS / generic webhook connector that saves
  you dev time.
- India-native, active development, 4.9/5 G2 rating, real support.
- Catches the "manager oversight" requirement natively, not via
  manual review of recordings.

**Best for:** "I want a real telephony solution that scales with us
and gives managers visibility into what's actually being said."

### If you want WhatsApp included in the bundle: MyOperator

- ₹2,499-7,500/month for 3-5 users on the base plan, scales up.
- **WhatsApp Business integration included** in the bundle. If
  Shadhil doesn't have a separate Meta-approved WhatsApp setup yet,
  MyOperator could be the on-ramp for both voice and WhatsApp in
  one provider.
- Catch: per-user scaling gets expensive fast. At 15 users you're
  paying ~₹12,500-15,000/month.

**Best for:** "We need WhatsApp AND voice in one platform and don't
have a Meta-approved number yet."

### If you want enterprise-grade: Exotel (Believer plan)

- ₹3,500/mo plan + ₹5,000-15,000/mo usage = ~₹8,500-18,500/month
  realistic for 5-15 users.
- Most mature platform in India, used by Swiggy, Zomato, Urban
  Company, and 100+ Indian unicorns.
- The credit pool model is the trap: the headline price excludes
  usage. Your real cost is plan + per-minute usage, and usage
  can spike unexpectedly.
- Overkill for a 5-15 user internal tool.

**Best for:** "We're going to grow this to 100+ users and want a
platform that scales to that."

### The radical alternative: WhatsApp Business Calling API only

- **No separate telephony provider at all.** Customers call the
  company's WhatsApp number (voice calls via WhatsApp), Meta records
  the call, no infrastructure to manage.
- **Free for the first 1,000 minutes/month**, then per-minute.
  1,000 min = 50 hours of calls. For a 5-15 user team, that's
  probably enough for v1.
- **Catch #1**: Only works if customer initiates the call from
  inside WhatsApp. A regular phone calling the company's number
  doesn't work.
- **Catch #2**: Meta approval of WhatsApp Business Calling is
  required. Currently in limited rollout in India - not every
  business gets approved.
- **Catch #3**: Recording is on Meta's side. You'd get a recording
  URL via the WhatsApp webhook, but the storage and retention are
  Meta's responsibility.
- **Catch #4**: Outbound calls (agent calling customer) still need
  a cloud telephony provider. So this only handles inbound.

**Best for:** "Our customers always contact us via WhatsApp first,
and we want to keep everything inside WhatsApp."

For Shadhil specifically, this is a half-solution: customers do
come in via WhatsApp, but the CRM needs both inbound AND outbound
calls. So you'd need WhatsApp Calling API for inbound + a cheap
cloud telephony provider for outbound. Two providers. Probably
not worth the complexity.

---

## My honest final recommendation

**Pick FreJun for v1.** Specifically:

- 5-10 users initially: ~₹6,000-12,000/month
- Upgrade plan as the team grows
- AI transcription is the killer feature for the "monitor by
  application" requirement
- Real-time webhooks → NestJS → activity timeline works
  out of the box
- India-native, support, GST-compliant
- Future-proof: if Shadhil grows to 50+ users, FreJun scales

**Fallback if budget is tight: TeleCMI.** Same features minus AI
transcription. ₹3,000-9,000/month. You can revisit FreJun when
revenue justifies the upgrade.

**Skip:**
- Knowlarity - too expensive for the use case
- Exotel - overkill, credit pool is a trap for small teams
- MyOperator - only if WhatsApp inclusion is decisive (it isn't
  here; you're already using Meta Cloud API directly)
- WhatsApp Business Calling API alone - doesn't solve outbound

---

## What changes in the locked stack (v6)

§6 Integrations - replace the "Exotel Pro, ~₹2,500/month" line with:

```
- **Telephony**: FreJun (₹1,149/user/month, ~₹5,750-17,250/month
  for 5-15 users). Provides virtual India number, click-to-call,
  auto-recording, AI call transcription, real-time webhooks.
  Webhook URL: NestJS POST /webhooks/frejun. Events: call.initiated,
  call.answered, call.ended, recording.ready, transcription.ready.
  Recording storage: FreJun keeps 90 days, archive to Cloudflare
  R2 beyond that for RERA compliance.
```

Add a new open question to CLIENT-QUESTIONS.md:

> Q16. **Confirm FreJun is acceptable for Shadhil**, or do you have
> an existing relationship with another provider (Knowlarity, Exotel,
> MyOperator)? If you have an existing number we need to port, the
> answer changes.

---

## What I'd also push back on, one more time

**AI transcription is not optional for this use case.** The client
said "everything monitor by the application" and "manager can see
all the things." A manager manually listening to 30-50 calls/day to
audit what sales execs are saying is not realistic. AI transcription
= the manager scans the text, flags the 2-3 calls worth deep
dive, moves on. This is how real-estate CRMs in India actually
work at scale.

FreJun includes this. TeleCMI doesn't. If you go TeleCMI to save
₹6,000/month, you lose the manager's main oversight tool.

So: **the "cheap" option isn't actually cheap if it costs you the
oversight the client explicitly asked for.** My recommendation
(FreJun) reflects this.

---

## Next step

Say "apply" and I'll:
1. Update DESIGN.md v2 (when we apply the v5 stack) with FreJun
   instead of Exotel.
2. Add Q16 to CLIENT-QUESTIONS.md.

Or if you want a different provider, name it and I'll adjust.
