// protects= the assignee row is a picker for ADMIN/OWNER, read-only for MANAGER
// and absent for site roles; fails_when= a manager or engineer is offered the
// picker, or an unassigned villa renders a blank value.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ role: 'ADMIN' as string }));

vi.mock('@paalstack/react-ui', () => ({
  Combobox: (p: { 'data-qa': string }) => <div data-qa={p['data-qa']} />,
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/hooks/queries/inventory', () => ({
  useAssignUnitEngineer: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/users', () => ({
  useUsers: () => ({ data: { rows: [], total: 0 } }),
}));
vi.mock('@/lib/session', () => ({
  useSessionUser: () => ({ user: { role: mocks.role } }),
  isAdminLike: (r: string) => r === 'ADMIN' || r === 'OWNER',
}));

import type { UnitRow } from '@/hooks/queries/inventory';

import { AssignedEngineerRow } from './AssignedEngineerRow';

const unit = (over: Partial<UnitRow> = {}): UnitRow =>
  ({
    id: 'u1',
    projectId: 'p1',
    assignedEngineerId: null,
    assignedEngineerName: null,
    ...over,
  }) as UnitRow;

const render = (role: string, u: UnitRow) => {
  mocks.role = role;
  return renderToStaticMarkup(<AssignedEngineerRow unit={u} />);
};

describe('AssignedEngineerRow', () => {
  it('offers the picker to ADMIN and OWNER', () => {
    for (const role of ['ADMIN', 'OWNER']) {
      expect(render(role, unit())).toContain('data-qa="unit-assign-engineer"');
    }
  });

  it('shows MANAGER the engineer name read-only, or "Not assigned"', () => {
    const named = render(
      'MANAGER',
      unit({ assignedEngineerId: 'e1', assignedEngineerName: 'Ravi' }),
    );
    expect(named).toContain('Ravi');
    expect(named).not.toContain('unit-assign-engineer');
    expect(render('MANAGER', unit())).toContain('Not assigned');
  });

  it('renders nothing for site roles', () => {
    for (const role of ['ENGINEER', 'TELECALLER', 'SALES_EXEC']) {
      expect(render(role, unit())).toBe('');
    }
  });
});
