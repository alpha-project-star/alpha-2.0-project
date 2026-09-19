import { alphaStore, uid } from "./alpha-store";
import { trySettingsIntent } from "./settings-intents";
import { playMusicByName, stopMusic } from "./music";
import { auth } from "./firebase";
import { getReminderTool } from "./tool-registry";
import { ensureAuthenticatedUser } from "./auth";
import { formatReminderDate } from "./reminder-date-utils";
import type { FirestoreReminder } from "./reminder-repo";

async function getActiveUserId(): Promise<string | null> {
  const user = await ensureAuthenticatedUser();
  return user?.uid || auth.currentUser?.uid || null;
}

/**
 * Lightweight on-device intent parser for CRUD commands so Alpha can actually
 * perform operations (add reminder, add note, save memory, delete X) without
 * hitting the LLM. Returns a spoken confirmation string, or null if no match.
 */
export async function tryLocalIntent(raw: string): Promise<string | null> {
  const t = raw.trim();
  const lower = t.toLowerCase();

  // Settings / backend / voice flip commands first.
  const settingsHit = trySettingsIntent(t);
  if (settingsHit) return settingsHit;

  // ---- MUSIC -------------------------------------------------------------
  if (/^(?:stop|pause)\s+(?:the\s+)?music\b/.test(lower)) {
    stopMusic();
    return "Music stopped.";
  }
  let music = lower.match(/^(?:play|start)\s+(?:my\s+|the\s+)?(?:music|song|track)(?:\s+(.+))?$/);
  if (!music) music = lower.match(/^(?:play|start)\s+(.+)$/);
  if (
    music &&
    !/^(?:open|delete|remove|clear|add|set|switch|change|use|remind|remember|note|task|mark)\b/.test(
      lower,
    )
  ) {
    const q = trim(music[1] || "");
    void playMusicByName(q).catch(() => {});
    return q ? `Playing ${q}.` : "Playing your latest saved track.";
  }

  // ---- READ / LIST ------------------------------------------------------
  let mm = lower.match(
    /^(?:what|which|list|show|read)\s+(?:are\s+)?(?:my\s+|the\s+)?(reminders|notes|memories|memorys|memory|tasks|bills)/,
  );
  if (mm) {
    const kind = mm[1].replace(/s$/, "");
    return await listItems(kind);
  }
  if (/^(?:what|which)\s+do\s+you\s+remember/.test(lower)) return await listItems("memory");

  // ---- BULK CLEAR -------------------------------------------------------
  mm = lower.match(
    /^(?:delete|remove|clear)\s+all\s+(notes|reminders|memories|memory|tasks|bills)/,
  );
  if (mm) {
    const kind = mm[1].replace(/s$/, "");
    return await bulkClear(kind);
  }
  if (/^(?:clear|delete|remove)\s+(?:all\s+)?done\s+reminders/.test(lower)) {
    const userId = auth.currentUser?.uid || null;
    if (!userId) return "You need to be signed in to manage reminders.";
    const tool = getReminderTool(userId);
    const res = await tool.listReminders();
    if (!res.success) return `Could not fetch reminders: ${res.error?.message || "error"}.`;
    const doneList = (res.data || []).filter((r: any) => r.reminderState === "completed");
    for (const r of doneList) {
      await tool.deleteReminder(r.id);
    }
    return `Cleared ${doneList.length} completed reminder${doneList.length === 1 ? "" : "s"}.`;
  }

  // ---- DELETE BY NAME (fuzzy) ------------------------------------------
  mm = lower.match(
    /^(?:delete|remove|forget)\s+(?:the\s+)?(note|reminder|memory|task|bill)\s+(?:about\s+|called\s+|named\s+|to\s+)?(.+)$/,
  );
  if (mm) return await deleteFuzzy(mm[1], trim(mm[2]));
  mm = lower.match(/^forget\s+(?:that|about)\s+(.+)$/);
  if (mm) return await deleteFuzzy("memory", trim(mm[1]));

  // ---- UPDATE ----------------------------------------------------------
  mm = lower.match(
    /^(?:rename|change)\s+(?:the\s+)?note\s+(?:called\s+|named\s+)?(.+?)\s+to\s+(.+)$/,
  );
  if (mm) {
    const q = trim(mm[1]);
    const to = trim(mm[2]);
    const n = alphaStore
      .get()
      .notes.find(
        (x) =>
          (x.title || "").toLowerCase().includes(q) || (x.body || "").toLowerCase().includes(q),
      );
    if (!n) return `I couldn't find a note matching "${q}".`;
    alphaStore.upsertNote({ ...n, title: to, updatedAt: Date.now() });
    return `Renamed note to "${to}".`;
  }
  mm = lower.match(/^mark\s+(?:the\s+)?bill\s+(.+?)\s+(?:as\s+)?paid/);
  if (mm) {
    const q = trim(mm[1]);
    const b = alphaStore.get().bills.find((x) => x.name.toLowerCase().includes(q));
    if (!b) return `I couldn't find a bill matching "${q}".`;
    alphaStore.upsertBill({ ...b, status: "paid", balance: 0 });
    return `Marked bill "${b.name}" as paid.`;
  }

  // Add reminder: "remind me to X at|on|by Y"  /  "set a reminder to X for Y"
  let m = lower.match(
    /(?:remind me to|set (?:a )?reminder(?: to)?|add (?:a )?reminder(?: to)?)\s+(.+?)(?:\s+(?:at|on|by|for)\s+(.+))?$/,
  );
  if (m) {
    const title = trim(m[1]);
    const when = trim(m[2] || "");
    const userId = await getActiveUserId();
    if (!userId) {
      return "You need to be signed in to manage reminders.";
    }
    if (!when) {
      return `When would you like to be reminded to ${title}? Please specify a date or time.`;
    }
    const tool = getReminderTool(userId);
    const res = await tool.createReminder({
      title,
      dueAt: when,
    });
    if (res.success && res.data) {
      const dueText = formatReminderDate(res.data.dueAt);
      return `Done — reminder added: "${res.data.title}" (${dueText}).`;
    }
    return `I couldn't set that reminder: ${res.error?.message || "unknown error"}.`;
  }

  // Add note — broad: "take a note: X", "note that X", "add a note X",
  // "add to (my) notes X", "save (this) to (my) notes X", "save a note X",
  // "jot down X", "write down X", "make a note X", "new note X"
  m = lower.match(
    /(?:take a note(?:[:,])?|note that|add (?:a )?note(?:[:,])?|add (?:this )?to (?:my )?notes(?:[:,])?|save (?:this )?(?:to (?:my )?notes|a note)(?:[:,])?|save note(?:[:,])?|jot (?:this )?down(?:[:,])?|write (?:this )?down(?:[:,])?|make (?:a )?note(?:[:,])?|new note(?:[:,])?)\s+(.+)$/,
  );
  if (m) {
    const body = trim(m[m.length - 1]);
    alphaStore.upsertNote({ id: uid(), title: body.slice(0, 40), body, updatedAt: Date.now() });
    return `Got it — note saved: "${body.slice(0, 60)}".`;
  }

  // Memory: "remember that X" / "save a memory about X" / "store in memory X" / "keep in mind X"
  m = lower.match(
    /(?:remember(?: that)?|save (?:a )?memory(?: about)?|store (?:this )?(?:in (?:my )?memory|to memory)|keep (?:this )?in mind(?:[:,])?|add (?:this )?to (?:my )?memor(?:y|ies)(?:[:,])?)\s+(.+)$/,
  );
  if (m) {
    const detail = trim(m[m.length - 1]);
    alphaStore.upsertMemory({
      id: uid(),
      topic: detail.slice(0, 40),
      detail,
      updatedAt: Date.now(),
    });
    return `Stored to memory: "${detail.slice(0, 60)}".`;
  }

  // Bill: "add a bill X for $N due Y"
  m = lower.match(/add (?:a )?bill\s+(.+?)\s+(?:for\s+\$?(\d+(?:\.\d+)?))?(?:\s+due\s+(.+))?$/);
  if (m) {
    const name = trim(m[1]);
    const amount = Number(m[2] || 0);
    const dueDate = trim(m[3] || "");
    alphaStore.upsertBill({ id: uid(), name, amount, balance: amount, dueDate, status: "due" });
    return `Bill added: ${name}${amount ? " for $" + amount : ""}.`;
  }

  // Delete latest of a kind: "delete the last note" / "remove last reminder"
  m = lower.match(
    /(?:delete|remove|clear)\s+(?:the\s+)?(?:last|latest|recent)\s+(note|reminder|memory|task|bill)/,
  );
  if (m) {
    const kind = m[1];
    if (kind === "reminder") {
      const userId = auth.currentUser?.uid || null;
      if (!userId) return "You need to be signed in to manage reminders.";
      const tool = getReminderTool(userId);
      const res = await tool.listReminders();
      if (!res.success || !res.data?.length) return "No reminders to delete.";
      const sorted = [...res.data].sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
      const latest = sorted[0];
      await tool.deleteReminder(latest.id);
      return `Deleted the last reminder: "${latest.title}".`;
    }
    const s = alphaStore.get();
    const map: Record<string, { list: any[]; del: (id: string) => void }> = {
      note: { list: s.notes, del: alphaStore.deleteNote },
      memory: { list: s.memories, del: alphaStore.deleteMemory },
      task: { list: s.tasks, del: alphaStore.deleteTask },
      bill: { list: s.bills, del: alphaStore.deleteBill },
    };
    const e = map[kind];
    if (e?.list[0]) {
      e.del(e.list[0].id);
      return `Deleted the last ${kind}.`;
    }
    return `No ${kind}s to delete.`;
  }

  // Mark reminder done
  m = lower.match(/(?:mark|set)\s+(?:reminder\s+)?(.+?)\s+(?:as\s+)?done/);
  if (m) {
    const q = trim(m[1]);
    const userId = await getActiveUserId();
    if (!userId) return "You need to be signed in to manage reminders.";
    const tool = getReminderTool(userId);
    const res = await tool.completeReminder(q);
    if (res.success && res.data) {
      return `Marked reminder "${res.data.title}" as done.`;
    }
    return `I couldn't find that reminder.`;
  }

  return null;
}

