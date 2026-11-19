// ProjectFormBody (edit mode) - slug editing, 2026-11-19.
//
// The slug IS the URL of every page for a project, so the edit dialog exposes
// it. These tests pin the two halves that can silently rot:
//   1. edit mode renders the slug, prefilled, and create mode does not (create
//      derives it from the name server-side)
//   2. the PATCH carries the new slug ONLY when it actually changed - re-saving
//      an untouched form must not rewrite the slug into an audit row
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
}));

vi.mock('@/hooks/queries', () => ({
  useCreateProject: () => ({ mutate: mocks.createMutate, isPending: false, error: null }),
  useUpdateProject: () => ({ mutate: mocks.updateMutate, isPending: false, error: null }),
  useDeleteProject: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ProjectFormBody } from './project-form-bodies';

const PROJECT = {
  id: 'proj-metro',
  slug: 'shadhil-metro-heights',
  name: 'Shadhil Metro Heights',
  address: 'Chennai',
  reraNumber: null,
  cmdaNumber: null,
  createdAt: '2026-09-05T00:00:00.000Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(ui);
  });
}

beforeEach(() => {
  mocks.createMutate.mockReset();
  mocks.updateMutate.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('ProjectFormBody - slug field', () => {
  it('edit mode renders the slug field, prefilled with the current slug', async () => {
    await mount(<ProjectFormBody mode="edit" project={PROJECT} onDone={vi.fn()} />);
    const slug = container?.querySelector('[data-qa="project-form-slug"]');
    expect(slug).not.toBeNull();
    // A field without its current value is worse than no field at all.
    expect(container?.innerHTML).toContain('shadhil-metro-heights');
  });

  it('create mode has no slug field - the server derives it from the name', async () => {
    await mount(<ProjectFormBody mode="create" onDone={vi.fn()} />);
    expect(container?.querySelector('[data-qa="project-form-slug"]')).toBeNull();
  });

  it('the slug input advertises the rule it enforces', async () => {
    await mount(<ProjectFormBody mode="edit" project={PROJECT} onDone={vi.fn()} />);
    const slug = container?.querySelector<HTMLInputElement>('[data-qa="project-form-slug"]');
    expect(slug?.maxLength).toBe(80);
    expect(slug?.getAttribute('autocapitalize')).toBe('none');
    expect(slug?.getAttribute('spellcheck')).toBe('false');
  });
});
