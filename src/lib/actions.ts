/**
 * ============================================================================
 * ARCHITECTURAL AUTHORITY DECLARATION — AL-02 RECONCILIATION
 * ============================================================================
 * ROLE: Action Interpretation & Execution Coordinator
 * AUTHORITATIVE FILES/LOGIC: actions.ts
 *
 * RESPONSIBILITIES:
 *  - Parses and interprets action tags emitted by the AI Model.
 *  - Coordinates runtime execution of state changes and local store mutations.
 *  - Translates structured execution steps and plans into verified actions.
 *
 * NOT RESPONSIBLE FOR:
 *  - Conversational reminder context or focus tracking (owned by `src/lib/reminder-context.ts`).
 *  - Data structures, dependency mapping, and relational state schemas (owned by `src/lib/execution.ts`).
 *  - Durable, canonical reminder database persistence (owned by `src/lib/reminder-repo.ts`).
 * ============================================================================
 *
 * Action-tag executor with an explicit result contract.
 *
 * Every state-changing tag the model emits produces exactly one
 * ActionResult. A tag being parsed is NOT success — success means the store
 * or canonical repository was mutated and verified.
 */
import {
  alphaStore,
  uid,
  type Bill,
  type Memory,
  type Note,
  type Task,
  type Goal,
} from "./alpha-store";
import { normalizeWhen, formatWhen } from "./when";
import { activity, actionActivity } from "./activity";
import { auth } from "./firebase";
import {
  LocalReminderRepository,
  type FirestoreReminder,
  type ReminderRepository,
} from "./reminder-repo";

export type ActionStatus = "success" | "failed" | "ambiguous" | "not_found" | "invalid";

export interface ActionResult {
  tag: string;
  status: ActionStatus;
  message: string;
}

export interface ExecuteActionTagsOptions {
  userId?: string | null;
  repo?: ReminderRepository;
}

type Kind = "note" | "memory" | "task" | "goal" | "bill" | "reminder";

const KIND_PLURAL: Record<Kind, string> = {
  note: "notes",
  memory: "memories",
  task: "tasks",
  goal: "goals",
  bill: "bills",
  reminder: "reminders",
};

function searchText(kind: Kind, x: any): string {
  switch (kind) {
    case "note":
      return `${x.title} ${x.body}`.toLowerCase();
    case "memory":
      return `${x.topic} ${x.detail}`.toLowerCase();
    case "task":
      return `${x.title} ${x.description} ${x.status}`.toLowerCase();
    case "goal":
      return `${x.title} ${x.description} ${x.status}`.toLowerCase();
    case "bill":
      return `${x.name} ${x.amount} ${x.dueDate} ${x.status}`.toLowerCase();
    case "reminder":
      return `${x.title} ${x.notes} ${x.when}`.toLowerCase();
  }
  return "";
}

function label(kind: Kind, x: any): string {
  return kind === "memory" ? x.topic : kind === "bill" ? x.name : x.title;
}

function listOf(kind: Kind): any[] {
  const s = alphaStore.get();
  return kind === "note"
    ? s.notes
    : kind === "memory"
      ? s.memories
      : kind === "task"
        ? s.tasks
        : kind === "goal"
        ? s.goals
        : s.bills;
}

function deleteById(kind: Kind, id: string) {
  if (kind === "note") alphaStore.deleteNote(id);
  else if (kind === "memory") alphaStore.deleteMemory(id);
  else if (kind === "task") alphaStore.deleteTask(id);
  else if (kind === "goal") alphaStore.deleteGoal(id);
  else alphaStore.deleteBill(id);
}

function upsert(kind: Kind, item: any) {
  if (kind === "note") alphaStore.upsertNote(item as Note);
  else if (kind === "memory") alphaStore.upsertMemory(item as Memory);
  else if (kind === "task") alphaStore.upsertTask(item as Task);
  else if (kind === "goal") alphaStore.upsertGoal(item as Goal);
  else alphaStore.upsertBill(item as Bill);
}

