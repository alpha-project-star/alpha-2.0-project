import { alphaStore, uid, getStorage, PersistenceError } from "./alpha-store";
import { speakWith, prepareUtterance } from "./voice";
import { getAuth } from "firebase/auth";
import {
  FirestoreReminderRepository,
  type FirestoreReminder,
  type ReminderRepository,
} from "./reminder-repo";

/**
 * Proactive daemon — Alpha initiates.
 *
 *  • Daily morning brief (5am–11am local) — weather-agnostic summary of
 *    today's tasks, unfired reminders, and overdue bills.
 *  • Overdue-bill nudge — first tick after boot if any bills are past due
 *    and haven't been nudged today.
 *  • Today's tasks nudge — when a task's date is today and hasn't been
 *    mentioned yet.
 *
 * Runs entirely client-side. Speaks via the existing TTS pipeline and
 * drops a `model` message into chat so the interaction is visible.
 */

const LS_LAST_BRIEF = "alpha.proactive.lastBrief";
const LS_LAST_BILLS = "alpha.proactive.lastBillsNudge";
const LS_LAST_PLANS = "alpha.proactive.lastPlansNudge";

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function readOnce(key: string): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(key) === todayKey()) return false;
    storage.setItem(key, todayKey());
    return true;
  } catch (err) {
    if (err && typeof err === "object" && (err as any).name === "PersistenceError") {
      throw err;
    }
    throw new PersistenceError(key, err);
  }
}

function speakAndLog(line: string) {
  if (!line.trim()) return;
  prepareUtterance();
  alphaStore.appendChat({ id: uid(), role: "model", text: line, ts: Date.now() });
  void speakWith(line);
}

export interface MorningBriefOptions {
  userId?: string | null;
  repo?: ReminderRepository;
  reminders?: FirestoreReminder[];
  now?: Date;
}