// ---------------------------------------------------------------------------

async function listItems(kind: string): Promise<string> {
  const s = alphaStore.get();
  if (kind === "reminder") {
    const userId = await getActiveUserId();
    if (!userId) return "You need to be signed in to view your reminders.";
    const tool = getReminderTool(userId);
    const res = await tool.listReminders();
    if (!res.success) return `I couldn't fetch your reminders: ${res.error?.message || "error"}.`;
    if (!res.data || !res.data.length) return "You have no reminders.";
    return (
      "**Reminders:**\n" +
      res.data
        .slice(0, 20)
        .map(
          (r: FirestoreReminder) =>
            `• ${r.title} @ ${formatReminderDate(r.dueAt)}${r.reminderState === "completed" ? " ✅" : ""}`,
        )
        .join("\n")
    );
  }
  if (kind === "note") {
    if (!s.notes.length) return "You have no notes.";
    return (
      "**Notes:**\n" +
      s.notes
        .slice(0, 20)
        .map((n) => `• ${n.title || "(untitled)"}: ${(n.body || "").slice(0, 80)}`)
        .join("\n")
    );
  }
  if (kind === "memory") {
    if (!s.memories.length) return "No memories stored yet.";
    return (
      "**Memories:**\n" +
      s.memories
        .slice(0, 20)
        .map((m) => `• ${m.topic}: ${m.detail}`)
        .join("\n")
    );
  }
  if (kind === "task") {
    if (!s.tasks.length) return "You have no tasks.";
    return (
      "**Tasks:**\n" +
      s.tasks
        .slice(0, 20)
        .map((p) => `• ${p.title} (${p.status})`)
        .join("\n")
    );
  }
  if (kind === "bill") {
    if (!s.bills.length) return "You have no bills.";
    return (
      "**Bills:**\n" +
      s.bills
        .slice(0, 20)
        .map(
          (b) => `• ${b.name}: $${b.balance} (${b.status})${b.dueDate ? " due " + b.dueDate : ""}`,
        )
        .join("\n")
    );
  }
  return `I don't know how to list "${kind}".`;
}