/** Find items matching a keyword. Exact-ish title matches win over substring. */
function findMatches(kind: Kind, query: string): any[] {
  const q = (query || "")
    .toLowerCase()
    .trim()
    .replace(/^all\s+/, "");
  if (!q) return [];
  const list = listOf(kind);
  const exact = list.filter(
    (x) =>
      String(label(kind, x) || "")
        .toLowerCase()
        .trim() === q,
  );
  if (exact.length) return exact;
  const titleHits = list.filter((x) =>
    String(label(kind, x) || "")
      .toLowerCase()
      .includes(q),
  );
  if (titleHits.length) return titleHits;
  return list.filter((x) => searchText(kind, x).toLowerCase().includes(q));
}

function ambiguous(tag: string, kind: Kind, hits: any[], query: string): ActionResult {
  return {
    tag,
    status: "ambiguous",
    message: `${hits.length} ${KIND_PLURAL[kind]} match "${query}" (${hits.map((h) => `"${label(kind, h)}"`).join(", ")}). Nothing was changed — say exactly which one, or say "all ${query}".`,
  };
}

/** Parse `field=value; other=value` patch syntax used by UPDATE_* tags. */
function parseFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw || "").split(/\s*;\s*/)) {
    const m = part.match(/^([a-zA-Z]+)\s*=\s*([\s\S]*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/** Verify a mutation actually landed by re-reading the store. */
function verify(kind: Kind, id: string, check?: (x: any) => boolean): boolean {
  const found = listOf(kind).find((x) => x.id === id);
  if (!found) return false;
  return check ? check(found) : true;
}

// ---------------------------------------------------------------- synchronous executor for non-reminders
export function executeActionTags(input: string): { text: string; results: ActionResult[] } {
  let text = input;
  const results: ActionResult[] = [];

  const apply = (re: RegExp, fn: (m: string[]) => ActionResult) => {
    text = text.replace(re, (...args) => {
      const fullMatch = String(args[0] || "");
      const tagMatch = /\[\[([A-Z_]+)/.exec(fullMatch);
      if (tagMatch) {
        activity.set(actionActivity(tagMatch[1]));
      }
      const groups = args.slice(0, -2).map((x) => (typeof x === "string" ? x : ""));
      const res = fn(groups as string[]);
      if (res.status === "failed") {
        activity.set("action_failed");
      }
      results.push(res);
      return "";
    });
  };

  // ---------------- CREATE NOTE / MEMORY / PLAN / BILL
  apply(/\[\[ADD_NOTE:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi, (m) => {
    const title = m[1].trim();
    const body = m[2].trim();
    if (!title && !body)
      return {
        tag: "ADD_NOTE",
        status: "invalid",
        message: "A note needs a title or body — nothing was saved.",
      };
    const id = uid();
    upsert("note", { id, title, body, updatedAt: Date.now() } satisfies Note);
    return verify("note", id, (x) => x.body === body && x.title === title)
      ? { tag: "ADD_NOTE", status: "success", message: `Note saved: "${title}"` }
      : { tag: "ADD_NOTE", status: "failed", message: `Note "${title}" could not be saved.` };
  });


  apply(/\[\[ADD_MEMORY:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi, (m) => {
    const rawTopic = m[1].trim();
    const rawDetail = m[2].trim();
    const topic = rawTopic.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
    const detail = rawDetail.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
    if (!topic && !detail)
      return {
        tag: "ADD_MEMORY",
        status: "invalid",
        message: "A memory needs a topic — nothing was saved.",
      };
    const finalTopic = topic || detail.slice(0, 40);
    const id = uid();
    upsert("memory", {
      id,
      topic: finalTopic,
      detail,
      category: "general",
      provenance: "explicit_user",
      confidence: "high",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies Memory);
    return verify("memory", id, (x) => x.detail === detail)
      ? { tag: "ADD_MEMORY", status: "success", message: `Memory saved: "${finalTopic}"` }
      : { tag: "ADD_MEMORY", status: "failed", message: `Memory "${finalTopic}" could not be saved.` };
  });

  

  apply(/\[\[ADD_BILL:\s*([^|\]]+?)\s*\|\s*([^|\]]*?)\s*\|\s*([^|\]]*?)\s*\]\]/gi, (m) => {
    const name = m[1].trim();
    if (!name)
      return {
        tag: "ADD_BILL",
        status: "invalid",
        message: "A bill needs a name — nothing was saved.",
      };
    const amount = Number(m[2].trim().replace(/[^\d.]/g, "")) || 0;
    const id = uid();
    upsert("bill", {
      id,
      name,
      amount,
      balance: amount,
      dueDate: m[3].trim(),
      status: "due",
    } satisfies Bill);
    return verify("bill", id, (x) => x.amount === amount)
      ? {
          tag: "ADD_BILL",
          status: "success",
          message: `Bill saved: "${name}"${amount ? ` — ${amount}` : ""}`,
        }
      : { tag: "ADD_BILL", status: "failed", message: `Bill "${name}" could not be saved.` };
  });

  // ---------------- UPDATE
  const updateTag =
    (kind: Kind, tag: string, allowed: string[]) =>
    (m: string[]): ActionResult => {
      const query = m[1].trim();
      const hits = findMatches(kind, query);
      if (!hits.length)
        return {
          tag,
          status: "not_found",
          message: `No ${kind} matching "${query}" — nothing was changed.`,
        };
      if (hits.length > 1) return ambiguous(tag, kind, hits, query);
      const fields = parseFields(m[2] || "");
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) {
        return {
          tag,
          status: "invalid",
          message: `I need fields to change (${allowed.join(", ")}) — nothing was changed on "${label(kind, hits[0])}".`,
        };
      }
      const target = hits[0];
      const patch: Record<string, any> = {};
      for (const k of keys) {
        if (kind === "bill" && (k === "amount" || k === "balance")) {
          patch[k] = Number(fields[k].replace(/[^\d.]/g, "")) || 0;
        } else {
          patch[k] = fields[k];
        }
      }
      const next = { ...target, ...patch };
      if (kind === "note" || kind === "memory") next.updatedAt = Date.now();
      upsert(kind, next);
      const ok = verify(kind, target.id, (x) =>
        keys.every((k) => {
          if (k === "amount" || k === "balance")
            return String(x[k]) === String(next[k]);
          return x[k] === next[k];
        }),
      );
      if (!ok)
        return {
          tag,
          status: "failed",
          message: `Could not update ${kind} "${label(kind, target)}".`,
        };
      const what = keys
        .map((k) => `${k} → ${next[k]}`)
        .join(", ");
      return {
        tag,
        status: "success",
        message: `Updated ${kind} "${label(kind, next)}": ${what}`,
      };
    };

  apply(/\[\[UPDATE_NOTE:\s*([^|\]]+?)\s*\|\s*([^|\]]*?)\s*\|\s*([\s\S]*?)\s*\]\]/gi, (m) => {
    const query = m[1].trim();
    const hits = findMatches("note", query);
    if (!hits.length)
      return {
        tag: "UPDATE_NOTE",
        status: "not_found",
        message: `No note matching "${query}" — nothing was changed.`,
      };
    if (hits.length > 1) return ambiguous("UPDATE_NOTE", "note", hits, query);
    const n = hits[0] as Note;
    const title = m[2].trim() || n.title;
    const body = m[3].trim() || n.body;
    upsert("note", { ...n, title, body, updatedAt: Date.now() });
    return verify("note", n.id, (x) => x.title === title && x.body === body)
      ? { tag: "UPDATE_NOTE", status: "success", message: `Updated note "${title}".` }
      : { tag: "UPDATE_NOTE", status: "failed", message: `Could not update note "${n.title}".` };
  });


  apply(
    /\[\[UPDATE_MEMORY:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi,
    updateTag("memory", "UPDATE_MEMORY", ["topic", "detail"]),
  );
  
  apply(
    /\[\[UPDATE_BILL:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi,
    updateTag("bill", "UPDATE_BILL", ["name", "amount", "balance", "dueDate", "status"]),
  );

  // ---------------- DELETE
  apply(/\[\[DELETE_LAST:\s*(note|memory|bill)\s*\]\]/gi, (m) => {
    const kind = m[1].toLowerCase() as Kind;
    const list = listOf(kind);
    if (!list.length)
      return {
        tag: "DELETE_LAST",
        status: "not_found",
        message: `There are no ${KIND_PLURAL[kind]} to delete.`,
      };
    const victim = list[0];
    deleteById(kind, victim.id);
    return listOf(kind).some((x) => x.id === victim.id)
      ? {
          tag: "DELETE_LAST",
          status: "failed",
          message: `Could not delete ${kind} "${label(kind, victim)}".`,
        }
      : {
          tag: "DELETE_LAST",
          status: "success",
          message: `Deleted ${kind} "${label(kind, victim)}".`,
        };
  });
  apply(/\[\[DELETE_LAST:\s*(reminder)\s*\]\]/gi, () => ({ tag: "DELETE_LAST", status: "failed", message: "Reminder actions require asynchronous execution." }));

  const deleteTag =
    (kind: Kind, tag: string) =>
    (m: string[]): ActionResult => {
      const query = m[1].trim();
      const all = /^all\s+/i.test(query);
      const hits = findMatches(kind, query);
      if (!hits.length)
        return {
          tag,
          status: "not_found",
          message: `No ${kind} matching "${query}" — nothing was deleted.`,
        };
      if (hits.length > 1 && !all) return ambiguous(tag, kind, hits, query);
      hits.forEach((h) => deleteById(kind, h.id));
      const remaining = listOf(kind);
      const stuck = hits.filter((h) => remaining.some((x) => x.id === h.id));
      if (stuck.length)
        return {
          tag,
          status: "failed",
          message: `Could not delete ${stuck.length} ${KIND_PLURAL[kind]}.`,
        };
      return {
        tag,
        status: "success",
        message: `Deleted ${hits.length} ${hits.length === 1 ? kind : KIND_PLURAL[kind]}: ${hits.map((h) => `"${label(kind, h)}"`).join(", ")}.`,
      };
    };

  apply(/\[\[DELETE_NOTE:\s*([^\]]+?)\s*\]\]/gi, deleteTag("note", "DELETE_NOTE"));

  apply(/\[\[DELETE_MEMORY:\s*([^\]]+?)\s*\]\]/gi, deleteTag("memory", "DELETE_MEMORY"));
  
  apply(/\[\[DELETE_BILL:\s*([^\]]+?)\s*\]\]/gi, deleteTag("bill", "DELETE_BILL"));

  apply(/\[\[CLEAR_ALL:\s*(notes|memoriess|bills)\s*\]\]/gi, (m) => {
    const plural = m[1].toLowerCase();
    const kind = (Object.keys(KIND_PLURAL) as Kind[]).find((k) => KIND_PLURAL[k] === plural)!;
    const list = [...listOf(kind)];
    if (!list.length)
      return { tag: "CLEAR_ALL", status: "not_found", message: `There are no ${plural} to clear.` };
    list.forEach((x) => deleteById(kind, x.id));
    return listOf(kind).length
      ? {
          tag: "CLEAR_ALL",
          status: "failed",
          message: `Could not clear all ${plural} — ${listOf(kind).length} remain.`,
        }
      : { tag: "CLEAR_ALL", status: "success", message: `Cleared all ${list.length} ${plural}.` };
  });


  // ---------------- COMPLETE


  // Settings
  apply(/\[\[SET_SETTING:\s*([a-zA-Z0-9_-]+)\s*\|\s*([\s\S]*?)\s*\]\]/gi, (m) => {
    const tag = "SET_SETTING";
    const key = m[1].trim();
    const raw = m[2].trim();
    const cur = alphaStore.get().settings;
    const boolVal = /^true|yes|on|1$/i.test(raw);
    const boolKeys = [
      "soundEnabled",
      "voiceEnabled",
      "proactiveVoice",
      "backgroundEnabled",
      "autoSpeak",
      "autoSubmitVoice",
    ] as const;
    const ok = (msg: string, check: () => boolean): ActionResult =>
      check()
        ? { tag, status: "success", message: msg }
        : { tag, status: "failed", message: `Could not change ${key}.` };

    if ((boolKeys as readonly string[]).includes(key)) {
      alphaStore.setSettings({ [key]: boolVal } as any);
      return ok(
        `${key} ${boolVal ? "enabled" : "disabled"}.`,
        () => (alphaStore.get().settings as any)[key] === boolVal,
      );
    }
    if (key === "kokoroVoice") {
      alphaStore.setSettings({ kokoroVoice: raw });
      return ok(`Kokoro voice set to ${raw}.`, () => alphaStore.get().settings.kokoroVoice === raw);
    }
    if (key === "ttsRate") {
      const rate = Math.max(0.7, Math.min(1.4, Number(raw) || cur.ttsRate));
      alphaStore.setSettings({ ttsRate: rate });
      return ok(
        `Speech rate set to ${rate.toFixed(2)}x.`,
        () => alphaStore.get().settings.ttsRate === rate,
      );
    }
    if (key === "fastModel" || key === "thinkingModel" || key === "codingModel") {
      const lane = key.replace("Model", "") as "fast" | "thinking" | "coding";
      alphaStore.setSettings({ taskModels: { ...cur.taskModels, [lane]: raw } });
      return ok(
        `${lane} model set to ${raw}.`,
        () => alphaStore.get().settings.taskModels[lane] === raw,
      );
    }
    if (/^(?:eye|camera|vision)$/i.test(key)) {
      return {
        tag,
        status: "invalid",
        message: `Eye state cannot be changed via settings — use commands like "open your eyes" or "close your eyes".`,
      };
    }
    return {
      tag,
      status: "invalid",
      message: `"${key}" is not a setting I can change — nothing was changed.`,
    };
  });

  apply(/\[\[SET_PROFILE:\s*([^|\]]*?)\s*\|\s*([\s\S]*?)\s*\]\]/gi, (m) => {
    const p = alphaStore.get().profile;
    const name = m[1].trim() || p.name;
    const bio = m[2].trim() || p.bio;
    alphaStore.setProfile({ name, bio });
    const after = alphaStore.get().profile;
    return after.name === name && after.bio === bio
      ? {
          tag: "SET_PROFILE",
          status: "success",
          message: `Profile updated${name ? ` for ${name}` : ""}.`,
        }
      : { tag: "SET_PROFILE", status: "failed", message: "Could not update your profile." };
  });

  apply(/\[\[ADD_REMINDER:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([\s\S]*?)\s*)?\]\]/gi, () => ({ tag: "ADD_REMINDER", status: "failed", message: "Reminder actions require asynchronous execution." }));
  apply(/\[\[UPDATE_REMINDER:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi, () => ({ tag: "UPDATE_REMINDER", status: "failed", message: "Reminder actions require asynchronous execution." }));
  apply(/\[\[DELETE_REMINDER:\s*([^\]]+?)\s*\]\]/gi, () => ({ tag: "DELETE_REMINDER", status: "failed", message: "Reminder actions require asynchronous execution." }));
  apply(/\[\[MARK_REMINDER_DONE:\s*([^\]]+?)\s*\]\]/gi, () => ({ tag: "MARK_REMINDER_DONE", status: "failed", message: "Reminder actions require asynchronous execution." }));
  apply(/\[\[CLEAR_ALL:\s*(reminders)\s*\]\]/gi, () => ({ tag: "CLEAR_ALL_REMINDERS", status: "failed", message: "Reminder actions require asynchronous execution." }));
  
  apply(/\[\[([A-Z_]+)(?::[^\]]*)?\]\]/g, (m) => {
    // Leave CLEAR_ALL reminders dummy handling to the CLEAR_ALL generic handler above
    return {
      tag: m[1],
      status: "invalid",
      message: `I tried to use an action I don't support ("${m[1]}") — nothing was changed.`,
    };
  });

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), results };
}

