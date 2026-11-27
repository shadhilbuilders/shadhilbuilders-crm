'use client';

// Site-update consent, on the lead detail page (2026-11-23, re-scoped 2026-11-27).
//
// WHY THIS EXISTS: it is two things at once, and only one of them gates a send.
// It is the RECORD of what this buyer said about receiving site updates, and it
// is the STOP SWITCH: a recorded "no" is the only consent answer that blocks a
// send. Since the templates were recategorised as UTILITY (2026-11-24), a buyer
// nobody has asked still receives updates, because a site update for a villa
// they have booked is a service message and not marketing.
//
// WHO USES IT: the rep who just spoke to the buyer. Consent here is recorded,
// not requested - the buyer already said yes on the phone, and this turns that
// into a row the sender can read. That is why the default answer is "yes" and
// the default source is "during a call", and why the copy asks the operator to
// record what happened rather than to ask permission.
//
// THREE STATES, NOT A BOOLEAN: "not asked" is the most common state on an
// existing book of leads, and showing it as "no" would tell a rep the buyer
// refused when nobody ever asked. Only "denied" stops a send; the difference
// matters both to the sender and to the person reading the screen.
import { useState, type ReactNode } from 'react';

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
import type {
  LeadConsentAnswer,
  LeadConsentSource,
  LeadDetail,
  RecordLeadConsentDto,
} from '@shadhil/api-types';

const FORM_ID = 'lead-consent-form';

/**
 * One radio row.
 *
 * The height class goes on the LABEL and never on the control. `option.className`
 * is applied to the RadioGroupItem itself, which is a size-4 circle, so a height
 * class there stretches the radio into a sliver with the text floating beside it.
 *
 * min-h-8 (32px), not min-h-11: this is a six-row desktop dialog, and 44px rows
 * plus the group gaps pushed it past a 674px viewport and made it scroll with
 * almost no content in it.
 */
function radioRow<T extends string>(
  value: T,
  label: string,
): { value: T; label: string; labelContent: ReactNode } {
  return {
    value,
    label,
    labelContent: <span className="flex min-h-8 items-center">{label}</span>,
  };
}

/**
 * How the opt-in was obtained, in the operator's words. One map for both the
 * radio list and the "Recorded as ..." line, so the dialog and the card cannot
 * drift into naming the same source two ways.
 */
export const SOURCE_LABELS: Record<LeadConsentSource, string> = {
  call_verbal: 'During a call',
  in_person: 'In person',
  whatsapp_button: 'WhatsApp reply',
  booking_form: 'Booking form',
};

const SOURCE_OPTIONS: Array<{ value: LeadConsentSource; label: string; labelContent: ReactNode }> =
  (Object.keys(SOURCE_LABELS) as LeadConsentSource[]).map((value) =>
    radioRow<LeadConsentSource>(value, SOURCE_LABELS[value]),
  );

/** A source the map does not know about still has to render as itself. */
function sourceLabel(source: string | null | undefined): string | null {
  if (source === null || source === undefined || source.length === 0) return null;
  return SOURCE_LABELS[source as LeadConsentSource] ?? source;
}

const ANSWER_OPTIONS: Array<{ value: string; label: string; labelContent: ReactNode }> = [
  radioRow('granted', 'Yes, they agreed to site updates'),
  radioRow('denied', 'No, they asked us not to'),
];

function statusCopy(lead: LeadDetail): { headline: string; detail: string } {
  const when =
    typeof lead.marketingConsentAt === 'string'
      ? dateIntl.formatDateTime(lead.marketingConsentAt)
      : null;

  if (lead.marketingConsent === 'granted') {
    return {
      headline: when === null ? 'Agreed to updates' : `Agreed to updates on ${when}`,
      detail:
        'Site updates reach this buyer at any time. Inside the 24-hour reply window they go as an ordinary reply, with no template at all.',
    };
  }
  if (lead.marketingConsent === 'denied') {
    return {
      headline: when === null ? 'Asked us to stop' : `Asked us to stop on ${when}`,
      detail:
        'Site updates are skipped for this buyer. An earlier agreement stays on the record; the newest answer is the one that counts.',
    };
  }
  return {
    headline: 'Not asked yet',
    detail:
      'Site updates still reach this buyer, because a villa they have booked is a service message. Record their answer here once they give you one either way.',
  };
}

/**
 * The dialog body, exported for tests: Base UI portals render empty under
 * renderToStaticMarkup, so the repo's tests target the body (see
 * LeadEditDialog.tsx). The submit button lives in the Dialog footer and
 * reaches this form through `form={FORM_ID}`.
 */
