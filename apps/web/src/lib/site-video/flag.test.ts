// isSiteVideoEnabled.
// protects= the flag matches the backend: only the exact string 'true' enables it.
// fails_when= 'TRUE', '1', 'yes' or an unset variable turns video on in the UI
// while the API still answers 404.
import { describe, expect, it } from 'vitest';

import { isSiteVideoEnabled } from './flag';

describe('isSiteVideoEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(isSiteVideoEnabled({ SITE_VIDEO_CAPTURE: 'true' })).toBe(true);
  });
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes', ' true'])('is off for %j', (v) => {
    expect(isSiteVideoEnabled({ SITE_VIDEO_CAPTURE: v })).toBe(false);
  });
});
