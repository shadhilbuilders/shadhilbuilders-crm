// protects= a notification row links to where the reader can act; fails_when= an
// unassigned engineer is sent to a villa page they can no longer open, or a row
// with no destination becomes a dead link.
import { describe, expect, it } from 'vitest';

import { notificationHref } from './notification-links';

const href = (row: Parameters<typeof notificationHref>[2]) =>
  notificationHref('shadhil', 'metro', row);

describe('notificationHref', () => {
  it('links a unit-anchored site notification to the villa page', () => {
    expect(href({ type: 'progress.assigned', unitId: 'u1' })).toBe(
      '/shadhil/projects/metro/site/u1',
    );
    expect(href({ type: 'progress.photo', unitId: 'u1' })).toBe('/shadhil/projects/metro/site/u1');
  });

  it('sends progress.unassigned to the site home, not the villa they lost', () => {
    expect(href({ type: 'progress.unassigned', unitId: 'u1' })).toBe(
      '/shadhil/projects/metro/site',
    );
  });

  it('links lead notifications to the lead', () => {
    expect(href({ type: 'lead.created', leadId: 'l1' })).toBe('/shadhil/projects/metro/leads/l1');
  });

  it('returns null with no destination or no tenant context', () => {
    expect(href({ type: 'x' })).toBeNull();
    expect(notificationHref(null, 'metro', { unitId: 'u1' })).toBeNull();
    expect(notificationHref('shadhil', null, { unitId: 'u1' })).toBeNull();
  });
});
