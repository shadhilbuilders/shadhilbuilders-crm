// Calendar type definitions (vendored from lramos33/big-calendar, adapted
// to the shadhil-crm stack: Tailwind v4 + @paalstack/react-ui).

export type TCalendarView = 'day' | 'week' | 'month' | 'year' | 'agenda';
export type TEventColor =
  | 'blue'
  | 'green'
  | 'red'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'gray';
export type TBadgeVariant = 'dot' | 'colored' | 'mixed';
export type TWorkingHours = { [key: number]: { from: number; to: number } };
export type TVisibleHours = { from: number; to: number };
