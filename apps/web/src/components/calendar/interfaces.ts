// Calendar interfaces (vendored from lramos33/big-calendar, adapted).
import type { TEventColor } from './types';

export interface IUser {
  id: string;
  name: string;
  picturePath: string | null;
}

export interface IEvent {
  id: string;
  startDate: string;
  endDate: string;
  title: string;
  color: TEventColor;
  description: string;
  user: IUser;
  /**
   * Visit-specific fields (2026-09-29). Optional because this interface is also
   * the vendored big-calendar shape, which the week/month/year views use without
   * knowing about visits - but the visit calendar always populates them.
   *
   * They exist so the detail dialog can show WHAT HAPPENED and deep-link to the
   * lead. Before this, the calendar mapped an API row to an event and dropped
   * `status`/`outcome`/`leadId`, so the dialog had nothing to render.
   */
  visit?: {
    status: string;
    outcome: string | null;
    leadId: string;
    /** The LEAD's pipeline state, so both pages show the same status word. */
    leadState: string;
  };
}

export interface ICalendarCell {
  day: number;
  currentMonth: boolean;
  date: Date;
}
