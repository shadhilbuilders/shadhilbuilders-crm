'use client';

// WhatsappUnknownContactConvertModal - convert an unknown WhatsApp
// contact into a Lead (T-E2b admin UI).
//
// Lifecycle (the single source of truth is the backend service
// `whatsapp-unknown-contacts.service.ts:convert()`):
//
//   1. UI gathers name / email / notes from the admin.
//      - phone is fixed (contact.phoneE164) - admin sees it, doesn't edit it
//      - source is fixed to 'WHATSAPP' (the whole point of this queue)
//
//   2. UI calls POST /api/whatsapp-unknown-contacts/:id/convert with
//      the CreateLeadDto body. The backend's service.createInTransaction
//      (a) creates the Lead (manager assignment + audit log + RLS)
//      (b) flips the contact's status to CONVERTED and sets
//          convertedToLeadId
//      ...all inside ONE transaction. The UI does NOT call
//      POST /api/leads separately - doing so would create a second Lead
//      and violate the 1:1 contact→lead invariant.
//
//   3. On success, the modal closes and the page navigates to
//      /{projectId}/leads/<newLeadId>. The convert mutation hook invalidates the
//      list query + the leads query cache, so the next render of the
//      inbox shows the new Lead without a manual refresh.
//
// Pre-fill (per the locked decision):
//   - name  : empty; placeholder shows the phone number
//   - email : empty (optional)
//   - source: 'WHATSAPP' (forced - disabled input, this is the entire
//             reason the queue exists)
//   - notes : "First message: <firstMessageBody>" (truncated to 2000 chars)
//
// Validation: react-hook-form in `onSubmit` mode. Required: name.
// Client-side mirrors the server's CreateLeadDtoSchema (name length,
// phone digits, email format). Server re-validates and surfaces errors
// verbatim via toast.
//
// Testability: the form body (`<ConvertFormBody />`) is exported as a
// separate component so the wire-shape contract (fields, placeholder,
// description) can be tested via renderToStaticMarkup. The Dialog
// wrapper is Base UI's portal-based component and does NOT render
// content in jsdom SSR mode; we test the body, not the shell.

import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';

import type { FormFieldItemType } from '@paalstack/react-ui';
import { Button, Dialog, Form, toast } from '@paalstack/react-ui';

import { useConvertWaUnknownContact } from '@/hooks/queries/whatsapp-unknown-contacts';
import {
  pickDefaultProject,
  useProjects,
} from '@/hooks/queries';
import { projectHref } from '@/lib/nav';

import {
  CreateLeadDtoSchema,
  type ConvertUnknownContactDto,
  type WhatsappUnknownContactRow,
} from '@shadhil/api-types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { WhatsappUnknownContactRow };

type WhatsappUnknownContactConvertModalProps = {
  /** The contact to convert. Null when no row is selected (modal closed). */
  contact: WhatsappUnknownContactRow | null;
  /** Open state. */
  open: boolean;
  /** Setter - the modal controls its own open state via this callback. */
  onOpenChange: (next: boolean) => void;
  /** Active org id (from the /[orgId] route) for the post-convert navigation. */
  orgId: string;
};

type ConvertFormValues = z.infer<typeof ConvertFormSchema>;

// Form schema derived from the server's CreateLeadDtoSchema (zod skill
// perf-reuse-schemas): pick the fields the admin edits in this modal. The
// server re-validates the full DTO on submit - this is the client-side
// mirror so errors surface inline before the request.
//
// Email/notes are optional, but the form sends '' for an empty optional
// field. z.email()/z.string().min(1) reject '' - .optional() only allows
// undefined, not empty string. So we accept '' as "not provided" via a
// union with z.literal(''); buildConvertBody omits empty values.
const ConvertFormSchema = CreateLeadDtoSchema.pick({ name: true, notes: true }).extend({
  email: z
    .union([z.literal(''), z.email().trim().toLowerCase().max(254)])
    .optional(),
});

// ---------------------------------------------------------------------------
// Pure helpers (extracted for testability + reusable across the form body
// and any future consumers - e.g. a manual "convert" action from the chat
// pane would build the same body).
// ---------------------------------------------------------------------------

export const NOTES_MAX = 2000;

/**
 * Build the notes prefill from the contact's first message body.
 * Returns '' when the body is null/empty (no message arrived yet) or
 * when the row is null (modal closed).
 */
export function prefillNotes(row: WhatsappUnknownContactRow | null): string {
  if (row === null) return '';
  const body = row.firstMessageBody;
  if (body === null || body.length === 0) return '';
  const prefix = 'First message: ';
  const budget = NOTES_MAX - prefix.length;
  const trimmed =
    body.length > budget
      ? // Reserve 3 chars for the '...' marker so prefix + body + '...'
        // stays within NOTES_MAX (the -3, not -1, is what keeps the
        // total ≤ 2000).
        body.slice(0, Math.max(0, budget - 3)) + '...'
      : body;
  return `${prefix}${trimmed}`;
}

/**
 * Build the CreateLeadDto body from the form values + the contact.
 * Trims whitespace, lowercases the email, and omits optional fields
 * when empty. Source is always 'WHATSAPP' (the service overrides it
 * server-side regardless; we still set it so the wire-shape is honest).
 */
export function buildConvertBody(
  contact: WhatsappUnknownContactRow,
  values: ConvertFormValues,
  projectId?: string,
): ConvertUnknownContactDto {
  const body: ConvertUnknownContactDto = {
    name: values.name.trim(),
    phone: contact.phoneE164,
    source: 'WHATSAPP',
    ...(projectId !== undefined ? { projectId } : {}),
    ...(values.email !== undefined && values.email.trim().length > 0
      ? { email: values.email.trim().toLowerCase() }
      : {}),
    ...(values.notes !== undefined && values.notes.trim().length > 0
      ? { notes: values.notes.trim() }
      : {}),
  };
  return body;
}

