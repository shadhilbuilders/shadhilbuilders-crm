'use client';

// Marketing consent, on the lead detail page (2026-11-23).
//
// WHY THIS EXISTS: the site-update WhatsApp templates were approved as
// MARKETING on 2026-11-23. The send decision reads the newest MARKETING row on
// the Consent ledger and skips the send otherwise - and until this panel, no
// screen wrote that row, so every outside-window message was recorded as
// skipped-for-consent. A gate nobody can satisfy is a feature that never runs.
//
// WHO USES IT: the rep who just spoke to the buyer. Consent here is recorded,
// not requested - the buyer already said yes on the phone, and this is the
// note that turns that into a row the sender can read. That is why the default
// answer is "yes" and the default source is "during a call", and why the copy
// asks the operator to record what happened rather than to ask permission.
//
// THREE STATES, NOT A BOOLEAN: "not asked" is the most common state on an
// existing book of leads, and showing it as "no" would tell a rep the buyer
// refused when nobody ever asked. The sender treats both as non-sends; the
// difference matters to the person reading the screen.
import { useState } from 'react';

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  Label,
  RadioGroup,
  Textarea,
  toast,
} from '@paalstack/react-ui';

import { useRecordLeadConsent } from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';
import type { LeadConsentSource, LeadDetail, RecordLeadConsentDto } from '@shadhil/api-types';

const FORM_ID = 'lead-consent-form';

/** How the opt-in was obtained, in the operator's words. */
const SOURCE_OPTIONS: Array<{ value: LeadConsentSource; label: string; className: string }> = [
  { value: 'call_verbal', label: 'During a call', className: 'min-h-11' },
  { value: 'in_person', label: 'In person', className: 'min-h-11' },
  { value: 'whatsapp_button', label: 'WhatsApp reply', className: 'min-h-11' },
  { value: 'booking_form', label: 'Booking form', className: 'min-h-11' },
];

const ANSWER_OPTIONS: Array<{ value: string; label: string; className: string }> = [
  { value: 'granted', label: 'Yes, they agreed to site updates', className: 'min-h-11' },
  { value: 'denied', label: 'No, they asked us not to', className: 'min-h-11' },
];

function statusCopy(lead: LeadDetail): { headline: string; detail: string } {
  const when =
    typeof lead.marketingConsentAt === 'string'
      ? dateIntl.formatDateTime(lead.marketingConsentAt)
      : null;

  if (lead.marketingConsent === 'granted') {
    return {
      headline: when === null ? 'Opted in' : `Opted in on ${when}`,
      detail:
        'Site-update messages can go out at any time. Inside the 24-hour reply window they need no template at all.',
    };
  }
  if (lead.marketingConsent === 'denied') {
    return {
      headline: when === null ? 'Opted out' : `Opted out on ${when}`,
      detail:
        'Site-update messages will be skipped for this buyer. The record of the earlier opt-in stays; the newest answer wins.',
    };
  }
  return {
    headline: 'Not asked yet',
    detail:
      'Nothing has been sent. The site-update templates count as marketing, so they only go to a buyer who has agreed - record that here when they do.',
  };
}

/**
 * The dialog body, exported for tests: Base UI portals render empty under
 * renderToStaticMarkup, so the repo's tests target the body (see
 * LeadEditDialog.tsx). The submit button lives in the Dialog footer and
 * reaches this form through `form={FORM_ID}`.
 */
export function LeadConsentForm({
  initialAnswer,
  pending,
  onSubmit,
}: {
  initialAnswer: 'granted' | 'denied';
  pending: boolean;
  onSubmit: (dto: RecordLeadConsentDto) => void;
}) {
  const [answer, setAnswer] = useState<string>(initialAnswer);
  const [source, setSource] = useState<string>('call_verbal');
  const [note, setNote] = useState('');

  return (
    <form
      id={FORM_ID}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = note.trim();
        onSubmit({
          granted: answer === 'granted',
          source: source as LeadConsentSource,
          ...(trimmed.length > 0 ? { note: trimmed } : {}),
        });
      }}
    >
      <RadioGroup
        aria-label="Did the buyer agree to site-update messages?"
        value={answer}
        onValueChange={(value) => setAnswer(value ?? 'granted')}
        options={ANSWER_OPTIONS}
        data-qa="lead-consent-answer"
      />

      <RadioGroup
        aria-label="How did they give it?"
        label="How did they give it?"
        value={source}
        onValueChange={(value) => setSource(value ?? 'call_verbal')}
        options={SOURCE_OPTIONS}
        data-qa="lead-consent-source"
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="lead-consent-note">What they said (optional)</Label>
        <Textarea
          id="lead-consent-note"
          rows={3}
          maxLength={500}
          value={note}
          onValueChange={setNote}
          placeholder="Asked to be sent photos every fortnight"
          data-qa="lead-consent-note"
        />
      </div>

      {pending ? (
        <p className="text-muted-foreground text-sm" data-qa="lead-consent-saving">
          Recording...
        </p>
      ) : null}
    </form>
  );
}

export function LeadMarketingConsent({ lead }: { lead: LeadDetail }) {
  const [open, setOpen] = useState(false);
  const record = useRecordLeadConsent(lead.id);
  const copy = statusCopy(lead);

  return (
    <Card data-qa="lead-consent-card">
      <CardHeader>
        <CardTitle className="text-base">Marketing consent</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm font-medium" data-qa="lead-consent-status">
          {copy.headline}
        </p>
        <p className="text-muted-foreground text-sm">{copy.detail}</p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(true)}
            data-qa="lead-consent-record-button"
          >
            Record consent
          </Button>
        </div>
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        contentClassName="sm:max-w-md"
        header={{
          title: 'Record marketing consent',
          description:
            'Record what the buyer told you. This adds a row to their consent history; it never rewrites an earlier answer.',
        }}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={record.isPending}
              data-qa="lead-consent-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={FORM_ID}
              disabled={record.isPending}
              data-qa="lead-consent-save"
            >
              {record.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        }
      >
        <LeadConsentForm
          initialAnswer={lead.marketingConsent === 'denied' ? 'denied' : 'granted'}
          pending={record.isPending}
          onSubmit={(dto) => {
            record.mutate(dto, {
              onSuccess: (result) => {
                setOpen(false);
                toast.success(
                  result.changed
                    ? result.answer === 'granted'
                      ? 'Opt-in recorded'
                      : 'Opt-out recorded'
                    : 'That answer was already on record',
                );
              },
              onError: (error) => {
                // Server copy verbatim: a 404 names the lead, a 403 the role.
                toast.error(error instanceof Error ? error.message : 'Could not save consent');
              },
            });
          }}
        />
      </Dialog>
    </Card>
  );
}
