/**
 * Single source of truth for turning a natural-language "when" phrase into an
 * absolute timestamp. Used by the action executor (which stores reminders) and
 * by the alarm engine (which schedules them), so both agree on the same time.
 */

const UNIT_MS: Record<string, number> = {
  second: 1000, sec: 1000, s: 1000,
  minute: 60_000, min: 60_000, m: 60_000,
  hour: 3_600_000, hr: 3_600_000, h: 3_600_000,
  day: 86_400_000, d: 86_400_000,
  week: 604_800_000, w: 604_800_000,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function applyClock(d: Date, h: number, min: number, ampm?: string) {
  let hh = h;
  const ap = (ampm || "").toLowerCase();
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  d.setHours(hh, min, 0, 0);
}

/**
 * Parse a phrase into epoch ms. Returns null when it can't be understood —
 * callers must treat null as "unparseable" rather than inventing a time.
 */
export function parseWhen(raw: string | number, now: Date = new Date()): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  const input = (raw || "").trim();
  if (!input) return null;
  const s = input.toLowerCase().replace(/\s+/g, " ").replace(/^(?:on|at)\s+/, "");

  // Absolute ISO / Date-parsable strings first (what we persist).
  const iso = Date.parse(input);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|GMT|UTC|[A-Z][a-z]{2} \d/.test(input)) {
    return iso;
  }

  // "in 20 minutes", "in 2 hrs"
  let m = s.match(/^in (\d+(?:\.\d+)?) ?([a-z]+)$/);
  if (m) {
    const unit = m[2].replace(/s$/, "");
    const ms = UNIT_MS[unit];
    if (ms) return now.getTime() + Number(m[1]) * ms;
    return null;
  }

  // "in an hour" / "in a minute"
  m = s.match(/^in an? ([a-z]+)$/);
  if (m) {
    const ms = UNIT_MS[m[1].replace(/s$/, "")];
    if (ms) return now.getTime() + ms;
    return null;
  }

  const clock = "(\\d{1,2})(?::(\\d{2}))? ?(am|pm)?";

  // "today at 9", "at 21:30", "9pm"
  m = s.match(new RegExp(`^(?:today )?(?:at )?${clock}$`));
  if (m && (m[2] !== undefined || m[3] !== undefined || Number(m[1]) <= 24)) {
    const d = new Date(now);
    applyClock(d, Number(m[1]), Number(m[2] || 0), m[3]);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // "tomorrow", "tomorrow at 7:30am"
  m = s.match(new RegExp(`^tomorrow(?: (?:at )?${clock})?$`));
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (m[1]) applyClock(d, Number(m[1]), Number(m[2] || 0), m[3]);
    else d.setHours(9, 0, 0, 0);
    return d.getTime();
  }

  // "tonight at 8" / "tonight"
  m = s.match(new RegExp(`^tonight(?: (?:at )?${clock})?$`));
  if (m) {
    const d = new Date(now);
    if (m[1]) applyClock(d, Number(m[1]), Number(m[2] || 0), m[3] || "pm");
    else d.setHours(20, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // "monday", "next friday at 6pm"
  m = s.match(new RegExp(`^(?:next )?(${WEEKDAYS.join("|")})(?: (?:at )?${clock})?$`));
  if (m) {
    const target = WEEKDAYS.indexOf(m[1]);
    const d = new Date(now);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (/^next /.test(s) && delta < 7) delta += 0; // "next monday" === upcoming monday
    d.setDate(d.getDate() + delta);
    if (m[2]) applyClock(d, Number(m[2]), Number(m[3] || 0), m[4]);
    else d.setHours(9, 0, 0, 0);
    return d.getTime();
  }

  // Anything else Date can read (e.g. "March 3 2027 18:00")
  if (!Number.isNaN(iso)) return iso;
  return null;
}

/** Store form: ISO string when parseable, otherwise the raw phrase (never invented). */
export function normalizeWhen(raw: string, now: Date = new Date()): { iso: string; parsed: boolean; phrase: string } {
  const phrase = (raw || "").trim();
  const t = parseWhen(phrase, now);
  return t === null ? { iso: phrase, parsed: false, phrase } : { iso: new Date(t).toISOString(), parsed: true, phrase };
}

/** Human display for a stored `when` value. */
export function formatWhen(stored: string): string {
  const t = Date.parse(stored);
  if (Number.isNaN(t)) return stored;
  return new Date(t).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
