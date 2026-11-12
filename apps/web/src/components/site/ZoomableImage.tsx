'use client';

// ZoomableImage: a controllable full-size image surface.
//
// Zoom in/out buttons, mouse wheel, pinch, double-tap/click to toggle, drag to
// pan while zoomed. State is local and reset by remounting (`key` on the photo).
// Plain <img>: the media URL is a cookie-authenticated BFF route.
import { useCallback, useEffect, useRef, useState } from 'react';

import { IconButton } from '@paalstack/react-ui';
import { LuMaximize, LuZoomIn, LuZoomOut } from '@paalstack/react-icons/lu';

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
const STEP = 0.5;

type View = { scale: number; x: number; y: number };
const INITIAL: View = { scale: MIN_SCALE, x: 0, y: 0 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Keep the image from being dragged fully out of the frame. */
export function clampPan(view: View, width: number, height: number): View {
  const maxX = (width * (view.scale - 1)) / 2;
  const maxY = (height * (view.scale - 1)) / 2;
  return {
    scale: view.scale,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}

const SWIPE_MIN_PX = 60;

/** Which neighbour a one-finger horizontal flick asks for. Only at 1x: when
 *  zoomed, a horizontal drag is a pan, never a page turn. */
export function swipeDirection(dx: number, dy: number, scale: number): 'next' | 'previous' | null {
  if (scale > MIN_SCALE) return null;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * 0.6) return null;
  return dx < 0 ? 'next' : 'previous';
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function ZoomableImage({
  src,
  alt,
  onSwipe,
}: {
  src: string;
  alt: string;
  /** Optional: a one-finger horizontal flick at 1x asks for a neighbour. */
  onSwipe?: (direction: 'next' | 'previous') => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>(INITIAL);

  const applyScale = useCallback((next: number) => {
    const frame = frameRef.current;
    const w = frame?.clientWidth ?? 0;
    const h = frame?.clientHeight ?? 0;
    setView((v) => {
      const scale = clampScale(next);
      return scale === MIN_SCALE ? INITIAL : clampPan({ ...v, scale }, w, h);
    });
  }, []);

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setView((v) => {
        const scale = clampScale(v.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
        return scale === MIN_SCALE
          ? INITIAL
          : clampPan({ ...v, scale }, frame.clientWidth, frame.clientHeight);
      });
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    swipeStart.current =
      pointers.current.size === 1 ? { x: event.clientX, y: event.clientY } : null;
    if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        applyScale(view.scale > MIN_SCALE ? MIN_SCALE : 2.5);
        lastTap.current = 0;
      } else {
        lastTap.current = now;
      }
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const prev = pointers.current.get(event.pointerId);
    if (prev === undefined) return;
    const next = { x: event.clientX, y: event.clientY };
    const frame = frameRef.current;
    const w = frame?.clientWidth ?? 0;
    const h = frame?.clientHeight ?? 0;

    if (pointers.current.size === 2) {
      const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other !== undefined) {
        const ratio = distance(next, other) / Math.max(1, distance(prev, other));
        setView((v) => {
          const scale = clampScale(v.scale * ratio);
          return scale === MIN_SCALE ? INITIAL : clampPan({ ...v, scale }, w, h);
        });
      }
    } else if (view.scale > MIN_SCALE) {
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      setView((v) => clampPan({ ...v, x: v.x + dx, y: v.y + dy }, w, h));
    }
    pointers.current.set(event.pointerId, next);
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = swipeStart.current;
    if (start !== null && event.type === 'pointerup' && pointers.current.size === 1) {
      const direction = swipeDirection(
        event.clientX - start.x,
        event.clientY - start.y,
        view.scale,
      );
      if (direction !== null) onSwipe?.(direction);
    }
    swipeStart.current = null;
    pointers.current.delete(event.pointerId);
  };

  const zoomed = view.scale > MIN_SCALE;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" data-qa="site-photo-zoom">
      <div
        ref={frameRef}
        className="flex size-full items-center justify-center overscroll-contain select-none"
        style={{ touchAction: 'none', cursor: zoomed ? 'grab' : 'zoom-in' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: pointers.current.size === 0 ? 'transform 120ms ease-out' : 'none',
          }}
          data-qa="site-photo-full"
        />
      </div>

      <div
        className="bg-background/90 border-border absolute right-3 bottom-3 flex gap-1 rounded-lg border p-1 shadow-sm"
        role="group"
        aria-label="Zoom controls"
      >
        <IconButton
          type="button"
          variant="ghost"
          className="size-11"
          icon={<LuZoomOut className="size-5" aria-hidden="true" />}
          aria-label="Zoom out"
          disabled={view.scale <= MIN_SCALE}
          onClick={() => applyScale(view.scale - STEP)}
          data-qa="site-photo-zoom-out"
        />
        <IconButton
          type="button"
          variant="ghost"
          className="size-11"
          icon={<LuMaximize className="size-5" aria-hidden="true" />}
          aria-label="Reset zoom"
          disabled={!zoomed}
          onClick={() => applyScale(MIN_SCALE)}
          data-qa="site-photo-zoom-reset"
        />
        <IconButton
          type="button"
          variant="ghost"
          className="size-11"
          icon={<LuZoomIn className="size-5" aria-hidden="true" />}
          aria-label="Zoom in"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => applyScale(view.scale + STEP)}
          data-qa="site-photo-zoom-in"
        />
      </div>
    </div>
  );
}
