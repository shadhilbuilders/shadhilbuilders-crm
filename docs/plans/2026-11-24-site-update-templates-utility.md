# Site update templates: the UTILITY submission

Approved 2026-11-24 and live in production.

    shadhil_villa_update_image   id 1004663232706917   APPROVED   UTILITY   en
    shadhil_villa_update_video   id 1032885586520701   APPROVED   UTILITY   en

## Why resubmit

The first real site update was delivered on 2026-11-24 at 10:48:54Z
(`shadhil_site_update_image`, wamid `wamid.HBgMOTE5NDQ1NDUwNDEw…`). It works, and it works as a
MARKETING template. That is the problem: Meta counts MARKETING against a per-recipient allowance,
so a buyer can silently miss the update about the villa they paid for, and one send four minutes
earlier was accepted and then reported failed with no reason stored.

A site progress update for a booked villa is a transaction. The villa number is on the contract,
the buyer asked to be told how it is going, and the message carries no offer. Submitted as
UTILITY, it stops depending on a marketing allowance and stops depending on an opt-in row. The
consent row stays, because it records what the owner authorised, but delivery no longer hinges on
it.

## What the code already assumes

Do not change any of these while resubmitting. The worker and the template have to agree exactly.

    {{1}}          greeting name, or "there" when there is none
                   (site-update-greeting.ts: greetingName / NEUTRAL_GREETING)
    {{2}}          villaLabel: "A-665 (plot 37)"
    {{3}}          the engineer's note; the slot is NEVER empty, an absent note
                   becomes "Your site team has posted a new update."
                   (noteSlot in site-update-delivery.service.ts)
    button {{1}}   the ProgressPhoto id, sent as templateVars.photo
    header         IMAGE for a photo, VIDEO for an MP4 clip, minted as a public
                   link from the row's own key by OutboundService.sendOne
    language       en
    footer         Shadhil Builders

The button URL stays `https://crm.shadhilbuilders.in/portal?photo={{1}}`. The portal resolves the
photo to its unit, so a buyer who is signed out still lands on this update after the login bounce.

## Wording

The approved bodies read:

> Hello _{{1}}_, Here is your latest site update for villa _{{2}}_.
>
> _{{3}}_
>
> Open the Shadhil Builders portal to see the full record: the construction stage, every earlier update and the engineer's photos.

Three phrases fight a UTILITY classification. "Latest" frames it as news. "Every earlier update"
and "engineer's photos" are engagement nudges rather than the transaction. The rewrite names the
booking and the record, and drops the sales rhythm:

> Hello _{{1}}_, a site progress update has been recorded for villa _{{2}}_.
>
> _{{3}}_
>
> Open the record for this booking to see the stage and the photos filed with it.

Footer `Shadhil Builders`, button `View update`.

## The submission

New names, not edits. Recategorising an approved template in place is not something I have
verified for this app, and a rejected edit risks pausing a template that currently delivers. The
new names cost one environment variable each.

### Image

The payloads live in `docs/whatsapp-templates/` so they can be submitted without retyping. They are
the body of the request, not the whole request: a media header also needs a sample, and Meta only
takes that sample as an asset handle from the Resumable Upload API. A public ImageKit URL in
`example.header_handle` is refused with `2388273`, "Templates with IMAGE header type need an
example/sample". The working sequence is:

    POST /v21.0/{app_id}/uploads?file_name=…&file_length=…&file_type=image/jpeg   → {id}
    POST /v21.0/{id}   Authorization: OAuth <token>   file_offset: 0   <raw bytes> → {h}
    example.header_handle: ["4:…"]      ← the value of h

The app id here is 4114848658818773, and the two samples are the same ffmpeg test files, uploaded
public to ImageKit under `/template-samples`, because Meta fetches them while it reviews. They can
be deleted once both templates are approved.

Then the template call:

`POST https://graph.facebook.com/v21.0/1575406997723159/message_templates`

