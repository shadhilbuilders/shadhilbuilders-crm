'use client';

// The interactive plot map.
//
// Rendering model: ONE `<svg>` whose `viewBox` is the visible window. The
// approved site plan is embedded as a vector `<image>` underneath 125 real
// `<polygon>` hit areas, so the drawing keeps its linework, dimensions and
// printed plot numbers while each plot stays an independent click target.
//
// Geometry and booking state are separate inputs: the polygons come from the
// traced layout, the colours from the merged booking records. A future API
// response repaints this without a coordinate moving.

import { Button, Empty } from '@paalstack/react-ui';
import { LuMaximize, LuMinus, LuPlus } from '@paalstack/react-icons/lu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PLOT_CATEGORY_LABEL, PLOT_STATUS_LABEL, PLOT_SELECTED_STROKE } from './plot-colors';
import { PLAN_VIEWBOX, PLAN_SOURCE } from './plot-geometry';
import { findNeighbour, type PlotDirection } from './plot-navigation';
import { polygonCentroid } from './plot-shapes';
import type { Plot, PlotVertex } from './plot-types';
import { usePlotViewport } from './use-plot-viewport';
import { PlotPolygon } from './PlotPolygon';

export interface PlotMapProps {
  /** Every plot on the layout. */
  plots: readonly Plot[];
  /** Plot numbers that match the active search/filter. Others render dimmed. */
  matchingNumbers: ReadonlySet<number>;
  selectedPlotNumber: number | null;
  onSelect: (plotNumber: number) => void;
  /**
   * Bump `nonce` to ask the map to centre on a plot (search, filter chips).
   * A counter rather than a bare number so asking for the same plot twice
   * still recentres.
   */
  focusRequest?: { plotNumber: number; nonce: number } | null;
}

/** Movement (px) beyond which a pointer gesture counts as a pan, not a click. */
const DRAG_THRESHOLD_PX = 4;
/** Tooltip/label text size in screen pixels; scaled into plan units per zoom. */
const LABEL_SCREEN_PX = 9;
const LABEL_PADDING_SCREEN_PX = 4;
/** Rough advance width per character at LABEL_SCREEN_PX, used to size the pill. */
const LABEL_CHAR_WIDTH_RATIO = 0.55;

interface GestureState {
  moved: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  pinchDistance: number | null;
  /** Plot captured on pointerdown - pointer capture means pointerup targets the svg. */
  pressedPlotNumber: number | null;
}

function emptyGesture(): GestureState {
  return {
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    pinchDistance: null,
    pressedPlotNumber: null,
  };
}

/**
 * Convert a client (screen) point into plan coordinates.
 *
 * Uses the SVG's own CTM inverse so letterboxing from `preserveAspectRatio`
 * and any future transform are handled for us. Returns null in environments
 * without SVG geometry APIs (jsdom), where callers fall back to the centre.
 */
