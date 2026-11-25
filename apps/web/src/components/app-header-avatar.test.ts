// Guard: the topbar account menu shows the person's PHOTO, not a silhouette.
//
// WHY A SOURCE-LEVEL TEST. AppHeader is rendered by the [orgSlug] LAYOUT and its
// UserMenu takes the session, the tenant context and four query hooks, which is
// why its siblings (app-header-safe-area, app-header-popover-close) pin their
// contracts on the source too. The behaviour of `SelfAvatar` itself - server URL
// in, initials as the fallback - is covered by its own render suite; what this
// file pins is that the account menu actually USES it, in both places the owner
// looks at:
//
//   1. the trigger button, which showed a generic `LuUserRound` while the
//      sidebar footer showed the real photo, so one person had two faces in two
//      corners of the same screen (reported 2026-11-26);
//   2. the popover header, which named the person with no face at all.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/app-header.tsx', 'utf8');

/** The account menu's trigger button, from its opening tag to `</Button>`. */
function accountMenuButton(): string {
  const qa = source.indexOf('data-qa="account-menu"');
  expect(qa, 'the account menu trigger is missing').toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('<Button', qa);
  const end = source.indexOf('</Button>', qa);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('AppHeader account menu shows the photo', () => {
  it('renders SelfAvatar in the trigger button', () => {
    expect(accountMenuButton()).toContain('<SelfAvatar');
  });

  it('renders SelfAvatar in the popover header beside the name', () => {
    const header = source.indexOf('mb-2 flex items-center gap-2 px-1');
    expect(header, 'the account menu header is missing').toBeGreaterThanOrEqual(0);
    const block = source.slice(header, source.indexOf('<Separator />', header));
    expect(block).toContain('<SelfAvatar');
    expect(block).toContain('{name}');
  });

  it('no longer imports the generic user icon', () => {
    // A silhouette next to a real photo is the defect, so the icon is removed
    // from the import list rather than left unused.
    expect(source).not.toContain('LuUserRound');
  });

  it('renders exactly two avatars: the trigger and the header', () => {
    // A third one would mean another surface quietly grew its own copy instead
    // of using the shared component.
    expect(source.match(/<SelfAvatar/g) ?? []).toHaveLength(2);
  });
});
