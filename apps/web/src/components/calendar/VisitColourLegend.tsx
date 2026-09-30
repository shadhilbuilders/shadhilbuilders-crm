'use client';

/**
 * VisitColourLegend - the key for the visits calendar's colours.
 *
 * WHY IT EXISTS (2026-09-30): "I don't understand what each colors means in
 * visits page card." The calendar encodes the visit's outcome in colour and said
 * so nowhere - not on the card, not in the header, not in the dialog. A reader
 * had to infer green = good / red = bad and guess the rest. Colour as the ONLY
 * channel for a fact is an accessibility failure too (WCAG 1.4.1), but the plain
 * version of the complaint is that nobody was told.
 *
 * WHAT IT EXPLAINS. The visit's lifecycle status, which is what the CARD's colour
 * encodes (`visitStatusColor`). It deliberately does NOT explain the deal/lead
 * status - that is the dialog chip's axis (`leadStateTone`), and this component
 * labels itself as being about the visits so the two cannot be confused. That
 * confusion was the previous two bugs in this area; naming the axis is the fix.
 *
 * DERIVED FROM THE REAL MAPS (see `lib/past-event-style.ts`): the entries, their
 * order, their words and their tones all come from the same sources the calendar
 * paints from, so the key cannot drift from the picture.
 *
 * PLACEMENT: a disclosure under the calendar header rather than a permanent
 * block. It answers a question a new user asks once or twice, and 5 rows of
 * always-visible chrome above a calendar is a tax on every other visit. It is a
 * real button (keyboard reachable) and defaults to open the first time someone
 * sees it, because a legend nobody opens is the same as no legend.
 */
import { useState } from 'react';

import { Button } from '@paalstack/react-ui';
import { LuChevronDown, LuChevronUp } from '@paalstack/react-icons/lu';

import { VISIT_LEGEND, legendSwatchClass } from '@/lib/past-event-style';

export function VisitColourLegend({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div data-qa="visit-colour-legend">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-qa="visit-colour-legend-toggle"
        leftIcon={open ? <LuChevronUp className="size-4" /> : <LuChevronDown className="size-4" />}
      >
        What the colours mean
      </Button>

      {open ? (
        <ul
          className="border-border mt-2 flex flex-col gap-1.5 rounded-md border p-3 sm:flex-row sm:flex-wrap sm:gap-x-6"
          data-qa="visit-colour-legend-list"
        >
          {VISIT_LEGEND.map((entry) => (
            <li key={entry.status} className="flex items-center gap-2 text-xs">
              {/*
                The swatch is a filled dot, the same shape the cards use for
                their own dot - so the legend and the card look like the same
                thing. NOT colour-alone: every row carries its word and its
                sentence, which is the WCAG 1.4.1 requirement and also the whole
                point of the component.
              */}
              <span
                className={`size-2.5 shrink-0 rounded-full ${legendSwatchClass(entry.tone)}`}
                aria-hidden="true"
              />
              <span className="font-medium">{entry.label}</span>
              <span className="text-muted-foreground">{entry.meaning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
