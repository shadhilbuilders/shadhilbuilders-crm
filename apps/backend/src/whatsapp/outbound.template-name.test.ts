// T-WA-VISIT-REPLY (2026-11-28): an env var must not be able to name a template
// we deleted from Meta. Production carried the old reminder name after the
// deletion, and that name resolved back to itself through the retired-name map.
import { describe, expect, it } from 'vitest';

import { resolveConfiguredTemplateName } from './outbound.service';

const CURRENT = 'shadhil_visit_reminder_v2';

describe('resolveConfiguredTemplateName', () => {
  it('uses the configured name when it names a live template', () => {
    expect(resolveConfiguredTemplateName(CURRENT, CURRENT)).toBe(CURRENT);
  });

  it('falls back when the variable is absent or empty', () => {
    expect(resolveConfiguredTemplateName(undefined, CURRENT)).toBe(CURRENT);
    expect(resolveConfiguredTemplateName('', CURRENT)).toBe(CURRENT);
  });

  it('refuses a retired name, whatever the deployment still says', () => {
    // This is the exact production value on 2026-11-28: the template was deleted
    // from the account and the env var was not.
    expect(resolveConfiguredTemplateName('shadhil_visit_reminder', CURRENT)).toBe(CURRENT);
    expect(resolveConfiguredTemplateName('shadhil_chat_reply', CURRENT)).toBe(CURRENT);
    expect(resolveConfiguredTemplateName('shadhil_site_update_image', CURRENT)).toBe(CURRENT);
  });

  it('lets an unknown name through, so a new template needs only the variable', () => {
    expect(resolveConfiguredTemplateName('shadhil_visit_reminder_v3', CURRENT)).toBe(
      'shadhil_visit_reminder_v3',
    );
  });
});
