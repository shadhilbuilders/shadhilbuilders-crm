// Focus for the ONE kind of field the props-API `Form` cannot focus itself.
//
// CHECKED FIRST (2026-11-27): `Form` from @paalstack/react-ui already moves the
// cursor to the first refused field on submit, because react-hook-form's
// `shouldFocusError` is on by default and every declarative item
// (input/select/textarea/combobox item) gives it a ref. Rendered and submitted
// in jsdom to confirm, not assumed.
//
// What does NOT work natively is a `type: 'custom'` item rendered by our own
// component with no ref: the phone field. That is the only place this helper is
// used - do not wire it into forms for ordinary fields.

/** Focus a control by its id, then by its `name` attribute. */
export function focusField(name: string): boolean {
  if (typeof document === 'undefined' || name === '') return false;
  const target =
    document.getElementById(name) ??
    document.querySelector<HTMLElement>(`[name="${escapeName(name)}"]`);
  if (target === null) return false;
  target.focus();
  return true;
}

/** CSS.escape when the environment has it (jsdom may not). */
function escapeName(name: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(name);
  return name.replace(/["\\]/g, '\\$&');
}
