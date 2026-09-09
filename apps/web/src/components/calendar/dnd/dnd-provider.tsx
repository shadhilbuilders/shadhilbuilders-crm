'use client';

// DnD provider wrapper (vendored from lramos33/big-calendar). Wraps the
// calendar views in react-dnd's HTML5 backend so events can be dragged
// between time blocks / day cells.
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import { CustomDragLayer } from './custom-drag-layer';

interface DndProviderWrapperProps {
  children: React.ReactNode;
}

export function DndProviderWrapper({ children }: DndProviderWrapperProps) {
  return (
    <DndProvider backend={HTML5Backend}>
      {children}
      <CustomDragLayer />
    </DndProvider>
  );
}
