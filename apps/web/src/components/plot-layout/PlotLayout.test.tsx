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

import { PLOT_SELECTED_FILL, PLOT_STATUS_FILL } from './plot-colors';
import { PLOT_GEOMETRY } from './plot-geometry';
import { PlotLayout } from './PlotLayout';

/**
 * `vi.hoisted` because `vi.mock` is lifted above the module body: a plain `let`
 * referenced inside the factory would be in its temporal dead zone when the
 * mocked module is first imported.
 */
const mockPlotStatuses = vi.hoisted(() => ({
  // Rows carry the units the API joins on the plot number. `units` is optional
  // here so a test about colour can skip the record half entirely.
  rows: [] as {
    plotNumber: number;
    status: string;
    units?: {
      unit: {
        id: string;
        phaseId: string;
        phaseName: string;
        projectId: string;
        projectName: string;
        unitNumber: string;
        plotNumber: number | null;
        bhk: number;
        facing: string | null;
        sqft: number | null;
        buildupSqft: string;
        pricePerSqft: string;
        price: string;
        status: string;
        createdAt: string;
      };
      booking: {
        id: string;
        status: string;
        amount: string;
        tokenAmount: string | null;
        leadId: string;
        leadName: string;
        createdAt: string;
      } | null;
    }[];
  }[],
  isPending: false,
  isError: false,
  error: null as Error | null,
  refetch: () => undefined,
}));

/** A villa on a plot, as the API sends it: door number separate from plot number. */
function claimFixture(overrides: { plotNumber?: number; unitNumber?: string } = {}) {
  return {
    unit: {
      id: 'unit-a101',
      phaseId: 'phase-1',
      phaseName: 'Phase A',
      projectId: 'proj-1',
      projectName: 'Demo Villas',
      unitNumber: overrides.unitNumber ?? 'A-101',
      plotNumber: overrides.plotNumber ?? 20,
      bhk: 3,
      facing: 'East',
      sqft: 1450,
      buildupSqft: '1450',
      pricePerSqft: '4000',
      price: '5800000',
      status: 'SOLD',
      createdAt: '2026-10-01T09:00:00.000Z',
    },
    booking: {
      id: 'booking-1',
      status: 'APPROVED',
      amount: '5800000',
      tokenAmount: '250000',
      leadId: 'lead-1',
      leadName: 'Demo Vikram',
      createdAt: '2026-10-02T09:00:00.000Z',
    },
  };
}

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
 * Click a plot on the map the way a user does.
 *
 * The map does NOT select on the polygon's `onClick`: it decides on
 * `pointerup`, because a drag that starts on a plot must be a pan, not a
 * selection. So the gesture is dispatched as pointerdown on the polygon
 * (which is where the map reads the pressed plot from) and pointerup on the
 * <svg> (which is where the browser delivers it, because the map takes
 * pointer capture on the svg).
 */
