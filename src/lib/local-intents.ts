import { alphaStore, uid } from "./alpha-store";
import { trySettingsIntent } from "./settings-intents";
import { playMusicByName, stopMusic } from "./music";
import { auth } from "./firebase";
import { getReminderTool } from "./tool-registry";
import { ensureAuthenticatedUser } from "./auth";
import { formatReminderDate } from "./reminder-date-utils";
import type { FirestoreReminder } from "./reminder-repo";
import { parseWhen } from "./when";
import { reminderContextManager } from "./reminder-context";
import { temporal } from "./temporal";
import { activity } from "./activity";
import type { ActivityKind } from "./activity";
import type { RequestActionLifecycle } from "./request-lifecycle";
import {
  getCanonicalReminderCreateKey,
  getCanonicalReminderDeleteKey,
  getCanonicalReminderCompleteKey,
  getCanonicalNoteCreateKey,
  getCanonicalMemoryCreateKey,
  getCanonicalBillCreateKey,
  getCanonicalClearAllKey,
  getCanonicalUpdateKey,
  getCanonicalDeleteKey,
  getCanonicalBulkDeleteKey,
} from "./mutation-identity";

async function getActiveUserId(): Promise<string | null> {
  const user = await ensureAuthenticatedUser();
  return user?.uid || auth.currentUser?.uid || null;
}

/**
 * Lightweight on-device intent parser for CRUD commands so Alpha can actually
 * perform operations (add reminder, add note, save memory, delete X) without
 * hitting the LLM. Returns a spoken confirmation string, or null if no match.
 */
