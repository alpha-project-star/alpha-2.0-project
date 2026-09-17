// src/lib/temporal.ts
let mockDate: Date | null = null;

export const temporal = {
  /** Returns the current timestamp. Can be mocked for testing. */
  now: () => mockDate || new Date(),
  
  /** Sets a fixed date for testing purposes. Pass null to restore real-time. */
  setMockDate: (d: Date | null) => { mockDate = d; },

  /** Returns the current timezone identifier (e.g., 'UTC' or device local) */
  getTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,

  /** Safely parse a date string or timestamp */
  parseDate: (d: string | number | Date) => {
    const date = new Date(d);
    return isNaN(date.getTime()) ? null : date;
  },

  /** Check if a target time has passed relative to now */
  isDue: (target: string | number | Date) => {
    const date = temporal.parseDate(target);
    if (!date) return false;
    return date <= temporal.now();
  }
};