// ---------------------------------------------------------------------------
// Inner form body - exported for testability (the Dialog wrapper is
// Base UI's portal-based primitive and does not render content via
// renderToStaticMarkup).
// ---------------------------------------------------------------------------

export type ConvertFormBodyProps = {
  contact: WhatsappUnknownContactRow;
  /** Override the form's submit handler (defaults to onSubmit-noop). */
  onSubmit?: (values: ConvertFormValues, body: ConvertUnknownContactDto) => void;
  /** T-ProjectSwitch: stamp the converted lead into this project. */
  projectId?: string;
};

/**
 * The Form body (fields + submit handler). Re-mounts on each new
 * contact id so defaultValues (notably the pre-filled notes) reflect
 * the currently-selected row without leaking the previous one.
 */
export function ConvertFormBody({
  contact,
  onSubmit,
  projectId,
}: ConvertFormBodyProps) {
  const handleSubmit = onSubmit ?? (() => undefined);

  const form = useForm<ConvertFormValues>({
    resolver: zodResolver(ConvertFormSchema),
    defaultValues: {
      name: '',
      email: '',
      notes: prefillNotes(contact),
    },
    mode: 'onSubmit',
  });

  function innerSubmit(values: ConvertFormValues) {
    handleSubmit(values, buildConvertBody(contact, values, projectId));
  }

  const fields: FormFieldItemType<ConvertFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Full name',
      placeholder:
        contact.phoneE164.length > 0 ? contact.phoneE164 : 'Customer name',
      required: true,
      inputProps: {
        maxLength: 120,
        'data-qa': 'wa-unknown-convert-name',
      },
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      placeholder: 'optional@example.com',
      inputType: 'email',
      description: 'Optional. Used for booking confirmations.',
      inputProps: {
        'data-qa': 'wa-unknown-convert-email',
      },
    },
    // Source is intentionally NOT in the fields array - it's a fixed
    // server-side constant (the service normalizes whatever the UI
    // sends to 'WHATSAPP', per whatsapp-unknown-contacts.service.ts).
    // Surfacing it as a disabled input would be honest but adds noise
    // for an admin who knows why they're here. The dialog's
    // description below surfaces the WHATSAPP constant for traceability.
    {
      type: 'textarea',
      name: 'notes',
      label: 'Notes',
      placeholder: "First message: <the contact's first message>",
      description:
        "Pre-filled from the contact's first message. Edit freely; saved on the Lead.",
      textareaProps: {
        rows: 4,
        maxLength: NOTES_MAX,
        'data-qa': 'wa-unknown-convert-notes',
      },
    },
  ];

  return (
    <Form<ConvertFormValues>
      // Key on contact id guarantees a fresh form instance per row -
      // defaultValues (especially the pre-filled notes) do not leak
      // from the previous row.
      key={contact.id}
      id="wa-unknown-convert-form"
      form={form}
      onSubmit={innerSubmit}
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}

// ---------------------------------------------------------------------------
// Public component: the Dialog wrapper.
// ---------------------------------------------------------------------------

export function WhatsappUnknownContactConvertModal({
  contact,
  open,
  onOpenChange,
  orgId,
}: WhatsappUnknownContactConvertModalProps) {
  const router = useRouter();
  const convert = useConvertWaUnknownContact();
  // T-ProjectSwitch: converted leads land in the DEFAULT project
  // (Metro Heights) since the WA-unknown queue is a global admin surface
  // with no project segment in its URL. The post-convert navigation goes
  // to that project's lead detail.
  const { data: projects } = useProjects();
  const defaultProject = pickDefaultProject(projects ?? []);

  function handleSubmit(
    values: ConvertFormValues,
    body: ConvertUnknownContactDto,
  ) {
    const name = values.name.trim();
    if (name.length === 0) {
      toast.error('Name is required');
      return;
    }

    convert.mutate(
      { id: contact!.id, body },
      {
        onSuccess: (result) => {
          const newLeadId = result?.lead?.id;
          toast.success(`Lead "${name}" created from WhatsApp contact`);
          onOpenChange(false);
          if (typeof newLeadId === 'string' && newLeadId.length > 0) {
            void router.push(
              projectHref(orgId, defaultProject?.id ?? null, `/leads/${newLeadId}`),
            );
          }
        },
        onError: (error) => {
          // Server validation messages come through verbatim (400 from
          // the parseBody Zod wrapper in the controller).
          const msg = error instanceof Error ? error.message : 'Convert failed';
          toast.error(msg);
        },
      },
    );
  }

  const description =
    contact === null
      ? 'Convert an unknown WhatsApp contact into a Lead.'
      : `Converting ${contact.phoneE164} - Source will be saved as WHATSAPP.`;

  return (
    <Dialog
      trigger={null}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName='sm:max-w-md'
      header={{ title: 'Convert to lead', description }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={convert.isPending}
            data-qa="wa-unknown-convert-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="wa-unknown-convert-form"
            isLoading={convert.isPending}
            loadingText="Converting..."
            data-qa="wa-unknown-convert-submit"
          >
            Convert to lead
          </Button>
        </div>
      }
    >
      {contact !== null ? (
        <ConvertFormBody
          contact={contact}
          onSubmit={handleSubmit}
          projectId={defaultProject?.id}
        />
      ) : null}
    </Dialog>
  );
}