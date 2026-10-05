/**
 * Seed timestamps for the demo visits the e2e suite asserts on.
 *
 * The visits agenda filters with `isSameMonth(event, selectedDate)`, and
 * selectedDate defaults to this week. Hard-coding September 2026 made both
 * fixture rows vanish on 1 Oct, so "Show past" e2e saw an empty October
 * calendar (and the toggle wait looked like a product hang).
 *
 * Both timestamps stay inside the local month of `now` so they remain in
 * the agenda no matter which day of the month CI runs.
 */
export function demoVisitSchedule(now: Date = new Date()): {
  upcoming: Date;
  past: Date;
} {
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(Math.max(now.getDate(), 1), lastDay);
  const pastDay = day > 1 ? day - 1 : day;
  const upcomingDay = day < lastDay ? day + 1 : day;
  return {
    past: new Date(year, month, pastDay, 10, 0, 0),
    upcoming: new Date(year, month, upcomingDay, 11, 0, 0),
  };
}
