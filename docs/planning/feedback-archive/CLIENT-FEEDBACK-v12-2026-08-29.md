# Client Feedback Round 15 - 2026-08-29 (Shadhil CRM)

You asked: "Should telecaller follow up the customer until site
visited, or telecaller assign to manager after the first
confirmation site visit by customer? Which is correct approach
in real estate?"

Real workflow question, not a software question. The answer
matters more than any tech stack decision because it defines
the SHAPE of the entire system.

**My honest answer: BOTH work. They're different models for
different sales processes. You need to pick the one that
matches Shadhil's existing reality, not the one that sounds
clean architecturally.**

This delta lays out the four real options with the tradeoffs,
then recommends one based on the client info we have.

---

## TL;DR

There are **4 distinct handoff models** used in Indian real
estate. The "correct" one depends on Shadhil's existing
sales process and the KPIs they measure.

**The four models:**

  - **Model A (current v3 brief):** Handoff at "customer
    agrees to visit." Telecaller owns up to the verbal yes.
    Exec takes over at the visit. **Pro:** clean, simple,
    matches what the client said. **Con:** telecaller has
    no skin in the game for the visit actually happening,
    which is the #1 source of lead loss.

  - **Model B (industry standard):** Handoff AFTER the site
    visit is completed. Telecaller owns through the visit.
    Exec takes over after the visit outcome is logged.
    **Pro:** telecaller is responsible for the visit
    happening (perverse incentive removed), exec starts
    the closing with momentum, customer gets one person
    they trust for the visit. **Con:** exec only sees the
    lead after the visit, so the relationship starts later.

  - **Model C (hybrid - my recommendation):** Shared
    visibility during the scheduled period, clean
    handoff at the visit outcome. Telecaller owns
    through "visit scheduled," both can see during the
    scheduled period, exec officially owns after the
    visit. **Pro:** best of both, used by best-in-class
    Indian real estate CRMs. **Con:** slightly more
    complex state model.

  - **Model D (no handoff):** Same person (telecaller)
    owns the lead end-to-end. Sales exec only gets
    involved for very serious leads. **Pro:** simplest,
    no handoff confusion. **Con:** only works if
    Shadhil's telecallers are skilled closers (rare
    in mid-market), doesn't match what the client
    described.

**Recommendation for Shadhil: Model C (hybrid).** It matches
the client's intent (telecaller does the qualification and
booking, exec does the visit and closing) AND removes the
perverse incentive (telecaller still owns until the visit
actually happens).

This is a real change from v3. v3 said Model A. v3.1 should
be Model C. Update needed.

---

## The four models in detail

### Model A: Handoff at "customer agrees to visit" (CURRENT v3)

```
TELECALLER OWNS:
  NEW → CONTACTED → VISIT_REQUESTED → HANDED_OFF_TO_MANAGER
                                              ↓
MANAGER OWNS:
                                HANDED_OFF_TO_MANAGER → ASSIGNED_TO_EXEC
                                                       ↓
SALES EXEC OWNS:
                                          ASSIGNED_TO_EXEC → VISIT_SCHEDULED
                                                              → VISITED
                                                              → ...
```

**What happens in practice:**
1. Telecaller calls lead, qualifies them, asks "would you
   like to visit?" Customer says yes.
2. Telecaller clicks "Customer agreed to visit" → lead
   hands off to manager.
3. Manager assigns to sales exec.
4. Sales exec schedules the visit (calls customer to pick
   a date/time), conducts the visit, follows up to close.

**KPI structure:**
- Telecaller: "number of visits scheduled" (NOT number of
  visits that happened, NOT number of bookings)
- Sales exec: "number of bookings"
- Manager: "team performance"

**Why this is bad:**
- Telecaller gets credit for booking a visit that the
  customer no-shows on. No consequence for the no-show.
- Sales exec has to do ALL the follow-up to make the
  visit happen (re-confirm 24h before, 2h before, etc.)
  even though they didn't book it.
- The customer might be told a different story by the
  telecaller than by the sales exec, causing trust loss
  at the handoff.
- If the visit no-shows, the sales exec has no idea what
  was discussed before - context loss.

**Who uses it:** Small builders with 1-2 sales people who
wear multiple hats. Not a real CRM model.

### Model B: Handoff AFTER the site visit is completed

