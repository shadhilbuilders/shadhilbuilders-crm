// Initials for an avatar fallback, in one place (2026-11-24).
//
// Two surfaces need the same string now: the sidebar identity block and the
// settings photo control. They were about to be two copies of the same three
// lines, and the fallback is the thing a user sees before they have a photo, so
// the two must never disagree about what "first two words" means.
//
// Behaviour: first letter of each of the first two words, uppercased. Empty or
// whitespace-only names fall back to "?" so the bubble is never blank.
export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}