export async function buildMorningBrief(options?: MorningBriefOptions): Promise<string> {
  const s = alphaStore.get();
  const now = options?.now || new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const name = s.profile.name || "Alex";

  let remindersList: FirestoreReminder[] = [];
  let reminderRepoFailed = false;

  if (options?.reminders) {
    remindersList = options.reminders;
  } else {
    const userId = options?.userId ?? (getAuth().currentUser?.uid || null);
    if (userId) {
      try {
        const repo = options?.repo ?? new FirestoreReminderRepository();
        remindersList = await repo.listReminders(userId);
      } catch (err) {
        reminderRepoFailed = true;
        console.error("Proactive morning brief failed to read canonical reminders", err);
      }
    } else if (options?.repo) {
      try {
        remindersList = await options.repo.listReminders("anonymous");
      } catch (err) {
        reminderRepoFailed = true;
      }
    }
  }

  // Canonical reminder due filtering: active state, not accepted notification, within today's time window
  const dueToday = remindersList.filter((r) => {
    if (r.reminderState === "completed" || r.reminderState === "cancelled") return false;
    if (r.notificationState === "accepted") return false;
    const t = r.dueAt;
    return typeof t === "number" && !Number.isNaN(t) && t >= startOfDay.getTime() && t <= endOfDay.getTime();
  });

  const overdueBills = s.bills.filter((b) => {
    if (b.status === "paid") return false;
    const t = Date.parse(b.dueDate);
    return !Number.isNaN(t) && t < startOfDay.getTime();
  });
  const tasksToday = s.tasks.filter((p) => {
    const t = p.dueAt || 0;
    return !Number.isNaN(t) && t >= startOfDay.getTime() && t <= endOfDay.getTime();
  });

  if (!dueToday.length && !overdueBills.length && !tasksToday.length && !reminderRepoFailed) return "";

  const parts: string[] = [`Morning, ${name}.`];
  if (tasksToday.length) {
    const first = tasksToday[0];
    parts.push(
      `You've got ${tasksToday.length === 1 ? "a task" : `${tasksToday.length} tasks`} today — starting with ${first.title}.`,
    );
  }
  if (dueToday.length) {
    parts.push(
      `${dueToday.length} reminder${dueToday.length === 1 ? "" : "s"} due today: ${dueToday.slice(0, 3).map((r) => r.title).join(", ")}.`,
    );
  } else if (reminderRepoFailed) {
    // Explicit failure semantics: do NOT claim zero reminders when repository read failed
    parts.push(`I couldn't check your reminders due to a connection issue.`);
  }
  if (overdueBills.length) {
    const total = overdueBills.reduce((a, b) => a + Number(b.balance || 0), 0);
    parts.push(
      `Heads up — ${overdueBills.length} bill${overdueBills.length === 1 ? "" : "s"} overdue${total ? `, totalling ${total.toFixed(2)}` : ""}: ${overdueBills.slice(0, 3).map((b) => b.name).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

export async function tick(force = false, options?: MorningBriefOptions) {
  if (typeof document === "undefined") return;
  if (document.hidden && !force) return;
  const s = alphaStore.get();
  if (!s.settings.backgroundEnabled) return;

  const hour = (options?.now || new Date()).getHours();

  // Morning brief window 5am–11am local, once per day.
  if (hour >= 5 && hour <= 11) {
    const brief = await buildMorningBrief(options);
    if (brief && readOnce(LS_LAST_BRIEF)) speakAndLog(brief);
  }

  // Overdue-bill standalone nudge (any time of day, once).
  const overdue = s.bills.filter(b => b.status !== "paid" && Date.parse(b.dueDate) < Date.now() - 86400000);
  if (overdue.length && readOnce(LS_LAST_BILLS)) {
    const total = overdue.reduce((a, b) => a + Number(b.balance || 0), 0);
    speakAndLog(`Quick reminder — ${overdue.length} bill${overdue.length === 1 ? " is" : "s are"} overdue${total ? `, totalling ${total.toFixed(2)}` : ""}. Want me to open the bills view?`);
  }

  // Plans-today nudge (once per day) — outside the morning window.
  if (hour > 11) {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const tasksToday = s.tasks.filter(p => {
      const t = p.dueAt || 0;
      return !Number.isNaN(t) && t >= startOfDay.getTime() && t <= endOfDay.getTime();
    });
    if (tasksToday.length && readOnce(LS_LAST_PLANS)) {
      const first = tasksToday[0];
      speakAndLog(`Reminder — you still have ${tasksToday.length === 1 ? "a task" : `${tasksToday.length} tasks`} today, starting with ${first.title}.`);
    }
  }
}

let started = false;
let intervalId: number | null = null;
let startupTimerId: number | null = null;

const onVisibilityChange = () => {
  if (typeof document !== "undefined" && !document.hidden && started) {
    void tick().catch((err) => console.error("Proactive visibility tick error:", err));
  }
};

export function isProactiveStarted(): boolean {
  return started;
}

export function startProactive() {
  if (started || typeof window === "undefined") return;
  started = true;

  if (startupTimerId !== null) {
    window.clearTimeout(startupTimerId);
    startupTimerId = null;
  }
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }

  // Small delay after boot so chat store is warm and audio is unlockable.
  startupTimerId = window.setTimeout(() => {
    startupTimerId = null;
    if (started) {
      void tick().catch((err) => console.error("Proactive startup tick error:", err));
    }
  }, 8000) as unknown as number;

  intervalId = window.setInterval(() => {
    if (started) {
      void tick().catch((err) => console.error("Proactive interval tick error:", err));
    }
  }, 5 * 60 * 1000) as unknown as number;

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
}

export function stopProactive() {
  started = false;

  if (startupTimerId !== null) {
    if (typeof window !== "undefined") window.clearTimeout(startupTimerId);
    startupTimerId = null;
  }

  if (intervalId !== null) {
    if (typeof window !== "undefined") window.clearInterval(intervalId);
    intervalId = null;
  }

  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}