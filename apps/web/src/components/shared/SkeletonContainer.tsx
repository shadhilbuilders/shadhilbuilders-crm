'use client';

// SkeletonContainer - cross-fade between a skeleton and real content.
//
// T17 (PR2). CEO cherry-pick: the page should feel "alive" instead of
// popping from skeleton to content. The fade is CSS-only - no hook,
// no setTimeout. The classes are exported as constants so the T33
// computed-style test can pin `transitionDuration === '200ms'`.
//
// Layered-opacity pattern:
//
//   ┌─ wrapper (transition-opacity duration-200) ───────────────┐
//   │                                                          │
//   │  ┌─ skeleton layer (opacity-100 if isLoading else 0) ─┐  │
//   │  │  <Skeleton variant=… />                            │  │
//   │  └────────────────────────────────────────────────────┘  │
//   │  ┌─ content layer (opacity-0 if isLoading else 100) ───┐  │
//   │  │  {children}                                          │  │
//   │  └──────────────────────────────────────────────────────┘  │
//   └──────────────────────────────────────────────────────────┘
//
// `motion-reduce:transition-none` honors the OS reduce-motion pref.
// Both layers stay mounted (no remount) so the wrapper's transition
// fires when `isLoading` flips. The skeleton layer is optional -
// when callers don't pass it, only the content layer renders.
import type { ReactNode } from 'react';

import { cn } from '@paalstack/react-ui/lib';

import { Skeleton, type ChartDataHint, type SkeletonVariant } from './Skeleton';

// ---------------------------------------------------------------------------
// Class strings - exported so the T33 computed-style test can pin them.
// (See apps/web/src/components/shared/skeleton-container.test.ts.)
// ---------------------------------------------------------------------------

/** Applied to the wrapper so both child layers transition in lock-step. */
export const SKELETON_CONTAINER_WRAPPER_CLASSES =
  'transition-opacity duration-200 motion-reduce:transition-none';

/** Applied to BOTH child layers so the active one is opaque. */
export const SKELETON_CONTAINER_LAYER_CLASSES =
  'transition-opacity duration-200 motion-reduce:transition-none';

export type SkeletonContainerProps = {
  /** When true, the skeleton is opaque and the children are hidden. */
  isLoading: boolean;
  /** Real content. Rendered at opacity 0 while `isLoading`, opacity 100 after. */
  children: ReactNode;
  /** When provided AND isLoading, render a Skeleton above the children. */
  skeleton?:
    | {
        variant: SkeletonVariant;
        /** T34: only consulted when variant="chart". */
        dataHint?: ChartDataHint;
        /** Override the default shape count. */
        count?: number;
      }
    | undefined;
  /** ARIA live region politeness for the content layer. */
  ariaLive?: 'polite' | 'assertive' | 'off';
  /** Extra class on the wrapper. */
  className?: string;
};

/**
 * Wrap a piece of UI that has a loading state. The wrapper applies
 * the cross-fade transition; the two child layers switch opacity
 * based on `isLoading`.
 */
export function SkeletonContainer({
  isLoading,
  children,
  skeleton,
  ariaLive = 'polite',
  className,
}: SkeletonContainerProps) {
  return (
    <div
      className={cn(SKELETON_CONTAINER_WRAPPER_CLASSES, className)}
      data-skeleton-container={isLoading ? 'loading' : 'ready'}
      data-qa="skeleton-container"
    >
      {skeleton !== undefined ? (
        <div
          aria-hidden={!isLoading}
          className={cn(
            SKELETON_CONTAINER_LAYER_CLASSES,
            isLoading ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          data-qa="skeleton-container-skeleton"
        >
          <Skeleton
            variant={skeleton.variant}
            count={skeleton.count}
            dataHint={skeleton.dataHint}
          />
        </div>
      ) : null}

      <div
        aria-busy={isLoading}
        aria-live={ariaLive}
        className={cn(
          SKELETON_CONTAINER_LAYER_CLASSES,
          isLoading ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        data-qa="skeleton-container-content"
      >
        {children}
      </div>
    </div>
  );
}
