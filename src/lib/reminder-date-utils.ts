import { 
  addHours, 
  addDays, 
  addWeeks, 
  format, 
  isSameDay, 
  isTomorrow, 
  parse, 
  setHours, 
  setMinutes, 
  startOfDay,
  isValid
} from 'date-fns';

/**
 * Robustly interpret a date/time string or number.
 * Returns a Unix timestamp (ms) or null if invalid.
 */
export function interpretReminderDate(input: string | number, referenceDate: Date): number | null {
  if (typeof input === 'number') {
    return isValid(new Date(input)) ? input : null;
  }

  const text = input.toLowerCase().trim();
  if (!text) return null;

  // 0. ISO or other standard formats (check this first before greedy regex)
  const parsed = new Date(input);
  if (isValid(parsed) && !(/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(text))) {
    // Only use Date constructor if it's not a simple time string that Date() might misinterpret
    // or if it's a clear ISO-like string
    if (text.includes('-') || text.includes('/') || text.includes('t')) {
       return parsed.getTime();
    }
  }

  // 1. Relative "in X hours/days"
  const relativeMatch = text.match(/^in (\d+) (hour|minute|day|week)s?$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    if (unit === 'hour') return addHours(referenceDate, amount).getTime();
    if (unit === 'minute') return (referenceDate.getTime() + amount * 60000);
    if (unit === 'day') return addDays(referenceDate, amount).getTime();
    if (unit === 'week') return addWeeks(referenceDate, amount).getTime();
  }

  // 2. Simple keywords
  if (text === 'tomorrow') return addDays(startOfDay(referenceDate), 1).getTime();
  if (text === 'today') return startOfDay(referenceDate).getTime(); 

  // 3. Time patterns (e.g. "3 PM", "15:30")
  const timeMatch = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3];

    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    let target = setMinutes(setHours(referenceDate, hours), minutes);
    
    // If it's "3 PM" and it's already 4 PM, assume tomorrow
    if (target < referenceDate) {
       target = addDays(target, 1);
    }
    
    return target.getTime();
  }

  // 3b. Day of week patterns (e.g. "Monday", "Monday at 9 AM")
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = days.findIndex(d => text.includes(d));
  if (dayMatch !== -1) {
    const currentDay = referenceDate.getDay();
    let dayDelta = dayMatch - currentDay;
    if (dayDelta <= 0) dayDelta += 7;
    const targetDayDate = addDays(startOfDay(referenceDate), dayDelta);
    
    // Check if there's a time part
    const timePart = text.replace(days[dayMatch], '').replace('at', '').trim();
    if (timePart) {
      const timeRes = interpretReminderDate(timePart, referenceDate);
      if (timeRes) {
        const tDate = new Date(timeRes);
        return setMinutes(setHours(targetDayDate, tDate.getHours()), tDate.getMinutes()).getTime();
      }
    }
    return targetDayDate.getTime();
  }

  // 4. Combined "tomorrow at 3 PM"
  if (text.includes('tomorrow')) {
     const subTime = text.replace('tomorrow', '').replace('at', '').trim();
     const timeRes = interpretReminderDate(subTime || "09:00", referenceDate);
     if (timeRes) {
        const d = new Date(timeRes);
        return addDays(setMinutes(setHours(startOfDay(referenceDate), d.getHours()), d.getMinutes()), 1).getTime();
     }
  }

  return null;
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
