// PasswordInput — visibility toggle contract.
//
// renderToStaticMarkup-based (repo convention). The initial render is
// type="password" with a "Show password" ghost button (aria-pressed
// false). The visibility swap itself is client state — verified
// in-browser — but the initial contract + a11y attributes are pinned
// here.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@paalstack/react-icons/lu', () => ({
  LuEye: () => <svg data-testid="eye-icon" />,
  LuEyeOff: () => <svg data-testid="eye-off-icon" />,
}));

import { PasswordInput } from './PasswordInput';

describe('PasswordInput (show/hide visibility toggle)', () => {
  it('renders a password input inside an InputGroup with a visibility toggle button', () => {
    const html = renderToStaticMarkup(
      <PasswordInput data-qa="pw" autoComplete="current-password" />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('data-qa="pw"');
    expect(html).toContain('data-qa="pw-visibility"');
    // WCAG 2.5.8: the toggle is a real button with a pressed state.
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Show password"');
    // Eye icon (hidden state) is rendered, not eye-off.
    expect(html).toContain('eye-icon');
    expect(html).not.toContain('eye-off-icon');
  });

  it('forwards arbitrary input props (value, onChange target, placeholder, required)', () => {
    const html = renderToStaticMarkup(
      <PasswordInput
        data-qa="pw2"
        placeholder="Enter it"
        required
        autoComplete="new-password"
        value="hunter2"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('placeholder="Enter it"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('required');
    expect(html).toContain('value="hunter2"');
    // The toggle gets a derived data-qa so tests can target per-field.
    expect(html).toContain('data-qa="pw2-visibility"');
  });

  it('never renders the raw value as plain text in the initial (masked) state', () => {
    // type="password" masks it; belt-and-braces that the component
    // didn't accidentally default `visible` to true.
    const html = renderToStaticMarkup(
      <PasswordInput value="secret-password" onChange={() => undefined} />,
    );
    expect(html).toContain('type="password"');
    expect(html).not.toContain('type="text"');
  });
});