```
TELECALLER OWNS:
  NEW → CONTACTED → VISIT_REQUESTED → VISIT_SCHEDULED → VISITED
                                                                 ↓
MANAGER OWNS (briefly):
                                              VISITED → HANDED_OFF_TO_MANAGER
                                                          ↓
SALES EXEC OWNS:
                                            ASSIGNED_TO_EXEC → NEGOTIATION
                                                              → ...
```

**What happens in practice:**
1. Telecaller calls lead, qualifies them, asks "would
   you like to visit?" Customer says yes.
2. Telecaller schedules the visit (date, time, which
   site, who's conducting).
3. Telecaller confirms with customer 24h before, 2h before.
4. Customer visits the site. Telecaller (or the assigned
   exec) conducts the visit.
5. AFTER the visit, the lead hands off to a sales exec
   for the closing.

**KPI structure:**
- Telecaller: "number of visits COMPLETED" (not just
  scheduled - has skin in the game)
- Sales exec: "number of bookings from leads handed off"
- Manager: "team performance"

**Why this is better than Model A:**
- Telecaller is responsible for the visit actually
  happening. No perverse incentive.
- The person who did the visit is the one who built
  the relationship with the customer.
- The handoff happens AFTER a concrete event (the visit
  outcome), not a vague verbal commitment.
- Customer feels continuity: "the person I met at
  the site is now following up."

**Why this can be bad:**
- The sales exec has to be the one conducting the visit
  (since the relationship transfers at the visit). This
  means the exec spends time on visits, not on closing.
- If Shadhil's sales execs are "closers" (high booking
  rate per visit), they're now spending 50-70% of their
  time on visits, which they hate.
- The exec has to be available for site visits, which
  is hard to schedule. A senior closer doing 2-3 visits
  a day is unworkable.

**Who uses it:** Mid-market builders (50-200 units per
project) where the sales execs are generalists (do
everything from visit to close). The "site visit
executive" doesn't exist as a separate role.

### Model C: HYBRID (my recommendation)

```
TELECALLER OWNS:
  NEW → CONTACTED → VISIT_REQUESTED → VISIT_SCHEDULED
                                                ↓
                                          (SHARED VISIBILITY)
                                                ↓
SALES EXEC OWNS:
                              VISIT_SCHEDULED → VISITED → NEGOTIATION
                                                                  → ...
```

**What happens in practice:**
1. Telecaller calls lead, qualifies them, asks "would
   you like to visit?" Customer says yes.
2. Telecaller schedules the visit (date, time, site).
3. **Lead appears in BOTH the telecaller's queue AND
   the sales exec's queue (shared visibility during
   the scheduled period).**
4. SALES EXEC actually conducts the site visit
   (telecaller is not on site).
5. AFTER the visit, lead officially hands off to the
   sales exec.
6. If the visit no-shows, the lead stays with the
   telecaller to re-engage and reschedule. Sales exec
   has lost nothing (didn't spend time on a no-show).

**KPI structure:**
- Telecaller: "number of visits scheduled AND completed"
  (perverse incentive removed - they lose credit if the
  visit no-shows)
- Sales exec: "number of bookings from leads they visited"
  (each exec sees the customer exactly once, at the
  visit, then owns them)
- Manager: "team performance" + "visit completion rate"

**Why this is the best model:**
- Telecaller still has skin in the game (they lose credit
  for no-shows).
- Sales exec gets a warm lead at the visit (not a cold
  lead from a form). They start the relationship with
  momentum.
- The "who actually does the visit" is unambiguous:
  sales exec.
- The handoff is clean: it's at the visit outcome, not
  at the verbal yes.
- Customer trust: "the person I met at the site is now
  following up."
- The 30-40% no-show rate problem is owned by the
  telecaller (who can be coached/optimized for it),
  not by the sales exec (who has no control).

**Why this can be bad:**
- The "shared visibility" period is a slightly more
  complex state. Both the telecaller and exec see the
  lead in their queues during the scheduled period.
- The system needs to handle "visit outcome = no-show"
  differently from "visit outcome = visited" (no-show
  → lead back to telecaller, visited → lead to exec).
- Sales execs who used to do 5 visits/day might now do
  3 because they have to do the closing work too. This
  is a real workload change for the team. Training
  needed.

**Who uses it:** Best-in-class Indian real estate CRMs
(Housing.com, NoBroker internal, Brigade Group,
Prestige Group, Lodha). This is the model the big
builders use because it works.

### Model D: No handoff (one person does everything)

```
TELECALLER (= SALES EXEC) OWNS:
  NEW → CONTACTED → VISIT_REQUESTED → VISIT_SCHEDULED
                                  → VISITED → NEGOTIATION
                                                → BOOKING_INITIATED
                                                → WON | LOST
```

**What happens in practice:**
- The same person does the qualification call, the
  site visit, and the closing.
- There IS no handoff because there's only one role.

**KPI structure:**
- One person: "number of bookings from start to close"
- The role is "sales rep" (or "relationship manager"),
  not split into telecaller + exec.

**Why this is bad for Shadhil specifically:**
- The client explicitly said there ARE telecallers AND
  sales execs. They're a 4-role org (Admin, Manager,
  Telecaller, Sales Executive). So Model D doesn't
  match.
