import { DataTableRowActions } from '@paalstack/react-ui';
import { LuEye, LuPencil, LuTrash2 } from '@paalstack/react-icons/lu';
import { z } from 'zod';

/**
 * The lead row's canonical shape. Keep in sync with the backend list
 * projection (apps/backend/src/leads/leads.service.ts LeadRow) and the
 * `leadRowSchema` used here for DataTableRowActions.
 */
export type LeadRow = {
  id: string;
  name: string;
  phone?: string;
  status?: string;
  source?: string;
  ownerName?: string;
  createdAt?: string;
  updatedAt?: string;
};

// Zod schema for DataTableRowActions (it parses row.original with it).
// Cast to the library's AnyZodObject shape (zod v4 vs the lib's v3-typed
// reference) - the schema itself is the source of truth for the row shape.
const leadRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  ownerName: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}) as unknown as Parameters<typeof DataTableRowActions>[0]['rowSchema'];

interface LeadRowActionsProps {
  row: { original: LeadRow };
  /** Whether the current user may delete (role-gated, D14). */
  canDelete: boolean;
  /** Called when the View action fires. */
  onView?: (row: LeadRow) => void;
  onEdit: (row: LeadRow) => void;
  onDelete: (row: LeadRow) => void;
  /** Accessible label for the actions trigger, e.g. `Actions for ${row.name}`. */
  ariaLabel?: string;
}

/**
 * Reusable row-actions menu for a lead table row: View / Edit / Delete.
 *
 * Wraps the library `DataTableRowActions` with the standard lead action
 * set (with icons), so every table that lists leads (inbox, assigned, etc.)
 * shares the same actions without copy-pasting the actionItems list.
 */
export function LeadRowActions({
  row,
  canDelete,
  onView,
  onEdit,
  onDelete,
  ariaLabel,
}: LeadRowActionsProps) {
  return (
    <div className="text-right">
      <DataTableRowActions
        row={row as unknown as Parameters<typeof DataTableRowActions>[0]['row']}
        rowSchema={leadRowSchema}
        ariaLabel={ariaLabel}
        actionItems={[
          { label: 'View', value: 'view', icon: LuEye, onClick: () => onView?.(row.original) },
          { label: 'Edit', value: 'edit', icon: LuPencil, onClick: () => onEdit(row.original) },
          {
            label: 'Delete',
            value: 'delete',
            icon: LuTrash2,
            onClick: () => onDelete(row.original),
          },
        ].filter((item) => item.value !== 'delete' || canDelete)}
      />
    </div>
  );
}
