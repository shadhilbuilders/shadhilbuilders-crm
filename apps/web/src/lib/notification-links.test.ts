// protects= a notification row links to where the reader can act; fails_when= an
// unassigned engineer is sent to a villa page they can no longer open, or a row
// with no destination becomes a dead link.
import { describe, expect, it } from 'vitest';

import { ORG_LEVEL_NOTIFICATION_TYPES } from '@shadhil/api-types';

import { notificationTypeLabel } from './notification-labels';
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

  it('protects= a feedback notification links to the admin triage page', () => {
    // fails_when= the reader clicks "New 5/5 feedback" and lands nowhere.
    expect(href({ type: 'feedback.created' })).toBe('/shadhil/admin/feedback');
  });

  it('protects= feedback links work WITHOUT an active project', () => {
    // Feedback is org-level: the reader may be on an admin page with no project
    // in context, where projectSlug is null. A project-scoped branch would have
    // returned a dead template path here.
    expect(notificationHref('shadhil', null, { type: 'feedback.created' })).toBe(
      '/shadhil/admin/feedback',
    );
  });

  it('still returns null for an org-level type with no org slug', () => {
    expect(notificationHref(null, 'metro', { type: 'feedback.created' })).toBeNull();
  });

  it('protects= every org-level type has a destination AND a friendly label', () => {
    // Source of truth: @shadhil/api-types lists the types the backend exempts
    // from the active-project filter. Each one must also be routable here and
    // labelled in the inbox - otherwise a real notification renders as either a
    // dead link or a raw `feedback.created` string, and nothing errors.
    for (const type of ORG_LEVEL_NOTIFICATION_TYPES) {
      expect(notificationHref('shadhil', null, { type }), `${type} has no route`).not.toBeNull();
      expect(notificationTypeLabel(type), `${type} has no friendly label`).not.toBe(type);
    }
  });
});
