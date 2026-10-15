'use client';

// Zoom + pan for the plot map.
//
// Zoom drives the SVG `viewBox` rather than a CSS transform on purpose. The
// plan is vector artwork: scaling the viewBox makes the browser re-render the
// linework and the printed dimensions at every zoom level, so labels stay
// sharp. A CSS `scale()` transform on an embedded SVG is re-rasterised from
// the pre-transform bitmap in several browsers, which turns a zoomed-in plan
// into a blurry one - exactly what "don't obscure the labels" rules out.
//
// The viewport is described by `zoom` + a top-left origin, and the aspect
// ratio is locked to the plan's, so the drawing can never be stretched.

import { useCallback, useMemo, useState } from 'react';

import { PLAN_VIEWBOX } from './plot-geometry';
import type { PlotVertex } from './plot-types';

export interface PlotViewport {
  /** 1 = the whole plan fills the map. */
  zoom: number;
  /** Top-left of the visible window, in plan coordinates. */
  x: number;
  y: number;
}

export interface PlotViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_PLOT_ZOOM = 1;
export const MAX_PLOT_ZOOM = 16;

/** The plan's aspect ratio - locked so zoom can never distort the drawing. */
const PLAN_ASPECT = PLAN_VIEWBOX.height / PLAN_VIEWBOX.width;

const DEFAULT_VIEWPORT: PlotViewport = {
  zoom: MIN_PLOT_ZOOM,
  x: PLAN_VIEWBOX.x,
  y: PLAN_VIEWBOX.y,
};

/** The visible window for a viewport state. */
export function viewBoxFor(viewport: PlotViewport): PlotViewBox {
  const width = PLAN_VIEWBOX.width / viewport.zoom;
  return { x: viewport.x, y: viewport.y, width, height: width * PLAN_ASPECT };
}

/**
 * Keep the viewport inside the plan and inside the zoom range. Clamping the
 * origin (rather than allowing free panning) is what stops a user dragging
 * the layout off-screen into empty space with no way back.
 */
export function clampViewport(viewport: PlotViewport): PlotViewport {
  const zoom = Math.min(Math.max(viewport.zoom, MIN_PLOT_ZOOM), MAX_PLOT_ZOOM);
  const width = PLAN_VIEWBOX.width / zoom;
  const height = width * PLAN_ASPECT;
  const maxX = PLAN_VIEWBOX.x + PLAN_VIEWBOX.width - width;
  const maxY = PLAN_VIEWBOX.y + PLAN_VIEWBOX.height - height;
  return {
    zoom,
    x: Math.min(Math.max(viewport.x, PLAN_VIEWBOX.x), maxX),
    y: Math.min(Math.max(viewport.y, PLAN_VIEWBOX.y), maxY),
  };
}

/** Multiply the zoom by `factor`, keeping `anchor` (plan coords) stationary. */
export function zoomAtPoint(
  viewport: PlotViewport,
  factor: number,
  anchor: PlotVertex
): PlotViewport {
  const zoom = Math.min(Math.max(viewport.zoom * factor, MIN_PLOT_ZOOM), MAX_PLOT_ZOOM);
  const ratio = zoom / viewport.zoom;
  if (ratio === 1) return viewport;
  return {
    zoom,
    x: anchor.x - (anchor.x - viewport.x) / ratio,
    y: anchor.y - (anchor.y - viewport.y) / ratio,
  };
}

/** Centre the visible window on a point at the given zoom. */
export function centreOnPoint(point: PlotVertex, zoom: number): PlotViewport {
  const nextZoom = Math.min(Math.max(zoom, MIN_PLOT_ZOOM), MAX_PLOT_ZOOM);
  const width = PLAN_VIEWBOX.width / nextZoom;
  const height = width * PLAN_ASPECT;
  return { zoom: nextZoom, x: point.x - width / 2, y: point.y - height / 2 };
}

export interface UsePlotViewportResult {
  viewBox: PlotViewBox;
  zoom: number;
  zoomByFactor: (factor: number, anchor: PlotVertex) => void;
  panByPlanUnits: (dx: number, dy: number) => void;
  centreOn: (point: PlotVertex, zoom?: number) => void;
  reset: () => void;
  atMinZoom: boolean;
  atMaxZoom: boolean;
}

/** Zoom level used when jumping to a plot from the search box or the keyboard. */
export const FOCUS_ZOOM = 5;

export function usePlotViewport(): UsePlotViewportResult {
  const [viewport, setViewport] = useState<PlotViewport>(DEFAULT_VIEWPORT);

  const zoomByFactor = useCallback((factor: number, anchor: PlotVertex) => {
    setViewport((current) => clampViewport(zoomAtPoint(current, factor, anchor)));
  }, []);

  const panByPlanUnits = useCallback((dx: number, dy: number) => {
    setViewport((current) => clampViewport({ ...current, x: current.x - dx, y: current.y - dy }));
  }, []);

  const centreOn = useCallback((point: PlotVertex, zoom?: number) => {
    // Centre at an explicit zoom, or keep the user's current zoom when they
    // are already zoomed in past the focus level.
    setViewport((current) =>
      clampViewport(centreOnPoint(point, zoom ?? Math.max(current.zoom, FOCUS_ZOOM)))
    );
  }, []);

  const reset = useCallback(() => setViewport(DEFAULT_VIEWPORT), []);

  const viewBox = useMemo(() => viewBoxFor(viewport), [viewport]);

  return {
    viewBox,
    zoom: viewport.zoom,
    zoomByFactor,
    panByPlanUnits,
    centreOn,
    reset,
    atMinZoom: viewport.zoom <= MIN_PLOT_ZOOM + 1e-6,
    atMaxZoom: viewport.zoom >= MAX_PLOT_ZOOM - 1e-6,
  };
}
