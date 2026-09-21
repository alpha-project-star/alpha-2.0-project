import { 
  format, 
  isSameDay, 
  isTomorrow, 
  isValid
} from 'date-fns';
import { parseWhen } from './when';

/**
 * Robustly interpret a date/time string or number.
 * Delegates exclusively to canonical parseWhen to eliminate redundant temporal parsing logic.
 * Returns a Unix timestamp (ms) or null if invalid.
 */
export function interpretReminderDate(input: string | number, referenceDate: Date = new Date()): number | null {
  if (typeof input === 'number') {
    return isValid(new Date(input)) && input > 0 ? input : null;
  }
  return parseWhen(input, referenceDate);
}

/**
 * Standardized user-facing date/time formatter.
 * Returns a deterministic, friendly string.
 */
export function formatReminderDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (!isValid(date)) return 'Invalid Date';

  const now = new Date();
  
  if (isSameDay(date, now)) {
    return `Today at ${format(date, 'h:mm a')}`;
  }
  
  if (isTomorrow(date)) {
    return `Tomorrow at ${format(date, 'h:mm a')}`;
  }

  // For same year, omit year
  if (date.getFullYear() === now.getFullYear()) {
    return format(date, 'EEEE, MMM d @ h:mm a');
  }

  return format(date, 'MMM d, yyyy @ h:mm a');
}
