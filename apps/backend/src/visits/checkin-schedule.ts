// Quiet hours for the completed-visit check-in (2026-11-24).
//
// A visit marked COMPLETED at 22:30 must not ask the buyer how it went at 22:30.
// The check-in is owed the moment the outcome is recorded, but it may only be
// sent inside the working day, so the visit stores WHEN it becomes sendable and
// the reminder cron picks it up then.
//
// IST is UTC+05:30 all year. There is no daylight saving to consult, which is why
// this is arithmetic on a fixed offset rather than a timezone lookup: the same
// input must give the same answer on a developer laptop, on the CI runner and in
// the container, whatever TZ those happen to run under.

/** First hour (IST, inclusive) a check-in may be sent. */
export const CHECKIN_WINDOW_START_HOUR = 8;

/** Hour (IST, exclusive) after which a check-in waits for the next morning. */
export const CHECKIN_WINDOW_END_HOUR = 20;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The IST wall clock for an instant, as a UTC-based Date for easy field reads. */
function istClock(instant: Date): Date {
  return new Date(instant.getTime() + IST_OFFSET_MS);
}

/**
 * When a check-in recorded at `now` may be sent.
 *
 * Inside the window it is due immediately, so the next cron tick (within a minute)
 * sends it. Outside it, due at 08:00 IST the next morning. The returned Date is a
 * real instant, not an IST wall-clock value.
 */
export function nextCheckinSlot(now: Date): Date {
  const clock = istClock(now);
  const hour = clock.getUTCHours();

  if (hour >= CHECKIN_WINDOW_START_HOUR && hour < CHECKIN_WINDOW_END_HOUR) {
    return now;
  }

  // Midnight-to-08:00 IST is today's 08:00; 20:00 onwards is tomorrow's. Using the
  // IST calendar date keeps that distinction, which a fixed 8-hour shift on the
  // instant would get wrong either side of midnight.
  const daysAhead = hour >= CHECKIN_WINDOW_END_HOUR ? 1 : 0;
  const nextMorningIstClock = Date.UTC(
    clock.getUTCFullYear(),
    clock.getUTCMonth(),
    clock.getUTCDate() + daysAhead,
    CHECKIN_WINDOW_START_HOUR,
    0,
    0,
    0,
  );
  return new Date(nextMorningIstClock - IST_OFFSET_MS);
}

/**
 * Whether a due check-in is still worth sending, per the 48-hour cap.
 *
 * A check-in the cron could not send for two days never arrives: "how did your
 * visit go" three days later reads as a machine, and worse, it would be scanned
 * on every tick forever if nothing claimed it.
 */
export const CHECKIN_MAX_LATENESS_MS = 48 * HOUR_MS;

export function checkinStillWorthSending(dueAt: Date, now: Date): boolean {
  return now.getTime() - dueAt.getTime() <= CHECKIN_MAX_LATENESS_MS;
}