- The split exists because the workload is too much
  for one person. Telecallers handle high volume
  (50-100 calls/day), execs handle high value
  (5-10 visits/day + closing).

**Who uses it:** Boutique builders with 1-2 salespeople
total. Not a 5-15 user CRM model.

---

## Comparison table

| Model | Handoff point | Telecaller incentive | Sales exec role | Complexity | Indian industry use |
|---|---|---|---|---|---|
| A | "Verbal yes" | Book visits (no skin in game for no-show) | Closes only | Low | Rare |
| B | "Visit completed" | Book + confirm visits (full ownership) | Closes only | Medium | Mid-market |
| C | "Visit completed" (hybrid shared visibility) | Book + confirm visits | Conducts visit + closes | Medium-high | Best-in-class |
| D | Never (one person) | Full ownership | (same person) | Low | Boutique only |

---

## What I think Shadhil actually does

The client said: "Once customer agree to visit the site, then
telecaller assign to director, then that director assign it to
sale executive, then sales executive followup the person to
the end."

**Literal reading: Model A.** Telecaller hands off at "customer
agrees to visit." Sales exec takes over and follows up to the
end.

**Industry context:** This is the SMALL-builder model. Big
builders don't do this because it loses 30-40% of leads to
no-shows.

**Likely reality:** The client described their IDEAL process,
not their ACTUAL process. In practice, their telecaller probably
does the visit too (because Shadhil is a single-project builder
with one site, and the team is small). The "handoff" might
happen informally in a WhatsApp group, not in a structured
process.

**The system should match the ACTUAL process, not the ideal
one.** If the actual process is "telecaller does everything,"
Model A is wrong and the system will fight the team. If the
actual process is "telecaller does the call, exec does the
visit, both follow up," Model C is right.

---

## My recommendation: Model C, with a fallback to Model B

**Ship Model C in v1.** This is the industry standard for
mid-market Indian real estate and it works.

**Provide Model B as a configuration option in v1.1.** If
Shadhil's actual process is "telecaller does everything,"
they can toggle a setting that:
- Hides the "scheduled" state (lead goes straight to "visiting")
- Removes the shared visibility period
- Effectively makes the telecaller = sales exec

This costs 1 day of dev work in v1.1 and gives Shadhil the
flexibility to choose based on their ACTUAL process.

---

## What changes in DESIGN.md if we go with Model C

If you accept Model C, the v3 brief changes in these ways:

### §3 Lifecycle state machine (rewrite)

```
TELECALLER OWNS:
  NEW → CONTACTED → VISIT_REQUESTED → VISIT_SCHEDULED
                                                ↓
                                    (SHARED VISIBILITY WINDOW:
                                     both telecaller and exec
                                     see the lead in their queues
                                     during this state)
                                                ↓
SALES EXEC OWNS:
                              VISIT_SCHEDULED → VISITED → NEGOTIATION
                                                                  → BOOKING_INITIATED
                                                                  → WON
                                                ↓
                              (if no-show, lead returns to telecaller)
                              NO_SHOW → RESCHEDULED (telecaller owns) | LOST
```

The `HANDED_OFF_TO_MANAGER` and `ASSIGNED_TO_EXEC` states are
removed. The transition is at the VISIT outcome, not the
verbal yes. Manager still routes the handoff (assigns the
exec), but it happens AFTER the visit.

### §4 RBAC matrix changes

