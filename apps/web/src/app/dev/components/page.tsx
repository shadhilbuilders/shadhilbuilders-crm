/**
 * Dev-only component verification page.
 *
 * Renders one example of every @paalstack/react-ui component we need to
 * confirm works with the current CSS setup (no library styles.css import,
 * Tailwind v4 @source-driven CSS generation only).
 *
 * Route: /dev/components
 * Lives outside the regular user-facing routes; not linked from anywhere.
 * Delete this file when component styling is fully verified.
 */

'use client';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  Form,
  Input,
  Label,
  Sheet,
  Tooltip,
  TooltipProvider,
  toast,
} from '@paalstack/react-ui';
import { useForm } from 'react-hook-form';

export const dynamic = 'force-dynamic';

type ContactFormData = {
  name: string;
  email: string;
  message: string;
};

export default function ComponentsDevPage(): React.JSX.Element {
  // ── Form (react-hook-form) ─────────────────────────────────
  const form = useForm<ContactFormData>({
    defaultValues: { name: '', email: '', message: '' },
  });

  const onFormSubmit = async (data: ContactFormData) => {
    // Exercise the loading → success promise toast. Reject to flip to error.
    const promise = new Promise<ContactFormData>((resolve, reject) => {
      setTimeout(() => {
        if (data.email.includes('fail')) reject(new Error('Simulated failure'));
        else resolve(data);
      }, 1200);
    });

    toast.promise(promise, {
      loading: 'Sending message...',
      success: `Thanks ${data.name}! We'll reply within 24h.`,
      error: 'Could not send. Try again later.',
    });
  };

  return (
    <TooltipProvider delay={200}>
      <main className="container mx-auto max-w-5xl space-y-12 py-12">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Component dev playground</h1>
          <p className="text-muted-foreground">
            One example per component. If styles are missing, the Tailwind v4 <code>@source</code>
            {' '}scan is not picking the library up — most likely a missing import in
            <code> globals.css</code> or a class that <code>styles.css</code> would have provided.
          </p>
        </header>

        {/* ── Card ─────────────────────────────────────────────── */}
        <section className="space-y-3" data-dev-section="card">
          <h2 className="text-xl font-semibold">Card</h2>
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>Lead #1234 — Priya Sharma</CardTitle>
              <CardDescription>2BHK inquiry · Chennai</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Last contacted 2 days ago. Status: <span className="text-foreground">VISIT_SCHEDULED</span>.
              </p>
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button variant="outline">Snooze</Button>
              <Button>Open Lead</Button>
            </CardFooter>
          </Card>
        </section>

        {/* ── Dialog (props API) ───────────────────────────────── */}
        <section className="space-y-3" data-dev-section="dialog">
          <h2 className="text-xl font-semibold">Dialog (props API)</h2>
          <Dialog
            trigger={<Button variant="default">Schedule visit</Button>}
            header={{
              title: 'Schedule site visit',
              description: 'Pick a date and time. The lead will receive a WhatsApp confirmation.',
            }}
            footer={
              <div className="flex w-full justify-end gap-2">
                <Button variant="outline">Cancel</Button>
                <Button>Confirm visit</Button>
              </div>
            }
          >
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="visit-date">Date</Label>
                <Input id="visit-date" type="date" defaultValue="2026-09-01" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="visit-time">Time</Label>
                <Input id="visit-time" type="time" defaultValue="10:30" />
              </div>
            </div>
          </Dialog>
        </section>

        {/* ── Tooltip (props API) ──────────────────────────────── */}
        <section className="space-y-3" data-dev-section="tooltip">
          <h2 className="text-xl font-semibold">Tooltip (props API)</h2>
          <div className="flex items-center gap-4">
            <Tooltip
              trigger={<Button variant="secondary">Hover me</Button>}
              content={<p>This is a tooltip. Should appear above the button on hover.</p>}
            />
            <Tooltip
              side="right"
              trigger={<Button variant="ghost">Right-side trigger</Button>}
              content={
                <p>Right-side variant — useful for action hints in a dense toolbar.</p>
              }
            />
          </div>
        </section>

        {/* ── Sheet (props API) ────────────────────────────────── */}
        <section className="space-y-3" data-dev-section="sheet">
          <h2 className="text-xl font-semibold">Sheet (props API)</h2>
          <div className="flex gap-3">
            <Sheet
              trigger={<Button variant="outline">Open right sheet</Button>}
              side="right"
              header={{
                title: 'Lead details',
                description: 'Full activity log for this lead.',
              }}
              footer={{
                primaryAction: <Button>Close</Button>,
              }}
            >
              <div className="py-4 text-sm text-muted-foreground">
                <p>Call at 14:02 → Voicemail</p>
                <p>WhatsApp at 14:15 → Replied</p>
                <p>Site visit booked for 2026-09-01 10:30</p>
              </div>
            </Sheet>
            <Sheet
              trigger={<Button variant="outline">Open left sheet</Button>}
              side="left"
              header={{
                title: 'Filters',
                description: 'Narrow the lead list.',
              }}
            >
              <div className="py-4 text-sm">Filter controls would go here.</div>
            </Sheet>
          </div>
        </section>

        {/* ── Toast (sonner-based) ─────────────────────────────── */}
        <section className="space-y-3" data-dev-section="toast">
          <h2 className="text-xl font-semibold">Toast</h2>
          <p className="text-sm text-muted-foreground">
            The <code>Toaster</code> is mounted in <code>Providers</code> at the top of the app tree.
            Click the buttons to fire each variant. Toasts appear top-right.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="default"
              onClick={() => toast.success('Lead created — Priya Sharma assigned to you.')}
            >
              Success
            </Button>
            <Button
              variant="destructive"
              onClick={() => toast.error('Could not save. Network unreachable.')}
            >
              Error
            </Button>
            <Button
              variant="secondary"
              onClick={() => toast.info('WhatsApp message delivered to +91 98xxx xxxxx.')}
            >
              Info
            </Button>
            <Button
              variant="outline"
              onClick={() => toast.warning('This lead has been idle for 30 days.')}
            >
              Warning
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const id = toast.loading('Uploading 3 photos...');
                setTimeout(() => toast.success('Upload complete.', { id }), 1800);
              }}
            >
              Loading → Success
            </Button>
            <Button
              variant="link"
              onClick={() => {
                const promise = new Promise<void>((resolve) => setTimeout(resolve, 1500));
                toast.promise(promise, {
                  loading: 'Syncing with WhatsApp Cloud...',
                  success: 'Inbox synced (47 new messages).',
                  error: 'Sync failed.',
                });
              }}
            >
              Promise
            </Button>
          </div>
        </section>

        {/* ── Form (react-hook-form + zod-style validation) ─────── */}
        <section className="space-y-3" data-dev-section="form">
          <h2 className="text-xl font-semibold">Form (props API)</h2>
          <p className="text-sm text-muted-foreground">
            Data-driven form using <code>react-hook-form</code>. Submit fires a promise
            toast. Try an email containing <code>fail</code> to see the error variant;
            any other email resolves to success.
          </p>
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>Contact lead</CardTitle>
              <CardDescription>One example per field type — input, textarea.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form
                form={form}
                onSubmit={onFormSubmit}
                fields={[
                  {
                    type: 'input',
                    name: 'name',
                    label: 'Full name',
                    placeholder: 'Priya Sharma',
                    required: true,
                  },
                  {
                    type: 'input',
                    name: 'email',
                    label: 'Email',
                    placeholder: 'priya@example.com',
                    required: true,
                    inputType: 'email',
                  },
                  {
                    type: 'textarea',
                    name: 'message',
                    label: 'Message',
                    placeholder: 'Quick note about the 2BHK inquiry...',
                    required: true,
                  },
                ]}
              />
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset();
                  toast.info('Form cleared.');
                }}
              >
                Reset
              </Button>
              <Button
                type="button"
                onClick={() => form.handleSubmit(onFormSubmit)()}
              >
                Send (manual)
              </Button>
            </CardFooter>
          </Card>
        </section>

        <footer className="border-t pt-6 text-sm text-muted-foreground">
          <p>
            Visual checks for this page:
          </p>
          <ul className="ml-4 mt-2 list-disc space-y-1">
            <li>Card → rounded, with subtle ring, brand colors.</li>
            <li>Dialog → opens, semi-transparent backdrop, brand primary header.</li>
            <li>Tooltip → appears on hover, brand background, navy text.</li>
            <li>Sheet → slides in from the chosen side, with a dimmed overlay.</li>
            <li>Toast → top-right, color-coded by variant (green/red/blue/yellow).</li>
            <li>Form → labels above inputs, validation errors below in destructive color.</li>
          </ul>
        </footer>
      </main>
    </TooltipProvider>
  );
}