/**
 * Asynchronous action-tag executor that routes reminder actions through the canonical
 * LocalReminderRepository / ReminderRepository and awaits persistence.
 */
export async function executeActionTagsAsync(
  input: string,
  options?: ExecuteActionTagsOptions,
): Promise<{ text: string; results: ActionResult[] }> {
  let text = input;
  const syncResult = executeActionTags(text);
  text = syncResult.text;
  const results: ActionResult[] = syncResult.results.filter(
    (r) => !["ADD_REMINDER", "UPDATE_REMINDER", "DELETE_REMINDER", "MARK_REMINDER_DONE", "CLEAR_ALL_REMINDERS"].includes(r.tag)
  );

  const effectiveUserId = options?.userId ?? (auth.currentUser?.uid || "local-user");
  const repo = options?.repo ?? new LocalReminderRepository();

  async function findReminderHits(query: string): Promise<FirestoreReminder[]> {
    try {
      const list = await repo.listReminders(effectiveUserId);
      const q = (query || "").toLowerCase().trim().replace(/^all\s+/, "");
      if (!q) return [];
      const exact = list.filter((r) => (r.title || "").toLowerCase().trim() === q);
      if (exact.length) return exact;
      const titleHits = list.filter((r) => (r.title || "").toLowerCase().includes(q));
      if (titleHits.length) return titleHits;
      return list.filter((r) => `${r.title} ${r.notes || ""}`.toLowerCase().includes(q));
    } catch {
      return [];
    }
  }

  // Handle ADD_REMINDER asynchronously
  const addRemRe = /\[\[ADD_REMINDER:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([\s\S]*?)\s*)?\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = addRemRe.exec(input)) !== null) {
    const fullMatch = match[0];
    const title = match[1].trim();
    const rawWhen = match[2].trim();
    const w = normalizeWhen(rawWhen);
    const notes = (match[3] || "").trim();
    activity.set(actionActivity("ADD_REMINDER"));

    if (!title) {
      results.push({
        tag: "ADD_REMINDER",
        status: "invalid",
        message: "An appointment or reminder needs a title — nothing was saved.",
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    const parsedMs = Date.parse(w.iso);
    if (!w.parsed || Number.isNaN(parsedMs) || !parsedMs) {
      activity.set("action_failed");
      results.push({
        tag: "ADD_REMINDER",
        status: "failed",
        message: `I couldn't understand when to remind you about "${title}" from "${rawWhen}". When would you like to be reminded? (e.g. "in 30 minutes" or "tomorrow at 9am")`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    const id = uid();
    const dueAt = parsedMs;
    const now = Date.now();
    try {
      await repo.createReminder(effectiveUserId, {
        id,
        userId: effectiveUserId,
        title,
        notes,
        dueAt,
        createdAt: now,
        updatedAt: now,
        reminderState: "active",
        notificationState: "pending",
      });
      results.push({
        tag: "ADD_REMINDER",
        status: "success",
        message: `Reminder saved: "${title}" — ${formatWhen(w.iso)}`,
      });
    } catch (err: any) {
      activity.set("action_failed");
      results.push({
        tag: "ADD_REMINDER",
        status: "failed",
        message: `Reminder "${title}" could not be saved: ${err?.message || "error"}`,
      });
    }
    text = text.replace(fullMatch, "");
  }

  // Handle UPDATE_REMINDER asynchronously
  const updRemRe = /\[\[UPDATE_REMINDER:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = updRemRe.exec(input)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set(actionActivity("UPDATE_REMINDER"));

    const hits = await findReminderHits(query);
    if (!hits.length) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "not_found",
        message: `No reminder matching "${query}" — nothing was changed.`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }
    if (hits.length > 1) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "ambiguous",
        message: `${hits.length} reminders match "${query}" (${hits.map((h) => `"${h.title}"`).join(", ")}). Nothing was changed — say exactly which one.`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    const target = hits[0];
    const fields = parseFields(match[2] || "");
    const allowed = ["title", "when", "notes", "done"];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "invalid",
        message: `I need fields to change (title, when, notes, done) — nothing was changed on "${target.title}".`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    const patch: Partial<FirestoreReminder> = { updatedAt: Date.now() };
    let invalidWhen = false;
    for (const k of keys) {
      if (k === "when") {
        const rawWhen = fields[k];
        const w = normalizeWhen(rawWhen);
        const parsedMs = Date.parse(w.iso);
        if (!w.parsed || Number.isNaN(parsedMs) || !parsedMs) {
          invalidWhen = true;
        } else {
          patch.dueAt = parsedMs;
        }
      } else if (k === "title") {
        patch.title = fields[k];
      } else if (k === "notes") {
        patch.notes = fields[k];
      } else if (k === "done") {
        patch.reminderState = fields[k] === "yes" || fields[k] === "true" ? "completed" : "active";
        if (patch.reminderState === "completed") patch.notificationState = "accepted";
      }
    }

    if (invalidWhen) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "failed",
        message: `Could not update reminder "${target.title}": I couldn't understand the time "${fields["when"]}". Please specify a clear time (e.g. "tomorrow at 9am").`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    try {
      await repo.updateReminder(effectiveUserId, target.id, patch);
      const what = keys
        .map((k) => `${k} → ${k === "when" && patch.dueAt ? formatWhen(new Date(patch.dueAt).toISOString()) : fields[k]}`)
        .join(", ");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "success",
        message: `Updated reminder "${target.title}": ${what}`,
      });
    } catch (err: any) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "failed",
        message: `Could not update reminder "${target.title}": ${err?.message || "error"}`,
      });
    }
    text = text.replace(fullMatch, "");
  }

  // Handle DELETE_REMINDER asynchronously
  const delRemRe = /\[\[DELETE_REMINDER:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = delRemRe.exec(input)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set(actionActivity("DELETE_REMINDER"));

    const all = /^all\s+/i.test(query);
    const hits = await findReminderHits(query);
    if (!hits.length) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_REMINDER",
        status: "not_found",
        message: `No reminder matching "${query}" — nothing was deleted.`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }
    if (hits.length > 1 && !all) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_REMINDER",
        status: "ambiguous",
        message: `${hits.length} reminders match "${query}" (${hits.map((h) => `"${h.title}"`).join(", ")}). Nothing was deleted.`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    try {
      for (const h of hits) {
        await repo.deleteReminder(effectiveUserId, h.id);
      }
      results.push({
        tag: "DELETE_REMINDER",
        status: "success",
        message: `Deleted ${hits.length} ${hits.length === 1 ? "reminder" : "reminders"}: ${hits.map((h) => `"${h.title}"`).join(", ")}.`,
      });
    } catch (err: any) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_REMINDER",
        status: "failed",
        message: `Could not delete reminders: ${err?.message || "error"}`,
      });
    }
    text = text.replace(fullMatch, "");
  }

  // Handle MARK_REMINDER_DONE asynchronously
  const markDoneRe = /\[\[MARK_REMINDER_DONE:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = markDoneRe.exec(input)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set(actionActivity("MARK_REMINDER_DONE"));

    const hits = await findReminderHits(query);
    if (!hits.length) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "not_found",
        message: `No reminder matching "${query}" — nothing was changed.`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }
    if (hits.length > 1) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "ambiguous",
        message: `${hits.length} reminders match "${query}" (${hits.map((h) => `"${h.title}"`).join(", ")}).`,
      });
      text = text.replace(fullMatch, "");
      continue;
    }

    const target = hits[0];
    try {
      await repo.updateReminder(effectiveUserId, target.id, {
        reminderState: "completed",
        notificationState: "accepted",
        updatedAt: Date.now(),
      });
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "success",
        message: `Marked reminder "${target.title}" as done ✅`,
      });
    } catch (err: any) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "failed",
        message: `Could not mark reminder "${target.title}" as done: ${err?.message || "error"}`,
      });
    }
    text = text.replace(fullMatch, "");
  }

  // Handle DELETE_LAST: reminder
  const delLastRemRe = /\[\[DELETE_LAST:\s*(reminder)\s*\]\]/gi;
  while ((match = delLastRemRe.exec(input)) !== null) {
    const fullMatch = match[0];
    activity.set(actionActivity("DELETE_LAST"));
    const list = await repo.listReminders(effectiveUserId);
    if (!list.length) {
      activity.set("action_failed");
      results.push({ tag: "DELETE_LAST", status: "not_found", message: "There are no reminders to delete." });
      text = text.replace(fullMatch, "");
      continue;
    }
    const victim = list[0];
    try {
      await repo.deleteReminder(effectiveUserId, victim.id);
      results.push({ tag: "DELETE_LAST", status: "success", message: `Deleted reminder "${victim.title}".` });
    } catch (err: any) {
      activity.set("action_failed");
      results.push({ tag: "DELETE_LAST", status: "failed", message: `Could not delete reminder: ${err?.message}` });
    }
    text = text.replace(fullMatch, "");
  }

  // Handle CLEAR_ALL: reminders
  const clearRemRe = /\[\[CLEAR_ALL:\s*(reminders)\s*\]\]/gi;
  while ((match = clearRemRe.exec(input)) !== null) {
    const fullMatch = match[0];
    activity.set(actionActivity("CLEAR_ALL"));
    const list = await repo.listReminders(effectiveUserId);
    if (!list.length) {
      activity.set("action_failed");
      results.push({ tag: "CLEAR_ALL", status: "not_found", message: "There are no reminders to clear." });
      text = text.replace(fullMatch, "");
      continue;
    }
    try {
      for (const r of list) {
        await repo.deleteReminder(effectiveUserId, r.id);
      }
      results.push({ tag: "CLEAR_ALL", status: "success", message: `Cleared all ${list.length} reminders.` });
    } catch (err: any) {
      activity.set("action_failed");
      results.push({ tag: "CLEAR_ALL", status: "failed", message: `Could not clear reminders: ${err?.message}` });
    }
    text = text.replace(fullMatch, "");
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), results };
}

const ICON: Record<ActionStatus, string> = {
  success: "✅",
  failed: "❌",
  ambiguous: "⚠️",
  not_found: "❌",
  invalid: "⚠️",
};

/** Render the execution record appended under Alpha's reply. */
export function renderActionReport(results: ActionResult[]): string {
  if (!results.length) return "";
  const lines = results.map((r) => `${ICON[r.status]} ${r.message}`);
  const anyBad = results.some((r) => r.status !== "success");
  return (
    (anyBad ? "**Action log — read this over anything I said above:**\n" : "") + lines.join("\n")
  );
}

const MUTATION_CLAIM =
  /\b(?:i(?:'ve| have)?\s+(?:just\s+)?(?:saved|added|created|deleted|removed|updated|changed|set|scheduled|cleared|marked|noted|remembered)|(?:done|saved|added|deleted|removed|updated|noted|remembered)\s*[.!]|it'?s\s+(?:saved|added|deleted|done|set|noted|remembered))\b/i;

export function claimsMutationWithoutTag(text: string): boolean {
  return MUTATION_CLAIM.test(text);
}

export const NO_ACTION_NOTICE =
  "⚠️ I described a change but did not actually perform one — nothing in your data was modified. Ask me again and I'll run the real action.";