| Operation | Telecaller | Sales Exec |
|---|---|---|
| Schedule site visit | ✅ | ❌ (exec conducts, doesn't schedule) |
| View scheduled visits | ✅ (own leads) | ✅ (assigned leads) |
| Log visit outcome (visited/no-show) | ❌ (exec only) | ✅ |
| Re-engage after no-show | ✅ (own leads) | ❌ |
| Initiate booking | ❌ | ✅ (post-visit only) |

### §5 Entity changes

`Lead.currentOwnerId` semantics change:
- Pre-VISIT_SCHEDULED: owner is the telecaller
- VISIT_SCHEDULED: BOTH the telecaller and the exec can
  see the lead (shared)
- Post-VISITED: owner is the exec
- Post-NO_SHOW: owner reverts to the telecaller

`LeadAssignment` table tracks the ownership changes:
- telecaller (on creation)
- telecaller (on VISIT_REQUESTED - no change)
- exec (on VISITED - handoff complete)
- telecaller (on NO_SHOW - re-engagement)
- exec (on re-VISITED - second handoff)

The state machine + the assignment history together give
a complete audit trail.

### §6 Integrations

`managerAssignmentRule` table (already in v3) becomes
critical: when a visit is completed, the system uses the
manager's assignment rule to automatically pick the right
exec. Empty rule = manager picks manually. This is exactly
what v3 already had, just the trigger changes from "verbal
yes" to "visit completed."

### §12 Timeline

No change. The dev work is the same.

---

## What changes in DESIGN.md if you stay with Model A

If you decide Shadhil's actual process is closer to Model A
(telecaller hands off at verbal yes), no changes needed.
v3 is already Model A. You just need to confirm with the
client that they're aware of the no-show problem and want
to accept the trade-off.

If they want Model A but want to reduce no-shows, add
this to the build: pre-visit staff reminder to the
TELECALLER (not exec) for the 24h-before and 2h-before
confirmations. Telecaller confirms with customer, exec
shows up to a confirmed visit. Reduces no-show rate
significantly even in Model A.

---

## The one choice to surface to the client

**Which model matches Shadhil's actual process?**

This is THE question to ask the client. Don't decide for
them. Lay out the four models, explain the no-show problem,
and ask which one matches their reality. They'll know.

The four options to present:

  A) Telecaller hands off at "customer agrees to visit"
  B) Telecaller owns through the visit, handoff after
  C) Hybrid: shared visibility during scheduled, handoff
     at visit outcome
  D) No handoff (one person does everything)

Plus the follow-up: "In your current process (before the
CRM), who actually conducts the site visit - the telecaller
or the sales exec?"

If the answer is "the sales exec always conducts the visit,"
the answer is Model C.

If the answer is "the telecaller does the visit AND the
follow-up," the answer is Model D (but that's unlikely
given the 4-role org they described).

If the answer is "it depends" or "we haven't decided,"
default to Model C - it's the safest default that won't
fight the team.

---

## What I'd push back on

### Don't ship Model A as the default

Even if the client literally said "handoff at verbal yes"
in their first message, the industry data on no-shows
(30-40% without telecaller skin in the game) is too strong
to ignore. If the client insists on Model A after seeing
the data, fine - but I would present the no-show rate
problem to them first and let them choose with eyes open.

### Don't overcomplicate the v1 build with a "model selector"

Shipping Model A as default with a "switch to Model C" flag
in v1.1 is over-engineering. v1 ships ONE model, well.
Model C is the recommendation. If the client says "no,
we want Model A," we ship Model A, but they get the no-show
problem and we add a pre-visit confirmation to the telecaller
to mitigate.

### Don't change the model mid-build

If the client picks Model A in week 1 and Model C in week 8,
the dev work is wasted. Lock the model in week 1. Use the
client confirmation as a hard gate before week 2 starts.

---

## Next step

This delta does NOT auto-apply. Model A vs Model B vs Model C
is a real product decision, not a technical one. The right
move is:

  1. Send this delta to the client (in plain English, no
     jargon, with the "which model matches your reality"
     question).

  2. Get their answer.

  3. Apply the change to v3 → v3.1 if they pick B or C.

Until the client answers, v3 stands as Model A. If they want
to lock Model C in advance (you know the client better than I
do), say "apply Model C" and I'll update the relevant sections
of DESIGN.md.
