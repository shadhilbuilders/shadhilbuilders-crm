// Render + interaction tests for the plot layout surface.
//
// Mounted with `createRoot` + `act` rather than `renderToStaticMarkup`: the
// component reads availability through a TanStack query, so a static render
// would silently assert against the loading skeleton. Per the shadhil-crm-dev
// skill this is the only pattern that catches that class of false-green.
//
// The availability HOOK is mocked, not the network. This file is about what the
// surface renders for a given set of rows; the real path (BFF -> NestJS -> RLS)
// is covered by `src/test/e2e/plot-layout.spec.ts` against a live server.
//
// No `@testing-library/react` in this repo, so interaction is a real dispatched
// event on a real DOM node.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLOT_SELECTED_FILL } from './plot-colors';
import { PLOT_GEOMETRY } from './plot-geometry';
import { PlotLayout } from './PlotLayout';

/**
 * `vi.hoisted` because `vi.mock` is lifted above the module body: a plain `let`
 * referenced inside the factory would be in its temporal dead zone when the
 * mocked module is first imported.
 */
const mockPlotStatuses = vi.hoisted(() => ({
  rows: [] as { plotNumber: number; status: string }[],
  isPending: false,
  isError: false,
  error: null as Error | null,
  refetch: () => undefined,
}));