function clientToPlan(svg: SVGSVGElement, clientX: number, clientY: number): PlotVertex | null {
  if (typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') {
    return null;
  }
  const matrix = svg.getScreenCTM();
  if (matrix === null) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function arrowDirection(key: string): PlotDirection | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

export function PlotMap({
  plots,
  matchingNumbers,
  selectedPlotNumber,
  onSelect,
  focusRequest = null,
}: PlotMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<GestureState>(emptyGesture());
  const [hoveredPlotNumber, setHoveredPlotNumber] = useState<number | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const { viewBox, zoom, zoomByFactor, panByPlanUnits, centreOn, reset, atMinZoom, atMaxZoom } =
    usePlotViewport();

  const planCentre = useMemo<PlotVertex>(
    () => ({
      x: PLAN_VIEWBOX.x + PLAN_VIEWBOX.width / 2,
      y: PLAN_VIEWBOX.y + PLAN_VIEWBOX.height / 2,
    }),
    []
  );

  /** Screen-pixel scale: 1 plan unit is this many screen units at the current zoom. */
  const labelFontSize = LABEL_SCREEN_PX * (viewBox.width / PLAN_VIEWBOX.width);
  const labelPadding = LABEL_PADDING_SCREEN_PX * (viewBox.width / PLAN_VIEWBOX.width);

  const anchorFor = useCallback(
    (clientX: number, clientY: number): PlotVertex => {
      const svg = svgRef.current;
      if (svg === null) return planCentre;
      return clientToPlan(svg, clientX, clientY) ?? planCentre;
    },
    [planCentre]
  );

  const zoomByStep = useCallback(
    (factor: number) => zoomByFactor(factor, planCentre),
    [planCentre, zoomByFactor]
  );

  // Wheel zoom needs a non-passive listener: React's synthetic onWheel cannot
  // call preventDefault, so the page would scroll while the user zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const anchor = clientToPlan(svg, event.clientX, event.clientY) ?? planCentre;
      zoomByFactor(Math.exp(-event.deltaY * 0.0015), anchor);
    };
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [planCentre, zoomByFactor]);

  // Centre on a plot that was found by search or a filter chip.
  const focusPlotNumber = focusRequest?.plotNumber ?? null;
  const focusNonce = focusRequest?.nonce ?? 0;
  useEffect(() => {
    if (focusPlotNumber === null) return;
    const target = plots.find((plot) => plot.plotNumber === focusPlotNumber);
    if (target === undefined) return;
    centreOn(polygonCentroid(target.boundary));
  }, [centreOn, focusNonce, focusPlotNumber, plots]);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const svg = event.currentTarget;
    if (typeof svg.setPointerCapture === 'function') {
      svg.setPointerCapture(event.pointerId);
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 1) {
      const target = event.target as Element | null;
      const pressed = target?.closest('[data-plot-number]')?.getAttribute('data-plot-number');
      gestureRef.current = {
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        pinchDistance: null,
        pressedPlotNumber: pressed === null || pressed === undefined ? null : Number(pressed),
      };
    } else {
      // A second finger means a pinch: never a click.
      gestureRef.current.moved = true;
      gestureRef.current.pressedPlotNumber = null;
      gestureRef.current.pinchDistance = null;
    }
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = gestureRef.current;
      const points = [...pointersRef.current.values()];
      const svg = event.currentTarget;

      if (points.length >= 2) {
        const [first, second] = points;
        if (first === undefined || second === undefined) return;
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        const midpoint = anchorFor((first.x + second.x) / 2, (first.y + second.y) / 2);
        if (gesture.pinchDistance !== null && gesture.pinchDistance > 0) {
          zoomByFactor(distance / gesture.pinchDistance, midpoint);
        }
        gesture.pinchDistance = distance;
        return;
      }

      const dxScreen = event.clientX - gesture.lastX;
      const dyScreen = event.clientY - gesture.lastY;
      if (
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >
        DRAG_THRESHOLD_PX
      ) {
        gesture.moved = true;
      }
      if (gesture.moved) {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          panByPlanUnits(
            (dxScreen * viewBox.width) / rect.width,
            (dyScreen * viewBox.height) / rect.height
          );
        }
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
    },
    [anchorFor, panByPlanUnits, viewBox.height, viewBox.width, zoomByFactor]
  );

  const endPointer = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const gesture = gestureRef.current;
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size > 0) return;

      const pressed = gesture.pressedPlotNumber;
      const wasClick = !gesture.moved;
      gestureRef.current = emptyGesture();
      // Click and drag are the same gesture until the threshold is crossed, so
      // selection is decided here rather than in the polygon's onClick - that
      // is what lets panning run right through a plot without selecting it.
      if (wasClick && pressed !== null && matchingNumbers.has(pressed)) {
        onSelect(pressed);
      }
    },
    [matchingNumbers, onSelect]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      const direction = arrowDirection(event.key);
      if (direction !== null) {
        const navigable = plots.filter((plot) => matchingNumbers.has(plot.plotNumber));
        if (navigable.length === 0) return;
        const origin =
          selectedPlotNumber !== null && matchingNumbers.has(selectedPlotNumber)
            ? selectedPlotNumber
            : navigable[0]?.plotNumber;
        if (origin === undefined) return;
        event.preventDefault();
        const next = findNeighbour(navigable, origin, direction) ?? origin;
        onSelect(next);
        const nextPlot = plots.find((plot) => plot.plotNumber === next);
        if (nextPlot !== undefined) centreOn(polygonCentroid(nextPlot.boundary));
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomByStep(1.4);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomByStep(1 / 1.4);
      } else if (event.key === '0') {
        event.preventDefault();
        reset();
      }
    },
    [centreOn, matchingNumbers, onSelect, plots, reset, selectedPlotNumber, zoomByStep]
  );

  const selectedPlot = useMemo(
    () => plots.find((plot) => plot.plotNumber === selectedPlotNumber) ?? null,
    [plots, selectedPlotNumber]
  );
  const hoveredPlot = useMemo(
    () => plots.find((plot) => plot.plotNumber === hoveredPlotNumber) ?? null,
    [hoveredPlotNumber, plots]
  );

  // The hovered plot wins while hovering; otherwise the selection keeps its
  // badge so a user who clicked can still read which plot is active.
  const badgePlot = hoveredPlot ?? selectedPlot;
  const badgeTone = hoveredPlot !== null ? 'hover' : 'selected';

  if (plots.length === 0) {
    return (
      <Empty
        className="border-border bg-muted/30 rounded-lg border"
        title="No plot geometry"
        description="The layout drawing has not been traced for this project yet."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="border-border bg-background relative overflow-hidden rounded-lg border">
        <svg
          ref={svgRef}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          preserveAspectRatio="xMidYMid meet"
          // A single tab stop: arrow keys then walk the layout. 125 individual
          // tab stops would make the page unusable by keyboard.
          tabIndex={0}
          role="group"
          aria-label="Residential plot layout. Use arrow keys to move between plots, plus and minus to zoom, zero to reset."
          className="bg-background focus-visible:ring-ring/50 block w-full touch-none select-none focus-visible:ring-2 focus-visible:outline-none"
          style={{ aspectRatio: `${PLAN_VIEWBOX.width} / ${PLAN_VIEWBOX.height}`, cursor: 'grab' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onKeyDown={handleKeyDown}
          data-qa="plot-map"
        >
          <title>CMDA approved layout - {PLAN_SOURCE.title}</title>
          <g data-qa="plot-map-background">
            <image
              href="/cmda-plan.svg"
              x={PLAN_VIEWBOX.x}
              y={PLAN_VIEWBOX.y}
              width={PLAN_VIEWBOX.width}
              height={PLAN_VIEWBOX.height}
              onError={() => setImageFailed(true)}
              style={{ pointerEvents: 'none' }}
            />
          </g>

          <g data-qa="plot-map-hit-areas">
            {plots.map((plot) => (
              <PlotPolygon
                key={plot.id}
                plot={plot}
                selected={plot.plotNumber === selectedPlotNumber}
                hovered={plot.plotNumber === hoveredPlotNumber}
                dimmed={!matchingNumbers.has(plot.plotNumber)}
                statusLabel={PLOT_STATUS_LABEL[plot.status]}
                categoryLabel={PLOT_CATEGORY_LABEL[plot.category]}
                onSelect={onSelect}
                onHoverChange={setHoveredPlotNumber}
              />
            ))}
          </g>

          {badgePlot !== null ? (
            <g
              transform={`translate(${polygonCentroid(badgePlot.boundary).x} ${polygonCentroid(badgePlot.boundary).y})`}
              style={{ pointerEvents: 'none' }}
              data-qa={badgeTone === 'hover' ? 'plot-tooltip' : 'plot-selected-badge'}
            >
              <rect
                x={
                  -(
                    (`Plot ${badgePlot.plotNumber} - ${PLOT_STATUS_LABEL[badgePlot.status]}`
                      .length *
                      LABEL_SCREEN_PX *
                      LABEL_CHAR_WIDTH_RATIO) /
                      2 +
                    labelPadding
                  )
                }
                y={-(labelFontSize / 2 + labelPadding)}
                width={
                  `Plot ${badgePlot.plotNumber} - ${PLOT_STATUS_LABEL[badgePlot.status]}`.length *
                    LABEL_SCREEN_PX *
                    LABEL_CHAR_WIDTH_RATIO +
                  labelPadding * 2
                }
                height={labelFontSize + labelPadding * 2}
                rx={labelPadding}
                fill={badgeTone === 'hover' ? '#0F172A' : PLOT_SELECTED_STROKE}
                fillOpacity={0.92}
                stroke="none"
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={labelFontSize}
                fill="#FFFFFF"
              >
                {`Plot ${badgePlot.plotNumber} - ${PLOT_STATUS_LABEL[badgePlot.status]}`}
              </text>
            </g>
          ) : null}
        </svg>

        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Zoom in"
            data-qa="plot-map-zoom-in"
            disabled={atMaxZoom}
            onClick={() => zoomByStep(1.5)}
          >
            <LuPlus />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Zoom out"
            data-qa="plot-map-zoom-out"
            disabled={atMinZoom}
            onClick={() => zoomByStep(1 / 1.5)}
          >
            <LuMinus />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Reset zoom and pan"
            data-qa="plot-map-reset"
            disabled={atMinZoom}
            onClick={reset}
          >
            <LuMaximize />
          </Button>
        </div>

        <p className="bg-background/85 text-muted-foreground pointer-events-none absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[11px]">
          {`${zoom.toFixed(1)}x`}
        </p>
      </div>

      {imageFailed ? (
        <p className="text-destructive text-xs" role="alert" data-qa="plot-map-artwork-error">
          The layout artwork failed to load, so plot outlines are shown without the drawing. Plot
          shapes and selection still work.
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Drag to pan, scroll or pinch to zoom. Click a plot to select it; arrow keys move between
        plots. Zoom keeps the drawing at full resolution, so the printed dimensions stay readable.
      </p>
    </div>
  );
}
