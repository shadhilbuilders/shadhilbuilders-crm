# Welcome WhatsApp template — needs creating in Meta (T-WA-WINDOW, 2026-09-29)

The "Welcome Message" button sends an **approved Meta template**. It has to be
created by a human in WhatsApp Manager — the code cannot submit it, and until it
exists every send fails with `132001 template does not exist`.

## Create it

WhatsApp Manager → Message Templates → Create template.

| field | value |
|---|---|
| Name | the value you set in `WA_TEMPLATE_WELCOME` (suggested: `shadhil_welcome_enquiry`) |
| Category | **UTILITY** — this is a transactional follow-up to the customer's own enquiry, not marketing. A MARKETING template from a test sender is accepted by the API and silently dropped (see the state file), and it also needs no re-engagement opt-in. |
| Language | `en` |
| Header | None (or a text header) |
| Body | see below |
| Footer | `Shadhil Builders & Constructions` (optional) |

## Body (one parameter)

```
🙏 Hello {{1}}, thank you for your interest in Shadhil Builders & Constructions. We would like to help you with your enquiry. Please reply to this message and our team will assist you right away.
```

Parameter order is **locked to code**: `{{1}}` = the customer's first name. The
Cloud API sends body params as an ordered array, so `templateVars` in
`sendWelcome()` is `{ '1': firstName }`. If you change the placeholder count or
order in Meta, update that mapping in the same change or every send breaks.

Rules this body satisfies (Meta rejects violations with terse errors):
- no `{{1}}` at the very start or end (it is wrapped in static text both sides)
- one variable, well under the density limit
- body under 1024 chars, footer under 60 and text-only
- no promotional language (keeps it eligible for UTILITY)

## Then set

```
WA_TEMPLATE_WELCOME=<the name you created>
```

in the backend's environment. Not a literal in code — a hardcoded name Meta has
not approved is exactly how `shadhil_chat_reply` came to be referenced in the
codebase while never existing in Meta, failing every send with `132001`.

## While it is unset

The button still renders and, when clicked, fails with a clear 400:

> The welcome template is not configured. Set WA_TEMPLATE_WELCOME to the name of
> an approved Meta template.

That is deliberate: an operator should be told exactly what is missing rather
than seeing a generic 500 or, worse, a success toast for a message that was
never delivered.

## Why this is the only cold-outreach path

Meta opens the 24-hour customer-service window **only** when the customer
messages the business ("When a WhatsApp user messages you or calls you, a 24-hour
timer called a customer service window starts"). A business-initiated template
does **not** open it, and neither does the customer merely receiving one.
So for a lead who has never replied:

- freeform text is refused by Meta (`131047 re-engagement message`) → the app now
  refuses it first, with an explanation, instead of queueing a doomed send
- an approved template **is** allowed, which is the entire purpose of the button

The reply window still opens only when they answer — the button does not unlock
the composer, and the UI says so rather than pretending otherwise.
