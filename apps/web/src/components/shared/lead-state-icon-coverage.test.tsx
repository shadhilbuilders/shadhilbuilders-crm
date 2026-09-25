// Drift tripwires for the lead-state icon + badge-class maps.
//
// WHY THIS EXISTS (2026-09-24): `LeadState.COLD` was renamed to `RNR`.
// Its transition button was mapped to `LuSnowflake` - a pun on "Cold" -
// which became a meaningless glyph the moment the value was renamed, and
// NOTHING failed: no type error, no test, the whole suite stayed green
// while the UI showed a snowflake for a state about unanswered calls.
//
// Both maps fail SILENTLY at runtime, which is what makes a missing entry
// invisible in review:
//   - `STATE_ICONS[target]` undefined -> the button renders text with no
//     glyph (the `{Icon ? <Icon/> : null}` guard swallows it).
//   - `STATE_BADGE_CLASS[status] ?? UNKNOWN` -> a mis-coloured pill.
// Neither is a crash, so only a pinning test catches them.
import { describe, expect, it } from 'vitest';

import { LeadStateSchema } from '@shadhil/api-types';

import { allowedTransitionsFor, STATE_ICONS } from './LeadActionPanel';
import { STATE_BADGE_CLASS } from './LeadStatusBadge';
import { LEAD_STATES } from '@/lib/leads';

const ALL_STATES = LeadStateSchema.options;
/** Every role in the schema's Role enum; the widest possible transition surface. */
const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC'];

/** Every state that any role can transition INTO (the icon map's real domain). */
function allTransitionTargets(): Set<string> {
  const targets = new Set<string>();
  for (const role of ROLES) {
    for (const from of ALL_STATES) {
      for (const to of allowedTransitionsFor(from, role)) targets.add(to);
    }
  }
  return targets;
}

describe('lead-state icon coverage', () => {
  it('every transitions-reachable state has an icon', () => {
    // The transition table drives the buttons, so a state users can move
    // INTO must have a glyph. Deriving the set (rather than hardcoding it)
    // means a new backend state fails here until an icon is chosen.
    const missing = [...allTransitionTargets()].filter(
      (target) => STATE_ICONS[target] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('the transition surface is non-trivial (guards a silent empty set)', () => {
    // If allowedTransitionsFor ever returned [] for everything, the check
    // above would pass vacuously. Pin a floor so that failure is loud.
    expect(allTransitionTargets().size).toBeGreaterThanOrEqual(8);
  });

  it('RNR is mapped to an icon (regression: LuSnowflake pun removal)', () => {
    expect(STATE_ICONS.RNR).toBeDefined();
  });

  it('no icon-map key is a non-existent LeadState', () => {
    // Catches a stale key left behind by a rename, which would otherwise
    // sit there forever as dead config.
    const known = new Set<string>([...ALL_STATES, 'UNKNOWN']);
    const stale = Object.keys(STATE_ICONS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });
});

describe('lead-status badge coverage', () => {
  it('every LeadState has its own badge class', () => {
    // `STATE_BADGE_CLASS[status] ?? UNKNOWN` means a missing entry silently
    // renders the neutral UNKNOWN pill - correct-looking, but wrong.
    const missing = LEAD_STATES.filter(
      (state) => STATE_BADGE_CLASS[state] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('every LeadState has an EXPLICIT key (not the UNKNOWN fallback)', () => {
    // `?? UNKNOWN` makes a missing entry indistinguishable from a deliberate
    // neutral one, so assert presence directly rather than comparing values:
    // NEW and RNR legitimately reuse the neutral pair, and a value comparison
    // would flag them as "missing".
    const implicit = LEAD_STATES.filter(
      (state) => !Object.hasOwn(STATE_BADGE_CLASS, state),
    );
    expect(implicit).toEqual([]);
  });
});
