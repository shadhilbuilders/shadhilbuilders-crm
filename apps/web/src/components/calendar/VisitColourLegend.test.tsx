// VisitColourLegend - the rendered key (2026-09-30).
//
// `past-event-style.legend.test.ts` pins the DATA (every status covered, correct
// tone, words present). This pins that the component actually renders that data
// and starts CLOSED - a legend that is always open is chrome, and one that never
// opens is the same as no legend at all.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VISIT_LEGEND } from '@/lib/past-event-style';

import { VisitColourLegend } from './VisitColourLegend';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(defaultOpen = false): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<VisitColourLegend defaultOpen={defaultOpen} />);
  });
}

function html(): string {
  return container?.innerHTML ?? '';
}

async function toggle(): Promise<void> {
  const button = container?.querySelector('button');
  if (button === null || button === undefined) throw new Error('legend toggle not found');
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('VisitColourLegend', () => {
  it('starts closed, so it is not permanent chrome over the calendar', async () => {
    await mount();
    expect(html()).toContain('What the colours mean');
    expect(container?.querySelector('[data-qa="visit-colour-legend-list"]')).toBeNull();
  });

  it('opens on click and explains EVERY colour the calendar paints', async () => {
    await mount();
    await toggle();

    const list = container?.querySelector('[data-qa="visit-colour-legend-list"]');
    expect(list).not.toBeNull();

    // Every legend entry, with its word and its sentence - the whole point of
    // the component is that a reader can look up any colour they see.
    for (const entry of VISIT_LEGEND) {
      expect(html(), `${entry.status} missing from the rendered legend`).toContain(entry.label);
      expect(html(), `${entry.status} has no explanation`).toContain(entry.meaning);
    }
    expect(list?.querySelectorAll('li')).toHaveLength(VISIT_LEGEND.length);
  });

  it('renders a swatch per row (the colour is shown, not only described)', async () => {
    await mount();
    await toggle();
    // One swatch span per entry. They are aria-hidden because the words carry
    // the meaning - colour is the reinforcement, never the only channel.
    const swatches = container?.querySelectorAll('[data-qa="visit-colour-legend-list"] li span[aria-hidden="true"]');
    expect(swatches).toHaveLength(VISIT_LEGEND.length);
  });

  it('reflects its open state on the toggle, for keyboard and screen-reader users', async () => {
    await mount();
    const button = container?.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    await toggle();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes again on a second click', async () => {
    await mount();
    await toggle();
    await toggle();
    expect(container?.querySelector('[data-qa="visit-colour-legend-list"]')).toBeNull();
  });

  it('can be opened immediately when a surface wants it shown by default', async () => {
    await mount(true);
    expect(container?.querySelector('[data-qa="visit-colour-legend-list"]')).not.toBeNull();
  });
});