async function bulkClear(kind: string): Promise<string> {
  const s = alphaStore.get();
  if (kind === "reminder") {
    const userId = auth.currentUser?.uid || null;
    if (!userId) return "You need to be signed in to manage reminders.";
    const tool = getReminderTool(userId);
    const res = await tool.listReminders();
    if (!res.success || !res.data?.length) return "No reminders to clear.";
    const n = res.data.length;
    for (const r of res.data) {
      await tool.deleteReminder(r.id);
    }
    return `Cleared all ${n} reminders.`;
  }
  let list: { id: string }[] = [];
  let del: (id: string) => void = () => {};
  if (kind === "note") {
    list = s.notes;
    del = alphaStore.deleteNote;
  } else if (kind === "memory") {
    list = s.memories;
    del = alphaStore.deleteMemory;
  } else if (kind === "task") {
    list = s.tasks;
    del = alphaStore.deleteTask;
  } else if (kind === "bill") {
    list = s.bills;
    del = alphaStore.deleteBill;
  } else return `I don't know how to clear "${kind}".`;
  const n = list.length;
  for (const item of [...list]) del(item.id);
  return `Cleared all ${n} ${kind}${n === 1 ? "" : "s"}.`;
}

async function deleteFuzzy(kind: string, q: string): Promise<string> {
  const s = alphaStore.get();
  const lc = q.toLowerCase();
  if (kind === "reminder") {
    const userId = await getActiveUserId();
    if (!userId) return "You need to be signed in to manage reminders.";
    const tool = getReminderTool(userId);
    const res = await tool.deleteReminder(q);
    if (!res.success || !res.data) {
      if (res.error?.code === "AMBIGUOUS") {
        return res.error.message;
      }
      return `No reminder matching "${q}".`;
    }
    return `Deleted reminder "${res.data.title}".`;
  }
  if (kind === "note") {
    const matches = s.notes.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(lc) || (n.body || "").toLowerCase().includes(lc),
    );
    if (!matches.length) return `No note matching "${q}".`;
    if (matches.length > 1)
      return `Multiple notes match "${q}" — which one? (${matches.map((m) => m.title || m.body.slice(0, 20)).join(", ")})`;
    alphaStore.deleteNote(matches[0].id);
    return `Deleted note "${matches[0].title || matches[0].body.slice(0, 30)}".`;
  }
  if (kind === "memory") {
    const matches = s.memories.filter(
      (m) => m.topic.toLowerCase().includes(lc) || m.detail.toLowerCase().includes(lc),
    );
    if (!matches.length) return `No memory matching "${q}".`;
    if (matches.length > 1)
      return `Multiple memories match "${q}" — which? (${matches.map((m) => m.topic).join(", ")})`;
    alphaStore.deleteMemory(matches[0].id);
    return `Forgot memory "${matches[0].topic}".`;
  }
  if (kind === "task") {
    const matches = s.tasks.filter((p) => p.title.toLowerCase().includes(lc));
    if (!matches.length) return `No task matching "${q}".`;
    if (matches.length > 1)
      return `Multiple tasks match "${q}" — which one? (${matches.map((p) => p.title).join(", ")})`;
    alphaStore.deleteTask(matches[0].id);
    return `Deleted task "${matches[0].title}".`;
  }
  if (kind === "bill") {
    const matches = s.bills.filter((b) => b.name.toLowerCase().includes(lc));
    if (!matches.length) return `No bill matching "${q}".`;
    if (matches.length > 1)
      return `Multiple bills match "${q}" — which one? (${matches.map((b) => b.name).join(", ")})`;
    alphaStore.deleteBill(matches[0].id);
    return `Deleted bill "${matches[0].name}".`;
  }
  return `I don't know how to delete "${kind}".`;
}