function clickPlot(plotNumber: number) {
  const polygon = container?.querySelector(
    `[data-plot-number="${plotNumber}"] polygon[role="button"]`
  );
  const svg = container?.querySelector('[data-qa="plot-map"]');
  if (polygon === null || polygon === undefined) {
    throw new Error(`expected to find plot ${plotNumber}`);
  }
  if (svg === null || svg === undefined) {
    throw new Error('expected to find the map');
  }

  const pointerEvent = (type: string, target: Element) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    // jsdom has no PointerEvent, so the pointer-specific fields are added to
    // a MouseEvent. React reads them off the native event.
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    target.dispatchEvent(event);
  };

  pointerEvent('pointerdown', polygon);
  pointerEvent('pointerup', svg);
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
    // no villa in the project has a plot number yet - has to be stated, along
    // with the fact that a plot number is not a door number.
    expect(container?.querySelector('[data-qa="plot-no-unit-mapping"]')).not.toBeNull();
    expect(html()).toContain('has a plot number yet');
    expect(html()).toContain('door number');
  });

  it('drops the explanation once the project has a villa on a plot', async () => {
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
    // available = green, blocked = gold, booked = red.
    expect(
      container?.querySelector('[data-plot-number="5"] polygon[fill="#DC2626"]')
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-plot-number="17"] polygon[fill="#E3C563"]')
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-plot-number="1"] polygon[fill="#15803D"]')
    ).not.toBeNull();
  });

  it('writes the plot number in a colour that reads on its fill', async () => {
    // The status fill is opaque, so it covers the number the approved drawing
    // prints inside the plot. The number is re-drawn on top, at the plot's own
    // centre, in a colour that reads against THAT fill: white on the dark
    // green and red, dark ink on the light gold.
    mockPlotStatuses.rows = [
      { plotNumber: 20, status: 'booked' },
      { plotNumber: 17, status: 'blocked' },
    ];
    await mount();
    const booked = container?.querySelector('[data-plot-number="20"] [data-qa="plot-number"]');
    expect(booked?.textContent).toBe('20');
    expect(booked?.getAttribute('fill')).toBe('#FFFFFF');
    // Centred on the plot, not floating in a corner.
    expect(booked?.getAttribute('text-anchor')).toBe('middle');

    const blocked = container?.querySelector('[data-plot-number="17"] [data-qa="plot-number"]');
    expect(blocked?.textContent).toBe('17');
    // A light gold fill cannot carry white text, so it carries dark ink.
    expect(blocked?.getAttribute('fill')).toBe('#1F2937');
  });

  it('does not write a number on a dimmed plot', async () => {
    // A filtered-out plot must not read as a live, sellable plot, so it
    // carries no number either.
    await mount();
    await typeInto(searchInput(), '20');
    const dimmed = container?.querySelector('[data-plot-number="1"] [data-qa="plot-number"]');
    expect(dimmed).toBeNull();
    const shown = container?.querySelector('[data-plot-number="20"] [data-qa="plot-number"]');
    expect(shown?.textContent).toBe('20');
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
    // No villa claims this plot in this fixture, and the panel says exactly
    // that instead of rendering a made-up record or a bare "Not set".
    expect(details?.textContent).toContain('No villa on this plot yet');
    expect(details?.querySelector('[data-qa="plot-villa"]')).toBeNull();
  });

  it('shows the real villa and its booking on a claimed plot, with links', async () => {
    // The whole point of the join: the panel names the villa (by its DOOR
    // number), its state and the deal on it, and each is a link to its own
    // record rather than a dead end.
    mockPlotStatuses.rows = [
      { plotNumber: 20, status: 'booked', units: [claimFixture()] },
    ];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});

    const details = container?.querySelector('[data-qa="plot-details"]');
    expect(details?.textContent).toContain('A-101');
    expect(details?.textContent).toContain('Sold');
    expect(details?.textContent).toContain('Approved');
    expect(details?.textContent).toContain('Demo Vikram');
    expect(details?.textContent).toContain('Phase A');

    // The villa link carries the plot map's unit id into the inventory grid.
    expect(
      details?.querySelector('[data-qa="plot-unit-link"]')?.getAttribute('href'),
    ).toContain('/inventory?unit=unit-a101');
    // The booking and the lead each open their own record.
    expect(
      details?.querySelector('[data-qa="plot-booking-link"]')?.getAttribute('href'),
    ).toContain('/bookings/booking-1');
    expect(
      details?.querySelector('[data-qa="plot-booking-lead-link"]')?.getAttribute('href'),
    ).toContain('/leads/lead-1');
  });

  it('does not claim "no booking" when a held villa hides its booking', async () => {
    // RLS can hide a booking from the caller. The panel must say the booking is
    // not visible rather than assert there is none.
    const claim = claimFixture();
    mockPlotStatuses.rows = [
      { plotNumber: 20, status: 'booked', units: [{ ...claim, booking: null }] },
    ];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});

    const details = container?.querySelector('[data-qa="plot-details"]');
    expect(details?.textContent).toContain('not visible to you');
    expect(details?.textContent).not.toContain('No booking on this villa');
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

  it('selects a plot when it is clicked', async () => {
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    clickPlot(20);
    await act(async () => {});
    expect(container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')).toBe(
      PLOT_SELECTED_FILL
    );
    expect(container?.querySelector('[data-qa="plot-details"]')?.textContent).toContain('Plot 20');
  });

  it('deselects the plot when the SELECTED plot is clicked again', async () => {
    // The toggle: a second click on the already-selected plot clears the
    // selection, so the details panel empties and the plot goes back to its
    // status colour.
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();

    clickPlot(20);
    await act(async () => {});
    expect(container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')).toBe(
      PLOT_SELECTED_FILL
    );

    clickPlot(20);
    await act(async () => {});
    // Back to the status colour, and the panel is empty again.
    expect(container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')).toBe(
      PLOT_STATUS_FILL.booked
    );
    expect(html()).toContain('No plot selected');
  });

  it('selects the OTHER plot when a different plot is clicked', async () => {
    // The toggle is per-plot: clicking a second plot moves the selection
    // rather than clearing it.
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();

    clickPlot(20);
    await act(async () => {});
    clickPlot(21);
    await act(async () => {});

    expect(container?.querySelector('[data-plot-number="20"] polygon')?.getAttribute('fill')).toBe(
      PLOT_STATUS_FILL.booked
    );
    expect(container?.querySelector('[data-plot-number="21"] polygon')?.getAttribute('fill')).toBe(
      PLOT_SELECTED_FILL
    );
    expect(container?.querySelector('[data-qa="plot-details"]')?.textContent).toContain('Plot 21');
  });

  it('selects a plot found by search even when it was already selected', async () => {
    // Search is a "show me this plot" action, not a toggle: asking for the
    // plot you are already looking at must not empty the panel.
    mockPlotStatuses.rows = [{ plotNumber: 20, status: 'booked' }];
    await mount();
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});
    expect(container?.querySelector('[data-qa="plot-details"]')?.textContent).toContain('Plot 20');

    await typeInto(searchInput(), '');
    await typeInto(searchInput(), '20');
    click('[data-qa="plot-search-match-20"]');
    await act(async () => {});
    expect(container?.querySelector('[data-qa="plot-details"]')?.textContent).toContain('Plot 20');
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