vi.mock('@/hooks/queries/inventory', () => ({
  usePlotStatuses: () => ({
    data: { rows: mockPlotStatuses.rows },
    isPending: mockPlotStatuses.isPending,
    isError: mockPlotStatuses.isError,
    error: mockPlotStatuses.error,
    refetch: mockPlotStatuses.refetch,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PlotLayout />);
  });
}

async function unmount() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

function html(): string {
  return container?.innerHTML ?? '';
}

function click(selector: string) {
  const element = container?.querySelector(selector);
  if (element === null || element === undefined) {
    throw new Error(`expected to find ${selector}`);
  }
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Type into a controlled React input.
 *
 * Assigning `input.value` directly does NOT work: React keeps a shadow copy of
 * the last value it rendered and treats a matching string as "unchanged", so
 * the change handler never fires and the test passes against stale UI. Going
 * through the prototype's native setter updates React's tracker too.
 */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function searchInput(): HTMLInputElement {
  const input = container?.querySelector('[data-qa="plot-search-input"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('plot search input not found');
  }
  return input;
}

beforeEach(() => {
  container = null;
  root = null;
  mockPlotStatuses.rows = [];
  mockPlotStatuses.isPending = false;
  mockPlotStatuses.isError = false;
  mockPlotStatuses.error = null;
});

afterEach(async () => {
  await unmount();
});

describe('PlotLayout', () => {
  it('renders a clickable shape for every one of the 125 plots', async () => {
    await mount();
    expect(container?.querySelectorAll('[data-qa="plot-polygon"]')).toHaveLength(125);
    expect(
      container?.querySelectorAll('[data-qa="plot-map-hit-areas"] polygon').length
    ).toBeGreaterThanOrEqual(125);
  });

  it('renders the drawing as the map background, in the shared coordinate space', async () => {
    await mount();
    const image = container?.querySelector('[data-qa="plot-map-background"] image');
    expect(image?.getAttribute('href')).toBe('/cmda-plan.svg');
    const map = container?.querySelector('[data-qa="plot-map"]');
    // viewBox and artwork must start at the same origin, or the polygons drift
    // off the drawing during zoom.
    expect(map?.getAttribute('viewBox')?.startsWith('99.1 108.8')).toBe(true);
  });

  it('explains an empty availability result instead of looking broken', async () => {
    await mount();
    // An all-grey layout with no explanation reads as a bug. The real cause -
    // no unit in the project is plot-numbered - has to be stated.
    expect(container?.querySelector('[data-qa="plot-no-unit-mapping"]')).not.toBeNull();
    expect(html()).toContain('numbered by plot');
  });

  it('drops the explanation once the project has plot-numbered units', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    expect(container?.querySelector('[data-qa="plot-no-unit-mapping"]')).toBeNull();
  });

  it('shows the legend with the three statuses and the selected key', async () => {
    await mount();
    const legend = container?.querySelector('[data-qa="plot-legend"]');
    expect(legend?.textContent).toContain('Available');
    expect(legend?.textContent).toContain('Booked');
    expect(legend?.textContent).toContain('Selected');
    expect(legend?.textContent).toContain('125 plots');
  });

  it('counts the legend from the availability rows it was given', async () => {
    mockPlotStatuses.rows = [
      { plotNumber: 5, status: 'booked' },
      { plotNumber: 17, status: 'blocked' },
    ];
    await mount();
    const legend = container?.querySelector('[data-qa="plot-legend"]')?.textContent ?? '';
    expect(legend).toContain('Available (123)');
    expect(legend).toContain('Booked (1)');
    expect(legend).toContain('Blocked (1)');
  });

  it('paints booked, available and blocked plots with their own colours', async () => {
    mockPlotStatuses.rows = [
      { plotNumber: 5, status: 'booked' },
      { plotNumber: 17, status: 'blocked' },
    ];
    await mount();
    expect(
      container?.querySelector('[data-plot-number="5"] polygon[fill="#16A34A"]')
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-plot-number="17"] polygon[fill="#DC2626"]')
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-plot-number="1"] polygon[fill="#9CA3AF"]')
    ).not.toBeNull();
  });

  it('starts with the details panel empty rather than showing a random plot', async () => {
    await mount();
    expect(html()).toContain('No plot selected');
  });

  it('selects a plot from the search results and shows its details', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});
    const details = container?.querySelector('[data-qa="plot-details"]');
    expect(details?.textContent).toContain('Plot 20');
    expect(details?.textContent).toContain('Regular plot');
    // The status shown is the one the API supplied, not a guess.
    expect(details?.textContent).toContain('Booked');
    // Measured values come from the traced geometry.
    const geometry = PLOT_GEOMETRY.find((plot) => plot.plotNumber === 20);
    expect(details?.textContent).toContain(`${geometry?.areaSqM.toFixed(1)} m`);
    // No price exists, and the panel must say so instead of showing zero.
    expect(details?.textContent).toContain('Not set');
  });

  it('handles a plot number that does not exist without breaking the map', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    await typeInto(searchInput(), '999');
    // The query input caps at three digits, so 999 is reachable but has no plot.
    expect(container?.querySelector('[data-qa="plot-map"]')).not.toBeNull();
    expect(container?.querySelectorAll('[data-qa="plot-polygon"]')).toHaveLength(125);
    expect(container?.querySelector('[data-qa="plot-search-empty"]')).not.toBeNull();
  });

  it('fills the selected plot with the selected colour and draws no selection stroke', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});
    const selected = container?.querySelectorAll('[data-plot-number="20"] polygon');
    // Only the plot's own polygon remains - no extra halo/ring polygon.
    expect(selected).toHaveLength(1);
    expect(selected?.[0]?.getAttribute('fill')).toBe(PLOT_SELECTED_FILL);
    expect(selected?.[0]?.getAttribute('stroke')).toBe('none');
  });

  it('clears the selected plot when the status filter changes', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});
    expect(container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')).toBe(
      PLOT_SELECTED_FILL
    );

    const trigger = container?.querySelectorAll('[role="combobox"]')[1];
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
      node.textContent?.includes('Booked')
    );
    expect(option).toBeDefined();
    await act(async () => {
      for (const type of [
        'pointerover',
        'pointermove',
        'pointerdown',
        'mousedown',
        'pointerup',
        'mouseup',
        'click',
      ]) {
        option?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      }
    });
    await act(async () => {});

    expect(
      container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')
    ).not.toBe(PLOT_SELECTED_FILL);
    expect(html()).toContain('No plot selected');
  });

  it('clears the selected plot when the filters are cleared', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});
    expect(html()).not.toContain('No plot selected');

    click('[data-qa="plot-filters-reset"]');
    await act(async () => {});

    expect(html()).toContain('No plot selected');
    expect(
      container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')
    ).not.toBe(PLOT_SELECTED_FILL);
  });

  it('dims plots the search excludes, and stops them intercepting clicks', async () => {
    await mount();
    await typeInto(searchInput(), '20');
    const matched = container?.querySelector('[data-plot-number="20"]');
    const excluded = container?.querySelector('[data-plot-number="1"]');
    expect(matched?.getAttribute('opacity')).toBe('1');
    expect(excluded?.getAttribute('opacity')).toBe('0.12');
    // A dimmed plot must not accept a click, or the filter would be a lie.
    const excludedPolygon = excluded?.querySelector('polygon[role="button"]');
    expect(excludedPolygon?.getAttribute('style')).toContain('pointer-events: none');
    const matchedPolygon = matched?.querySelector('polygon[role="button"]');
    expect(matchedPolygon?.getAttribute('style')).not.toContain('pointer-events: none');
  });

  it('zooms the drawing when the zoom control is used', async () => {
    await mount();
    const before = container?.querySelector('[data-qa="plot-map"]')?.getAttribute('viewBox');
    click('[data-qa="plot-map-zoom-in"]');
    await act(async () => {});
    const after = container?.querySelector('[data-qa="plot-map"]')?.getAttribute('viewBox');
    expect(after).not.toBe(before);
    const widthBefore = Number(before?.split(' ')[2]);
    const widthAfter = Number(after?.split(' ')[2]);
    // Zooming in must shrink the visible window (show less area, larger).
    expect(widthAfter).toBeLessThan(widthBefore);
  });

  it('resets back to the full plan', async () => {
    await mount();
    click('[data-qa="plot-map-zoom-in"]');
    await act(async () => {});
    click('[data-qa="plot-map-reset"]');
    await act(async () => {});
    const viewBox = container?.querySelector('[data-qa="plot-map"]')?.getAttribute('viewBox');
    expect(viewBox).toBe('99.1 108.8 601.4 508.2');
  });

  it('exposes the map as a single keyboard stop with instructions', async () => {
    await mount();
    const map = container?.querySelector('[data-qa="plot-map"]');
    expect(map?.getAttribute('tabindex')).toBe('0');
    expect(map?.getAttribute('aria-label')).toContain('arrow keys');
  });

  it('gives every plot an accessible name carrying number, category and status', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 5, status: 'booked' }];
    await mount();
    const polygon = container?.querySelector('[data-plot-number="5"] polygon[role="button"]');
    expect(polygon?.getAttribute('aria-label')).toBe('Plot 5, Regular plot, Booked');
  });

  it('shows a retryable error, not an empty map, when availability fails', async () => {
    mockPlotStatuses.isError = true;
    mockPlotStatuses.error = new Error('Availability service unavailable');
    await mount();
    const error = container?.querySelector('[data-qa="plot-layout-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('Availability service unavailable');
    expect(container?.querySelector('[data-qa="plot-layout-retry"]')).not.toBeNull();
    // Never render a half-known map: no polygons and no fabricated availability.
    expect(container?.querySelectorAll('[data-qa="plot-polygon"]')).toHaveLength(0);
  });

  it('shows a loading placeholder while availability is in flight', async () => {
    mockPlotStatuses.isPending = true;
    await mount();
    expect(container?.querySelector('[data-qa="plot-layout-loading"]')).not.toBeNull();
    expect(container?.querySelectorAll('[data-qa="plot-polygon"]')).toHaveLength(0);
  });
});
