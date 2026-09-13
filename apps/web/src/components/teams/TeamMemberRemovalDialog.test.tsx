// TeamMemberRemovalDialog - body render tests (design doc UI2).
//
// Per the repo rule (LeadReassignDialog.test.tsx precedent): the Dialog
// shell wraps a Base UI portal (invisible under renderToStaticMarkup), so
// tests target the exported `TeamMemberRemovalDialogBody`, which receives
// an already-resolved `preview` object as a prop rather than calling the
// query hook itself - no QueryClientProvider needed.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/apis/client';
import { TeamMemberRemovalDialogBody } from './TeamMemberRemovalDialog';
import type { RemovalPreview } from '@/hooks/queries/team-members';

type PreviewResult = {
  isLoading: boolean;
  error: unknown;
  data: RemovalPreview | undefined;
  refetch: () => void;
};

function previewResult(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    isLoading: false,
    error: null,
    data: undefined,
    refetch: vi.fn(),
    ...overrides,
  };
}

const basePreview: RemovalPreview = {
  teamId: 'team-a',
  userId: 'user-1',
  ownedCount: 0,
  coOwnedCount: 0,
  totalAffectedLeads: 0,
  projects: [],
  ownedStates: [],
  eligibleReplacements: [],
  previewToken: 'token-1',
};

describe('TeamMemberRemovalDialogBody', () => {
  it('renders a skeleton while the preview is loading', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={previewResult({ isLoading: true }) as never}
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('data-qa="team-member-removal-loading"');
  });

  it('LAST_TEAM_PARTICIPANT renders the "add another team member" copy', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={
          previewResult({
            error: new ApiError('no replacement', 404, 'LAST_TEAM_PARTICIPANT'),
          }) as never
        }
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('data-qa="team-member-removal-last-participant"');
    expect(html).toContain('Add another team member before removing this person.');
  });

  it('NO_ELIGIBLE_REPLACEMENT renders the blocking-states copy', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={
          previewResult({
            error: new ApiError('no match', 404, 'NO_ELIGIBLE_REPLACEMENT'),
          }) as never
        }
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('data-qa="team-member-removal-no-eligible"');
    expect(html).toContain('Reassign the incompatible leads through the Leads page first.');
  });

  it('TOO_MANY_AFFECTED_LEADS renders the server message verbatim', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={
          previewResult({
            error: new ApiError('1200 leads are affected, above the 1000 cap.', 409, 'TOO_MANY_AFFECTED_LEADS'),
          }) as never
        }
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('data-qa="team-member-removal-too-many"');
    expect(html).toContain('1200 leads are affected, above the 1000 cap.');
  });

  it('a generic error shows an alert with a retry button', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={previewResult({ error: new Error('network down') }) as never}
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('data-qa="team-member-removal-error"');
    expect(html).toContain('network down');
    expect(html).toContain('data-qa="team-member-removal-retry"');
  });

  it('zero affected leads: omits the replacement picker and shows "no leads are affected"', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={previewResult({ data: basePreview }) as never}
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('No leads are affected by this removal.');
    expect(html).not.toContain('data-qa="team-member-removal-replacement"');
    // Reason is still present and required.
    expect(html).toContain('data-qa="team-member-removal-reason"');
  });

  it('affected leads: shows the replacement picker, summary counts, and project breakdown', () => {
    const data: RemovalPreview = {
      ...basePreview,
      ownedCount: 9,
      coOwnedCount: 3,
      totalAffectedLeads: 12,
      projects: [
        { projectId: 'p1', projectName: 'Metro Heights', ownedCount: 9, coOwnedCount: 3 },
      ],
      eligibleReplacements: [
        { userId: 'r-1', name: 'Priya', role: 'TELECALLER', isTeamManager: false },
        { userId: 'r-2', name: 'Meera', role: 'MANAGER', isTeamManager: true },
      ],
    };
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={previewResult({ data }) as never}
        staleNotice={false}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('Affected: 9 owned leads + 3 co-owned leads across 1 project');
    expect(html).toContain('Metro Heights');
    expect(html).toContain('data-qa="form-field-replacementUserId"');
    expect(html).toContain('Search eligible team members...');
  });

  it('staleNotice prepends the "Details changed" announcement to the live region', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={previewResult({ data: basePreview }) as never}
        staleNotice={true}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('Details changed — checking again.');
    expect(html).toContain('aria-live="polite"');
  });

  it('pending shows the non-dismissible warning copy', () => {
    const html = renderToStaticMarkup(
      <TeamMemberRemovalDialogBody
        preview={previewResult({ data: basePreview }) as never}
        staleNotice={false}
        pending={true}
        onSubmit={vi.fn()}
      />,
    );
    expect(html).toContain('this cannot be undone');
  });
});
