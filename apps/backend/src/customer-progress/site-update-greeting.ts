// What a WhatsApp greeting slot says (build-sequence step 8, owner decision
// 2026-11-23: first name, neutral fallback).
//
// A TEMPLATE PARAMETER CANNOT BE OMITTED. Meta validates the count before it
// reads the text, so "send it without the name" is not a thing we can do with a
// template that declares one: the slot always carries a string, and the only
// choices are what that string says. So a neutral fallback is not "no greeting",
// it is a greeting that still reads as a sentence:
//
//   name usable   ->  "Asha"          ->  "Hello Asha, your villa A-101 ..."
//   name unusable ->  "there"         ->  "Hello there, your villa A-101 ..."
//
// WHY NOT TRUST THE STORED NAME. `Lead.name` is required, but the field is what
// a staff member typed when the lead came in, and in practice it holds
// placeholders ("Sir", "Madam", "Customer", "Test"), phone numbers, an email, or
// a note-to-self. A template that opens "Hello Sir," or "Hello 9876543210," is
// worse than a neutral one - it reads like a machine that did not bother.

/** Names that are really a title or a placeholder, not a person's name. */
const NOT_A_NAME = new Set([
  'sir',
  'madam',
  'maam',
  "ma'am",
  'mam',
  'customer',
  'client',
  'buyer',
  'owner',
  'test',
  'testing',
  'dummy',
  'unknown',
  'na',
  'n/a',
  'none',
  'null',
  'guest',
  'user',
  'mr',
  'mrs',
  'ms',
  'dr',
]);

/** The neutral greeting value, used whenever no usable name is on the record. */
export const NEUTRAL_GREETING = 'there';

/**
 * The FIRST name to greet with, or the neutral fallback.
 *
 * Deliberately conservative: a wrong guess here is printed in a message to a
 * customer about their home, so anything that is not plainly a name becomes
 * "there" rather than a creative reinterpretation of the field.
 */
export function greetingName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return NEUTRAL_GREETING;

  // A name does not contain digits, which catches phone numbers, house numbers,
  // dates and "Flat 12" in one rule.
  if (/[0-9]/.test(cleaned)) return NEUTRAL_GREETING;
  // Nor an @ or a URL: the field sometimes holds an email or a social handle.
  if (/[@/\\]/.test(cleaned)) return NEUTRAL_GREETING;

  const first = cleaned.split(' ')[0] ?? '';
  if (first.length < 2) return NEUTRAL_GREETING;
  if (NOT_A_NAME.has(first.toLowerCase().replace(/\.$/, ''))) return NEUTRAL_GREETING;

  // Initials only ("A. K.", "AK") say nothing friendly; keep the fallback.
  if (first.replace(/\./g, '').length < 2) return NEUTRAL_GREETING;

  // Keep the stored capitalisation ("asha" would print as typed); Meta renders
  // the parameter verbatim, so a lowercase name would look like a typo.
  return first;
}