```json
{
  "name": "shadhil_villa_update_image",
  "language": "en",
  "category": "UTILITY",
  "allow_category_change": true,
  "components": [
    { "type": "HEADER", "format": "IMAGE" },
    {
      "type": "BODY",
      "text": "Hello *{{1}}*, a site progress update has been recorded for villa *{{2}}*.\n\n*{{3}}*\n\nOpen the record for this booking to see the stage and the photos filed with it.",
      "example": {
        "body_text": [["Asha", "A-665 (plot 37)", "Plinth poured on the east wing."]]
      }
    },
    { "type": "FOOTER", "text": "Shadhil Builders" },
    {
      "type": "BUTTONS",
      "buttons": [
        {
          "type": "URL",
          "text": "View update",
          "url": "https://crm.shadhilbuilders.in/portal?photo={{1}}",
          "example": ["https://crm.shadhilbuilders.in/portal?photo=cmwuknu67000c01qjjxteqszh"]
        }
      ]
    }
  ]
}
```

### Video

The same payload with three changes: `"name": "shadhil_villa_update_video"`, the header becomes
`{ "type": "HEADER", "format": "VIDEO" }` with no text, and the body example may keep the same
note.

The video template as approved carries no footer. Adding it here is deliberate: both templates
should look like the same company.

### The call

```sh
T=$(docker exec shadhil-api-0bjahklz8gtdtr4do4r7ae6m printenv WA_ACCESS_TOKEN)
curl -s -X POST \
  -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  "https://graph.facebook.com/v21.0/1575406997723159/message_templates" \
  -d @docs/whatsapp-templates/shadhil_villa_update_image.json
```

The response carries an `id` and `status: "PENDING"`, and Meta keeps `category: "UTILITY"` on it.
Review has taken minutes here before and can take a day.

## What changes once it is approved

1. Set `WA_TEMPLATE_SITE_UPDATE_IMAGE=shadhil_villa_update_image` and
   `WA_TEMPLATE_SITE_UPDATE_VIDEO=shadhil_villa_update_video` in Coolify, then redeploy the api.
   No code change: the two names are read through `IMAGE_TEMPLATE()` and `VIDEO_TEMPLATE()`.
2. Send one photo through the API and read the delivery row. It must say DELIVERED and the outbox
   row must name the new template.
3. Delete the two MARKETING templates from Meta once nothing references them. `grep` for the old
   names first, but the only reference should be the environment.

Done on 2026-11-24 at 12:18: both environment variables now name the UTILITY pair, the service was
restarted, and the container env was read back to confirm it took. Then one photo went through the
real path and delivered at 12:21:58Z:

    outbox  shadhil_villa_update_image   DELIVERED   attempts 1
    wamid   wamid.HBgMOTE5NDQ1NDUwNDEwFQIAERgSQjRDQUQxQzlDOTAxODlDNTk5AA==

The photo and its bytes were deleted afterwards, so the unit is back to the single fixture clip.

## The other two templates, and why they needed new names

`shadhil_chat_reply` (`Hi {{1}}, {{2}}. Reply here if you have any questions.`) and
`shadhil_site_visit_followup` (`Just following up on your site visit for {{2}}. Are you still
interested? Reply YES and our team will call you.`) were both MARKETING. Editing the category in
place does not work: `POST /{template_id}` with `category: UTILITY` answers `3835031`, "You cannot
update an approved template category." A category change means a new template.

Submitted 2026-11-24, both `PENDING`:

    shadhil_enquiry_reply        id 1481753927231084   PENDING   UTILITY   en
    shadhil_site_visit_checkin   id 2538260253337929   PENDING   UTILITY   en

The wording is the whole submission. A follow up that asks "are you still interested" is a sales
nudge whatever label it carries, and Meta reads the body, not the category. The check-in asks for
feedback on a visit that already happened and offers a call back; the reply names the enquiry it
answers. Both keep the original variable order, `{{1}}` the first name and `{{2}}` the free-text
slot, so a caller can swap in either without touching a line of code.

Neither template is sent by anything today: `outbound.service.ts` only whitelists the two names so
an outbox row may cite them. Approving them adds no behaviour. If they are approved, the switch is
`WA_TEMPLATE_CHAT_REPLY=shadhil_enquiry_reply` and `WA_TEMPLATE_VISIT_FOLLOWUP=shadhil_site_visit_checkin`.

## If review refuses

A UTILITY rejection names the reason on the template. The usual complaint is that the body is
promotional or generic. The fix is wording, not a second submission of the same text: repeated
identical submissions count against the account. If UTILITY is refused twice, keep MARKETING and
accept that a per-recipient cap can hold a message back, which is what the delivery row and the
`errorCode` now make visible.
