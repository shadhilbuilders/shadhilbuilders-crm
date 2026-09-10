// Shared formatting helpers - the single source of truth for currency,
// date, and number formatting across the app.
//
// Convention (user-mandated): use the @paalstack/react-ui/lib intl helpers
// (currencyIntl / dateIntl / numberIntl) for ALL currency/date/number
// formatting - never hand-rolled Intl.NumberFormat / toLocaleDateString.
//
// The library's default singletons are USD / MM/dd/yyyy (en-US). This app is
// Indian (INR, en-IN), so we construct configured instances here and export
// them. Consumers import from '@/lib/format' instead of the library directly.
import { enIN } from 'date-fns/locale';
import {
  CurrencyIntl,
  DateIntl,
  NumberIntl,
} from '@paalstack/react-ui/lib';

/** Indian-rupee currency formatter (₹58,00,000.00). */
export const currencyIntl = new CurrencyIntl({
  locale: 'en-IN',
  currency: 'INR',
  fallback: '-',
});

/** Indian date/time formatter (dd/MM/yyyy, 12h clock). */
export const dateIntl = new DateIntl({
  locale: enIN,
  dateFormat: 'dd/MM/yyyy',
  dateTimeFormat: 'dd/MM/yyyy hh:mm a',
  fallback: '-',
});

/** Indian number formatter (12,34,567). */
export const numberIntl = new NumberIntl({
  locale: 'en-IN',
  fallback: '-',
});
