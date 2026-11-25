// parseStageFilter - the `?stage=` query string on the buyer timeline.
//
// protects= absent and empty both mean "no filter" (every pre-existing client
//           sends that), UNSET reaches the service as its sentinel, a real stage
//           passes through unchanged, and a typo is REFUSED rather than quietly
//           ignored;
// fails_when= an unknown value returns undefined (a silently unfiltered page
//           looks like a working filter, which is the failure nobody reports), or
//           casing is accepted and the enum stops being the authority;
// no_claim= the SQL the filter becomes (service tests) and the chips (web tests).
import { describe, expect, it } from 'vitest';

import { parseStageFilter } from './customer-portal.controller';

describe('parseStageFilter', () => {
  it('treats absent and empty as no filter', () => {
    expect(parseStageFilter(undefined)).toBeUndefined();
    expect(parseStageFilter('')).toBeUndefined();
    expect(parseStageFilter('   ')).toBeUndefined();
  });

  it('passes a real stage through', () => {
    expect(parseStageFilter('STRUCTURE')).toBe('STRUCTURE');
    expect(parseStageFilter(' PLASTERING ')).toBe('PLASTERING');
  });

  it('carries the UNSET sentinel for captures that recorded no stage', () => {
    expect(parseStageFilter('UNSET')).toBe('UNSET');
  });

  it('refuses a value that is not a stage instead of returning everything', () => {
    expect(() => parseStageFilter('BRICKWORK')).toThrow(/Unknown stage "BRICKWORK"/);
    expect(() => parseStageFilter('unset')).toThrow(/Unknown stage "unset"/);
  });
});