/**
 * Very small natural-language date parser for reminder shortcuts.
 * Supports: "in 5 minutes", "in 2 hours", "tomorrow 8am", "8pm", "at 15:30".
 * Returns an ISO string or empty on failure.
 */
function parseNaturalWhen(raw: string): string {
  const s = raw.trim().toLowerCase();
  const now = new Date();

  let m = s.match(/^in\s+(\d+)\s*(second|minute|min|hour|hr|day)s?$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = /second/.test(unit)
      ? n * 1000
      : /min/.test(unit)
        ? n * 60000
        : /hour|hr/.test(unit)
          ? n * 3600000
          : n * 86400000;
    return new Date(now.getTime() + ms).toISOString();
  }

  // "8pm", "8:30 am"
  m = s.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const mm = Number(m[2] || 0);
    const ampm = m[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  // "tomorrow 8am"
  m = s.match(/^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    let h = m[1] ? Number(m[1]) : 9;
    const mm = Number(m[2] || 0);
    const ampm = m[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    d.setHours(h, mm, 0, 0);
    return d.toISOString();
  }

  // Try native Date.parse as a fallback
  const t = Date.parse(raw);
  if (!isNaN(t)) return new Date(t).toISOString();

  return "";
}

function trim(s: string) {
  return s.replace(/[.!?]+$/, "").trim();
}
