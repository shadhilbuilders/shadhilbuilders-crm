// readSiteVideoConfig (site update video, step 5).
// protects= caps are never guessed, a bad config fails with every problem named,
// and a switched-off feature demands nothing.
// fails_when= the feature boots with a missing/zero/garbage cap, or a project may
// out-spend its organisation.
import { describe, expect, it } from 'vitest';

import { readSiteVideoConfig } from './site-video.config';

const ON = {
  SITE_VIDEO_CAPTURE: 'true',
  SITE_VIDEO_ORG_CAP_BYTES: '53687091200',
  SITE_VIDEO_PROJECT_CAP_BYTES: '10737418240',
};

describe('readSiteVideoConfig', () => {
  it('requires nothing when the feature is off, and is disabled', () => {
    expect(readSiteVideoConfig({}).enabled).toBe(false);
    expect(readSiteVideoConfig({ SITE_VIDEO_CAPTURE: 'false' }).enabled).toBe(false);
    expect(readSiteVideoConfig({ SITE_VIDEO_CAPTURE: 'TRUE' }).enabled).toBe(false);
  });

  it('reads both caps and applies rate-limit defaults when on', () => {
    expect(readSiteVideoConfig(ON)).toEqual({
      enabled: true,
      orgCapBytes: 53687091200,
      projectCapBytes: 10737418240,
      authPerUserLimit: 20,
      authPerProjectLimit: 100,
      authWindowSeconds: 600,
    });
  });

  it('refuses to start without a cap, naming every missing one', () => {
    expect(() => readSiteVideoConfig({ SITE_VIDEO_CAPTURE: 'true' })).toThrow(
      /SITE_VIDEO_ORG_CAP_BYTES[\s\S]*SITE_VIDEO_PROJECT_CAP_BYTES/,
    );
  });

  it.each(['0', '-5', '1.5', 'ten', '', ' '])('rejects the cap value %j', (bad) => {
    expect(() => readSiteVideoConfig({ ...ON, SITE_VIDEO_ORG_CAP_BYTES: bad })).toThrow(
      /SITE_VIDEO_ORG_CAP_BYTES/,
    );
  });

  it('rejects a project cap above the org cap', () => {
    expect(() =>
      readSiteVideoConfig({ ...ON, SITE_VIDEO_PROJECT_CAP_BYTES: '99999999999999' }),
    ).toThrow(/cannot exceed/);
  });

  it('accepts overridden rate limits and rejects a garbage one', () => {
    const cfg = readSiteVideoConfig({
      ...ON,
      SITE_VIDEO_AUTH_USER_LIMIT: '5',
      SITE_VIDEO_AUTH_PROJECT_LIMIT: '9',
      SITE_VIDEO_AUTH_WINDOW_SECONDS: '60',
    });
    expect([cfg.authPerUserLimit, cfg.authPerProjectLimit, cfg.authWindowSeconds]).toEqual([
      5, 9, 60,
    ]);
    expect(() => readSiteVideoConfig({ ...ON, SITE_VIDEO_AUTH_USER_LIMIT: 'x' })).toThrow(
      /SITE_VIDEO_AUTH_USER_LIMIT/,
    );
  });
});