export function LeadConsentForm({
  answer,
  note,
  source,
  pending,
  onAnswerChange,
  onNoteChange,
  onSourceChange,
  onSubmit,
}: {
  answer: LeadConsentAnswer;
  note: string;
  source: LeadConsentSource;
  pending: boolean;
  onAnswerChange: (answer: LeadConsentAnswer) => void;
  onNoteChange: (note: string) => void;
  onSourceChange: (source: LeadConsentSource) => void;
  onSubmit: (dto: RecordLeadConsentDto) => void;
}) {
  // Answer, note and source all live in the dialog: the Save button is in the
  // Dialog footer and has to know whether this submit would change anything,
  // and the source is seeded from the record so a reopen cannot silently
  // restamp a refusal as "During a call" when it was given in person.

  return (
    <form
      id={FORM_ID}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = note.trim();
        onSubmit({
          granted: answer === 'granted',
          source,
          ...(trimmed.length > 0 ? { note: trimmed } : {}),
        });
      }}
    >
      <RadioGroup
        aria-label="Did the buyer agree to site-update messages?"
        label="Their answer"
        value={answer}
        onValueChange={(value) => onAnswerChange(value === 'denied' ? 'denied' : 'granted')}
        options={ANSWER_OPTIONS}
        data-qa="lead-consent-answer"
      />

      <RadioGroup
        aria-label="How did they tell you?"
        label="How did they tell you?"
        value={source}
        onValueChange={(value) => onSourceChange((value ?? 'call_verbal') as LeadConsentSource)}
        options={SOURCE_OPTIONS}
        data-qa="lead-consent-source"
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="lead-consent-note">What they said (optional)</Label>
        <Textarea
          id="lead-consent-note"
          rows={2}
          maxLength={500}
          value={note}
          onValueChange={onNoteChange}
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

  // The dialog starts from what is already on the record, including the note.
  // Without the note here a rep reopens the dialog and the words they recorded a
  // minute ago are gone from the box, which reads as "nothing was saved".
  const recordedAnswer: LeadConsentAnswer =
    lead.marketingConsent === 'denied' ? 'denied' : 'granted';
  const recordedNote = lead.marketingConsentNote ?? '';
  // Seeded from the record too: a reopen that silently restamped a refusal given
  // in person as "During a call" would corrupt the provenance of the answer.
  const recordedSourceValue: LeadConsentSource =
    (lead.marketingConsentSource as LeadConsentSource | null | undefined) ?? 'call_verbal';
  const [answer, setAnswer] = useState<LeadConsentAnswer>(recordedAnswer);
  const [note, setNote] = useState(recordedNote);
  const [source, setSource] = useState<LeadConsentSource>(recordedSourceValue);

  // A submit that would write nothing: same answer, same words, same source.
  // The server treats it as a no-op, so the button should not offer it.
  const noop =
    answer === recordedAnswer &&
    note.trim() === recordedNote.trim() &&
    source === recordedSourceValue;
  const recordedSource = sourceLabel(lead.marketingConsentSource);

  return (
    <Card data-qa="lead-consent-card">
      <CardHeader>
        <CardTitle className="text-base">Site update messages</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm font-medium" data-qa="lead-consent-status">
          {copy.headline}
        </p>
        <p className="text-muted-foreground text-sm">{copy.detail}</p>
        {recordedSource === null ? null : (
          <p className="text-muted-foreground text-xs" data-qa="lead-consent-record">
            Recorded as {recordedSource}
          </p>
        )}
        {lead.marketingConsentNote ? (
          <p className="text-sm italic" data-qa="lead-consent-quote">
            They said: {lead.marketingConsentNote}
          </p>
        ) : null}
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              // Re-seed from the record on every open, so a save followed by a
              // reopen shows what was just stored rather than the last edit.
              setAnswer(recordedAnswer);
              setNote(recordedNote);
              setSource(recordedSourceValue);
              setOpen(true);
            }}
            data-qa="lead-consent-record-button"
          >
            Record their answer
          </Button>
        </div>
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        // A laptop window at 700px would otherwise clip the footer with no way
        // to scroll to it, because the dialog has no height cap of its own.
        contentClassName="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto sm:max-w-md"
        header={{
          title: 'Site update messages',
          description:
            'Record what the buyer told you. This adds a row to their history and never rewrites an earlier answer. Only a "no" stops updates going out.',
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
              disabled={record.isPending || noop}
              data-qa="lead-consent-save"
            >
              {record.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        }
      >
        <LeadConsentForm
          answer={answer}
          note={note}
          source={source}
          pending={record.isPending}
          onAnswerChange={setAnswer}
          onNoteChange={setNote}
          onSourceChange={setSource}
          onSubmit={(dto) => {
            record.mutate(dto, {
              onSuccess: (result) => {
                setOpen(false);
                toast.success(
                  result.changed
                    ? result.answer === 'granted'
                      ? 'Opt-in recorded'
                      : 'Opt-out recorded'
                    : // Only reachable when somebody else got there first: the
                      // button is disabled while this submit would be a no-op.
                      'Somebody else recorded that answer first',
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