export async function tryLocalIntent(raw: string, lifecycle?: RequestActionLifecycle): Promise<string | null> {
  const t = raw.trim();
  const lower = t.toLowerCase();

  const userId = await getActiveUserId() || auth.currentUser?.uid || 'local-user';
  const pendingClarif = reminderContextManager.getPendingClarification(userId);
  if (pendingClarif) {
    const isAm = /\bam\b/i.test(lower) || /morning/i.test(lower);
    const isPm = /\bpm\b/i.test(lower) || /evening|afternoon|night/i.test(lower);
    if (isAm || isPm || /^(?:am|pm)\b/i.test(lower)) {
      const meridiem = isPm ? 'PM' : 'AM';
      const resolvedRawWhen = `${pendingClarif.rawWhen} ${meridiem}`;
      const dueAt = parseWhen(resolvedRawWhen, temporal.now());
      if (dueAt === null) {
        lifecycle?.recordClarification(`I couldn't understand the time "${resolvedRawWhen}". Please specify AM or PM.`, "ADD_REMINDER");
        return `I couldn't understand when "${resolvedRawWhen}" refers to. Do you mean AM or PM?`;
      }
      activity.set("writing_reminder");
      const tool = getReminderTool(userId);
      const result = await tool.createReminder({
        title: pendingClarif.title,
        dueAt,
        notes: pendingClarif.notes || '',
      });
      if (result.success && result.data) {
        const reminder = result.data;
        const key = getCanonicalReminderCreateKey({ title: reminder.title, dueAt: reminder.dueAt, notes: reminder.notes });
        lifecycle?.recordSuccess({
          name: "ADD_REMINDER",
          isMutation: true,
          result: reminder,
          logicalKeys: [key],
        });
        reminderContextManager.clearPendingClarification(userId);
        return `Reminder saved: "${reminder.title}" — ${formatReminderDate(reminder.dueAt)}`;
      } else {
        const error = result.error || { code: 'REPOSITORY_ERROR', message: 'Failed to create reminder' };
        const key = getCanonicalReminderCreateKey({ title: pendingClarif.title, dueAt, notes: pendingClarif.notes });
        lifecycle?.recordFailure({
          name: "ADD_REMINDER",
          isMutation: true,
          error,
          logicalKey: key,
        });
        return `I couldn't save your reminder: ${error.message}. Please try again.`;
      }
    }
  }

  // Settings / backend / voice flip commands first.
  const settingsHit = await trySettingsIntent(t, lifecycle);
  if (settingsHit) {
    return settingsHit;
  }

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
    if (kind === "reminder") activity.set("reading_reminder");
    else if (kind === "note") activity.set("reading_note");
    else if (kind === "memory") activity.set("reading_memory");
    else if (kind === "task") activity.set("updating_plan");
    return await listItems(kind);
  }
  if (/^(?:what|which)\s+do\s+you\s+remember/.test(lower)) {
    activity.set("reading_memory");
    return await listItems("memory");
  }

  // ---- BULK CLEAR -------------------------------------------------------
  mm = lower.match(
    /^(?:delete|remove|clear)\s+all\s+(notes|reminders|memories|memory|tasks|bills)/,
  );
  if (mm) {
    const kind = mm[1].replace(/s$/, "");
    if (kind === "reminder") activity.set("writing_reminder");
    else if (kind === "note") activity.set("writing_note");
    else if (kind === "memory") activity.set("writing_memory");
    else if (kind === "bill") activity.set("writing_bill");
    else if (kind === "task") activity.set("updating_plan");
    return await bulkClear(kind, lifecycle);
  }
  if (/^(?:clear|delete|remove)\s+(?:all\s+)?done\s+reminders/.test(lower)) {
    const userId = auth.currentUser?.uid || null;
    if (!userId) return "You need to be signed in to manage reminders.";
    activity.set("writing_reminder");
    const tool = getReminderTool(userId);
    const res = await tool.listReminders();
    if (!res.success) return `Could not fetch reminders: ${res.error?.message || "error"}.`;
    const doneList = (res.data || []).filter((r: any) => r.reminderState === "completed");
    for (const r of doneList) {
      await tool.deleteReminder(r.id);
    }
    lifecycle?.recordSuccess({
      name: "CLEAR_DONE_REMINDERS",
      isMutation: true,
      result: { count: doneList.length },
      logicalKeys: doneList.map((r: any) => getCanonicalReminderDeleteKey({ targetIds: [r.id] })),
    });
    return `Cleared ${doneList.length} completed reminder${doneList.length === 1 ? "" : "s"}.`;
  }

  // ---- DELETE BY NAME (fuzzy) ------------------------------------------
  mm = lower.match(
    /^(?:delete|remove|forget)\s+(?:the\s+)?(note|reminder|memory|task|bill)\s+(?:about\s+|called\s+|named\s+|to\s+)?(.+)$/,
  );
  if (mm) return await deleteFuzzy(mm[1], trim(mm[2]), lifecycle);
  mm = lower.match(/^forget\s+(?:that|about)\s+(.+)$/);
  if (mm) return await deleteFuzzy("memory", trim(mm[1]), lifecycle);

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
    activity.set("writing_note");
    try {
      await alphaStore.upsertNote({ ...n, title: to, updatedAt: Date.now() });
      const updateKey = getCanonicalUpdateKey("note", n.id, { title: to });
      lifecycle?.recordSuccess({
        name: "UPDATE_NOTE",
        isMutation: true,
        result: { id: n.id, title: to },
        logicalKeys: [updateKey],
      });
      return `Renamed note to "${to}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "UPDATE_NOTE",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `Could not update note: ${err?.message || "unknown error"}`;
    }
  }
  mm = lower.match(/^mark\s+(?:the\s+)?bill\s+(.+?)\s+(?:as\s+)?paid/);
  if (mm) {
    const q = trim(mm[1]);
    const b = alphaStore.get().bills.find((x) => x.name.toLowerCase().includes(q));
    if (!b) return `I couldn't find a bill matching "${q}".`;
    activity.set("writing_bill");
    try {
      await alphaStore.upsertBill({ ...b, status: "paid", balance: 0 });
      const paidKey = getCanonicalUpdateKey("bill", b.id, { status: "paid", balance: 0 });
      lifecycle?.recordSuccess({
        name: "MARK_BILL_PAID",
        isMutation: true,
        result: { id: b.id, name: b.name },
        logicalKeys: [paidKey],
      });
      return `Marked bill "${b.name}" as paid.`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "MARK_BILL_PAID",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `Could not mark bill paid: ${err?.message || "unknown error"}`;
    }
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
    activity.set("writing_reminder");
    const tool = getReminderTool(userId);
    const res = await tool.createReminder({
      title,
      dueAt: when,
    });
    if (res.success && res.data) {
      const dueText = formatReminderDate(res.data.dueAt);
      const logicalKey = getCanonicalReminderCreateKey(res.data);
      lifecycle?.recordSuccess({
        name: "createReminder",
        isMutation: true,
        result: res.data,
        logicalKeys: logicalKey ? [logicalKey] : [],
      });
      return `Done — reminder added: "${res.data.title}" (${dueText}).`;
    }
    lifecycle?.recordFailure({
      name: "createReminder",
      isMutation: true,
      error: res.error || { message: "unknown error" },
    });
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
    activity.set("writing_note");
    const id = uid();
    const title = body.slice(0, 40);
    try {
      await alphaStore.upsertNote({ id, title, body, updatedAt: Date.now() });
      const opKey = getCanonicalNoteCreateKey(title, body);
      lifecycle?.recordSuccess({
        name: "ADD_NOTE",
        isMutation: true,
        result: { id, title, body },
        logicalKeys: [opKey],
      });
      return `Got it — note saved: "${body.slice(0, 60)}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "ADD_NOTE",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `I couldn't save that note: ${err?.message || "unknown error"}.`;
    }
  }

  // Memory: "remember that X" / "save a memory about X" / "store in memory X" / "keep in mind X"
  m = lower.match(
    /(?:remember(?: that)?|save (?:a )?memory(?: about)?|store (?:this )?(?:in (?:my )?memory|to memory)|keep (?:this )?in mind(?:[:,])?|add (?:this )?to (?:my )?memor(?:y|ies)(?:[:,])?)\s+(.+)$/,
  );
  if (m) {
    const detail = trim(m[m.length - 1]);
    activity.set("writing_memory");
    const id = uid();
    const topic = detail.slice(0, 40);
    try {
      await alphaStore.upsertMemory({
        id,
        topic,
        detail,
        updatedAt: Date.now(),
      });
      const key = getCanonicalMemoryCreateKey(topic, detail);
      lifecycle?.recordSuccess({
        name: "ADD_MEMORY",
        isMutation: true,
        result: { id, topic, detail },
        logicalKeys: [key],
      });
      return `Stored to memory: "${detail.slice(0, 60)}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "ADD_MEMORY",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `I couldn't store that memory: ${err?.message || "unknown error"}.`;
    }
  }

  // Bill: "add a bill X for $N due Y"
  m = lower.match(/add (?:a )?bill\s+(.+?)\s+(?:for\s+\$?(\d+(?:\.\d+)?))?(?:\s+due\s+(.+))?$/);
  if (m) {
    const name = trim(m[1]);
    const amount = Number(m[2] || 0);
    const dueDate = trim(m[3] || "");
    activity.set("writing_bill");
    const id = uid();
    try {
      await alphaStore.upsertBill({ id, name, amount, balance: amount, dueDate, status: "due" });
      const key = getCanonicalBillCreateKey(name, amount, dueDate);
      lifecycle?.recordSuccess({
        name: "ADD_BILL",
        isMutation: true,
        result: { id, name, amount },
        logicalKeys: [key],
      });
      return `Bill added: ${name}${amount ? " for $" + amount : ""}.`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "ADD_BILL",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `I couldn't add that bill: ${err?.message || "unknown error"}.`;
    }
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
      activity.set("writing_reminder");
      const tool = getReminderTool(userId);
      const res = await tool.listReminders();
      if (!res.success || !res.data?.length) return "No reminders to delete.";
      const sorted = [...res.data].sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
      const latest = sorted[0];
      await tool.deleteReminder(latest.id);
      const delKey = getCanonicalReminderDeleteKey({ targetIds: [latest.id] });
      lifecycle?.recordSuccess({
        name: "DELETE_REMINDER",
        isMutation: true,
        result: latest,
        logicalKeys: [delKey],
      });
      return `Deleted the last reminder: "${latest.title}".`;
    }
    const s = alphaStore.get();
    const map: Record<string, { list: any[]; del: (id: string) => Promise<void>; act: ActivityKind }> = {
      note: { list: s.notes, del: (id) => alphaStore.deleteNote(id), act: "writing_note" },
      memory: { list: s.memories, del: (id) => alphaStore.deleteMemory(id), act: "writing_memory" },
      task: { list: s.tasks, del: (id) => alphaStore.deleteTask(id), act: "updating_plan" },
      bill: { list: s.bills, del: (id) => alphaStore.deleteBill(id), act: "writing_bill" },
    };
    const e = map[kind];
    if (e?.list[0]) {
      activity.set(e.act);
      const victim = e.list[0];
      try {
        await e.del(victim.id);
        const key = getCanonicalDeleteKey(kind, victim.id);
        lifecycle?.recordSuccess({
          name: `DELETE_LAST_${kind.toUpperCase()}`,
          isMutation: true,
          result: victim,
          logicalKeys: [key],
        });
        return `Deleted the last ${kind}.`;
      } catch (err: any) {
        lifecycle?.recordFailure({
          name: `DELETE_LAST_${kind.toUpperCase()}`,
          isMutation: true,
          error: err || { message: "unknown error" },
        });
        return `Could not delete last ${kind}: ${err?.message || "unknown error"}`;
      }
    }
    return `No ${kind}s to delete.`;
  }

  // Mark reminder done
  m = lower.match(/(?:mark|set)\s+(?:reminder\s+)?(.+?)\s+(?:as\s+)?done/);
  if (m) {
    const q = trim(m[1]);
    const userId = await getActiveUserId();
    if (!userId) return "You need to be signed in to manage reminders.";
    activity.set("writing_reminder");
    const tool = getReminderTool(userId);
    const res = await tool.completeReminder(q);
    if (res.success && res.data) {
      const compKey = getCanonicalReminderCompleteKey({ targetId: res.data.id });
      lifecycle?.recordSuccess({
        name: "MARK_REMINDER_DONE",
        isMutation: true,
        result: res.data,
        logicalKeys: [compKey],
      });
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

async function bulkClear(kind: string, lifecycle?: RequestActionLifecycle): Promise<string> {
  const s = alphaStore.get();
  if (kind === "reminder") {
    const userId = auth.currentUser?.uid || null;
    if (!userId) return "You need to be signed in to manage reminders.";
    activity.set("writing_reminder");
    const tool = getReminderTool(userId);
    const res = await tool.listReminders();
    if (!res.success || !res.data?.length) return "No reminders to clear.";
    const reminders = res.data;
    const targetIds = reminders.map((r: any) => r.id);
    const sortedIds = Array.from(new Set(targetIds)).sort();
    const bulkKey = getCanonicalReminderDeleteKey({ targetIds: sortedIds });
    const clearKey = getCanonicalClearAllKey("reminders");
    const singleKeys = sortedIds.map((id: string) => getCanonicalReminderDeleteKey({ targetIds: [id] }));

    let successCount = 0;
    const successfulKeys: string[] = [];
    for (const r of reminders) {
      try {
        await tool.deleteReminder(r.id);
        successCount++;
        successfulKeys.push(getCanonicalReminderDeleteKey({ targetIds: [r.id] }));
      } catch (err) {
        lifecycle?.recordFailure({
          name: "DELETE_REMINDER",
          isMutation: true,
          error: err || { message: "unknown error" },
        });
      }
    }
    if (successCount === 0) {
      lifecycle?.recordFailure({
        name: "CLEAR_ALL_REMINDERS",
        isMutation: true,
        error: { message: "Failed to clear reminders" },
      });
      return "Could not clear reminders.";
    }
    lifecycle?.recordSuccess({
      name: "CLEAR_ALL_REMINDERS",
      isMutation: true,
      result: { count: successCount },
      logicalKeys: [bulkKey, clearKey, ...successfulKeys],
    });
    return `Cleared ${successCount} reminders.`;
  }

  let list: { id: string; title?: string; topic?: string; name?: string }[] = [];
  let del: (id: string) => Promise<void> = async () => {};
  if (kind === "note") {
    activity.set("writing_note");
    list = s.notes;
    del = (id) => alphaStore.deleteNote(id);
  } else if (kind === "memory") {
    activity.set("writing_memory");
    list = s.memories;
    del = (id) => alphaStore.deleteMemory(id);
  } else if (kind === "task") {
    activity.set("updating_plan");
    list = s.tasks;
    del = (id) => alphaStore.deleteTask(id);
  } else if (kind === "bill") {
    activity.set("writing_bill");
    list = s.bills;
    del = (id) => alphaStore.deleteBill(id);
  } else return `I don't know how to clear "${kind}".`;

  if (!list.length) return `No ${kind}s to clear.`;

  const targetIds = list.map((item) => item.id);
  const sortedIds = Array.from(new Set(targetIds)).sort();
  const bulkKey = getCanonicalBulkDeleteKey(kind, sortedIds);
  const clearKey = getCanonicalClearAllKey(kind === "memory" ? "memories" : `${kind}s`);
  const singleKeys = sortedIds.map((id) => getCanonicalDeleteKey(kind, id));

  let successCount = 0;
  const successfulKeys: string[] = [];
  for (const item of [...list]) {
    try {
      await del(item.id);
      successCount++;
      successfulKeys.push(getCanonicalDeleteKey(kind, item.id));
    } catch (err) {
      lifecycle?.recordFailure({
        name: `DELETE_${kind.toUpperCase()}`,
        isMutation: true,
        error: err || { message: "unknown error" },
      });
    }
  }

  if (successCount === 0) {
    lifecycle?.recordFailure({
      name: `CLEAR_ALL_${kind.toUpperCase()}S`,
      isMutation: true,
      error: { message: `Failed to clear ${kind}s` },
    });
    return `Could not clear ${kind}s.`;
  }

  lifecycle?.recordSuccess({
    name: `CLEAR_ALL_${kind.toUpperCase()}S`,
    isMutation: true,
    result: { count: successCount },
    logicalKeys: [bulkKey, clearKey, ...successfulKeys],
  });
  return `Cleared ${successCount} ${kind}${successCount === 1 ? "" : "s"}.`;
}

async function deleteFuzzy(kind: string, q: string, lifecycle?: RequestActionLifecycle): Promise<string> {
  const s = alphaStore.get();
  const lc = q.toLowerCase();
  if (kind === "reminder") {
    activity.set("writing_reminder");
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
    const delKey = getCanonicalReminderDeleteKey({ targetIds: [res.data.id] });
    lifecycle?.recordSuccess({
      name: "DELETE_REMINDER",
      isMutation: true,
      result: res.data,
      logicalKeys: [delKey],
    });
    return `Deleted reminder "${res.data.title}".`;
  }
  if (kind === "note") {
    activity.set("writing_note");
    const matches = s.notes.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(lc) || (n.body || "").toLowerCase().includes(lc),
    );
    if (!matches.length) return `No note matching "${q}".`;
    if (matches.length > 1)
      return `Multiple notes match "${q}" — which one? (${matches.map((m) => m.title || m.body.slice(0, 20)).join(", ")})`;
    const target = matches[0];
    try {
      await alphaStore.deleteNote(target.id);
      const key = getCanonicalDeleteKey("note", target.id);
      lifecycle?.recordSuccess({
        name: "DELETE_NOTE",
        isMutation: true,
        result: target,
        logicalKeys: [key],
      });
      return `Deleted note "${target.title || target.body.slice(0, 30)}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "DELETE_NOTE",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `Could not delete note: ${err?.message || "unknown error"}`;
    }
  }
  if (kind === "memory") {
    activity.set("writing_memory");
    const matches = s.memories.filter(
      (m) => m.topic.toLowerCase().includes(lc) || m.detail.toLowerCase().includes(lc),
    );
    if (!matches.length) return `No memory matching "${q}".`;
    if (matches.length > 1)
      return `Multiple memories match "${q}" — which? (${matches.map((m) => m.topic).join(", ")})`;
    const target = matches[0];
    try {
      await alphaStore.deleteMemory(target.id);
      const key = getCanonicalDeleteKey("memory", target.id);
      lifecycle?.recordSuccess({
        name: "DELETE_MEMORY",
        isMutation: true,
        result: target,
        logicalKeys: [key],
      });
      return `Forgot memory "${target.topic}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "DELETE_MEMORY",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `Could not delete memory: ${err?.message || "unknown error"}`;
    }
  }
  if (kind === "task") {
    activity.set("updating_plan");
    const matches = s.tasks.filter((p) => p.title.toLowerCase().includes(lc));
    if (!matches.length) return `No task matching "${q}".`;
    if (matches.length > 1)
      return `Multiple tasks match "${q}" — which one? (${matches.map((p) => p.title).join(", ")})`;
    const target = matches[0];
    try {
      await alphaStore.deleteTask(target.id);
      const key = getCanonicalDeleteKey("task", target.id);
      lifecycle?.recordSuccess({
        name: "DELETE_TASK",
        isMutation: true,
        result: target,
        logicalKeys: [key],
      });
      return `Deleted task "${target.title}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "DELETE_TASK",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `Could not delete task: ${err?.message || "unknown error"}`;
    }
  }
  if (kind === "bill") {
    activity.set("writing_bill");
    const matches = s.bills.filter((b) => b.name.toLowerCase().includes(lc));
    if (!matches.length) return `No bill matching "${q}".`;
    if (matches.length > 1)
      return `Multiple bills match "${q}" — which one? (${matches.map((b) => b.name).join(", ")})`;
    const target = matches[0];
    try {
      await alphaStore.deleteBill(target.id);
      const key = getCanonicalDeleteKey("bill", target.id);
      lifecycle?.recordSuccess({
        name: "DELETE_BILL",
        isMutation: true,
        result: target,
        logicalKeys: [key],
      });
      return `Deleted bill "${target.name}".`;
    } catch (err: any) {
      lifecycle?.recordFailure({
        name: "DELETE_BILL",
        isMutation: true,
        error: err || { message: "unknown error" },
      });
      return `Could not delete bill: ${err?.message || "unknown error"}`;
    }
  }
  return `I don't know how to delete "${kind}".`;
}

/**
 * Canonical natural-language date parser for reminder shortcuts.
 * Resolves consistently with when.ts and reminder-date-utils.
 */
export function parseNaturalWhen(raw: string, now: Date = new Date()): string {
  const t = parseWhen(raw, now);
  return t !== null ? new Date(t).toISOString() : "";
}

function trim(s: string) {
  return s.replace(/[.!?]+$/, "").trim();
}
