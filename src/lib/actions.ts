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
 *  - Canonical reminder repository persistence (owned by `src/lib/reminder-repo.ts`).
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
import {
  getCanonicalReminderCreateKey,
  getCanonicalReminderUpdateKey,
  getCanonicalReminderDeleteKey,
  getCanonicalReminderCompleteKey,
} from "./mutation-identity";
import type { RequestActionLifecycle } from "./request-lifecycle";

export type ActionStatus = "success" | "failed" | "ambiguous" | "not_found" | "invalid";

export interface ActionResult {
  tag: string;
  status: ActionStatus;
  message: string;
  logicalKeys?: string[];
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

async function deleteById(kind: Kind, id: string): Promise<void> {
  if (kind === "note") await alphaStore.deleteNote(id);
  else if (kind === "memory") await alphaStore.deleteMemory(id);
  else if (kind === "task") await alphaStore.deleteTask(id);
  else if (kind === "goal") await alphaStore.deleteGoal(id);
  else await alphaStore.deleteBill(id);
}

async function upsert(kind: Kind, item: any): Promise<void> {
  if (kind === "note") await alphaStore.upsertNote(item as Note);
  else if (kind === "memory") await alphaStore.upsertMemory(item as Memory);
  else if (kind === "task") await alphaStore.upsertTask(item as Task);
  else if (kind === "goal") await alphaStore.upsertGoal(item as Goal);
  else await alphaStore.upsertBill(item as Bill);
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

export interface ExecuteActionTagsOptions {
  userId?: string | null;
  repo?: ReminderRepository;
  toolSummary?: {
    hasMutation: boolean;
    allMutationsSucceeded: boolean;
    hasFailedMutation: boolean;
    results: Array<{
      name: string;
      success: boolean;
      isMutation: boolean;
      error?: any;
      logicalKeys?: string[];
    }>;
    executedLogicalKeys?: string[];
  };
  executedLogicalKeys?: string[] | Set<string>;
  lifecycle?: RequestActionLifecycle;
}

/**
 * Asynchronous action-tag executor that routes all mutations asynchronously,
 * awaits persistence before verification, and deduplicates mutations on a per-operation identity level.
 */
export async function executeActionTagsAsync(
  input: string,
  options?: ExecuteActionTagsOptions,
): Promise<{ text: string; results: ActionResult[] }> {
  let text = input;
  const results: ActionResult[] = [];
  const executedMutations = new Set<string>();

  // Seed successfully executed native logical mutation keys
  if (options?.executedLogicalKeys) {
    for (const key of options.executedLogicalKeys) {
      if (key) executedMutations.add(key.toLowerCase().trim());
    }
  }
  if (options?.toolSummary?.executedLogicalKeys) {
    for (const key of options.toolSummary.executedLogicalKeys) {
      if (key) executedMutations.add(key.toLowerCase().trim());
    }
  }
  if (options?.toolSummary?.results) {
    for (const res of options.toolSummary.results) {
      if (res.isMutation && res.success && res.logicalKeys) {
        for (const k of res.logicalKeys) {
          if (k) executedMutations.add(k.toLowerCase().trim());
        }
      }
    }
  }
  if (options?.lifecycle) {
    for (const key of options.lifecycle.getCompletedMutations().keys()) {
      if (key) executedMutations.add(key.toLowerCase().trim());
    }
  }

  const effectiveUserId = options?.userId ?? (auth.currentUser?.uid || "local-user");
  const repo = options?.repo ?? new LocalReminderRepository();

  async function findReminderHits(query: string): Promise<FirestoreReminder[]> {
    const list = await repo.listReminders(effectiveUserId);
    const q = (query || "").toLowerCase().trim().replace(/^all\s+/, "");
    if (!q) return [];
    const exact = list.filter((r) => (r.title || "").toLowerCase().trim() === q);
    if (exact.length) return exact;
    const titleHits = list.filter((r) => (r.title || "").toLowerCase().includes(q));
    if (titleHits.length) return titleHits;
    return list.filter((r) => `${r.title} ${r.notes || ""}`.toLowerCase().includes(q));
  }

  // ---------------- CREATE NOTE
  const addNoteRe = /\[\[ADD_NOTE:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = addNoteRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const title = match[1].trim();
    const body = match[2].trim();
    activity.set("writing_note");

    if (!title && !body) {
      results.push({
        tag: "ADD_NOTE",
        status: "invalid",
        message: "A note needs a title or body — nothing was saved.",
      });
      text = text.replace(fullMatch, "");
      addNoteRe.lastIndex = 0;
      continue;
    }
    const opKey = `note:add:${title.toLowerCase()}:${body.toLowerCase()}`;
    if (executedMutations.has(opKey)) {
      text = text.replace(fullMatch, "");
      addNoteRe.lastIndex = 0;
      continue;
    }
    executedMutations.add(opKey);
    const id = uid();
    await upsert("note", { id, title, body, updatedAt: Date.now() } satisfies Note);
    const ok = verify("note", id, (x) => x.body === body && x.title === title);
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "ADD_NOTE", status: "success", message: `Note saved: "${title}"` }
        : { tag: "ADD_NOTE", status: "failed", message: `Note "${title}" could not be saved.` }
    );
    text = text.replace(fullMatch, "");
    addNoteRe.lastIndex = 0;
  }

  // ---------------- CREATE MEMORY
  const addMemRe = /\[\[ADD_MEMORY:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = addMemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const rawTopic = match[1].trim();
    const rawDetail = match[2].trim();
    const topic = rawTopic.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
    const detail = rawDetail.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
    activity.set("writing_memory");

    if (!topic && !detail) {
      results.push({
        tag: "ADD_MEMORY",
        status: "invalid",
        message: "A memory needs a topic — nothing was saved.",
      });
      text = text.replace(fullMatch, "");
      addMemRe.lastIndex = 0;
      continue;
    }
    const finalTopic = topic || detail.slice(0, 40);
    const opKey = `memory:add:${finalTopic.toLowerCase()}:${detail.toLowerCase()}`;
    if (executedMutations.has(opKey)) {
      text = text.replace(fullMatch, "");
      addMemRe.lastIndex = 0;
      continue;
    }
    executedMutations.add(opKey);
    const id = uid();
    await upsert("memory", {
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
    const ok = verify("memory", id, (x) => x.detail === detail);
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "ADD_MEMORY", status: "success", message: `Memory saved: "${finalTopic}"` }
        : { tag: "ADD_MEMORY", status: "failed", message: `Memory "${finalTopic}" could not be saved.` }
    );
    text = text.replace(fullMatch, "");
    addMemRe.lastIndex = 0;
  }

  // ---------------- CREATE BILL
  const addBillRe = /\[\[ADD_BILL:\s*([^|\]]+?)\s*\|\s*([^|\]]*?)\s*\|\s*([^|\]]*?)\s*\]\]/gi;
  while ((match = addBillRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const name = match[1].trim();
    activity.set("writing_bill");

    if (!name) {
      results.push({
        tag: "ADD_BILL",
        status: "invalid",
        message: "A bill needs a name — nothing was saved.",
      });
      text = text.replace(fullMatch, "");
      addBillRe.lastIndex = 0;
      continue;
    }
    const amount = Number(match[2].trim().replace(/[^\d.]/g, "")) || 0;
    const dueDate = match[3].trim();
    const opKey = `bill:add:${name.toLowerCase()}:${amount}:${dueDate.toLowerCase()}`;
    if (executedMutations.has(opKey)) {
      text = text.replace(fullMatch, "");
      addBillRe.lastIndex = 0;
      continue;
    }
    executedMutations.add(opKey);
    const id = uid();
    await upsert("bill", {
      id,
      name,
      amount,
      balance: amount,
      dueDate,
      status: "due",
    } satisfies Bill);
    const ok = verify("bill", id, (x) => x.amount === amount);
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? {
            tag: "ADD_BILL",
            status: "success",
            message: `Bill saved: "${name}"${amount ? ` — ${amount}` : ""}`,
          }
        : { tag: "ADD_BILL", status: "failed", message: `Bill "${name}" could not be saved.` }
    );
    text = text.replace(fullMatch, "");
    addBillRe.lastIndex = 0;
  }

  // ---------------- UPDATE NOTE
  const updNoteRe = /\[\[UPDATE_NOTE:\s*([^|\]]+?)\s*\|\s*([^|\]]*?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = updNoteRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set("writing_note");
    const hits = findMatches("note", query);
    if (!hits.length) {
      results.push({
        tag: "UPDATE_NOTE",
        status: "not_found",
        message: `No note matching "${query}" — nothing was changed.`,
      });
      text = text.replace(fullMatch, "");
      updNoteRe.lastIndex = 0;
      continue;
    }
    if (hits.length > 1) {
      results.push(ambiguous("UPDATE_NOTE", "note", hits, query));
      text = text.replace(fullMatch, "");
      updNoteRe.lastIndex = 0;
      continue;
    }
    const n = hits[0] as Note;
    const title = match[2].trim() || n.title;
    const body = match[3].trim() || n.body;
    await upsert("note", { ...n, title, body, updatedAt: Date.now() });
    const ok = verify("note", n.id, (x) => x.title === title && x.body === body);
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "UPDATE_NOTE", status: "success", message: `Updated note "${title}".` }
        : { tag: "UPDATE_NOTE", status: "failed", message: `Could not update note "${n.title}".` }
    );
    text = text.replace(fullMatch, "");
    updNoteRe.lastIndex = 0;
  }

  // ---------------- UPDATE MEMORY & BILL HELPER
  const runAsyncUpdate = async (kind: Kind, tag: string, allowed: string[], query: string, rawFields: string): Promise<ActionResult> => {
    if (kind === "memory") activity.set("writing_memory");
    else if (kind === "bill") activity.set("writing_bill");
    const hits = findMatches(kind, query);
    if (!hits.length) {
      return {
        tag,
        status: "not_found",
        message: `No ${kind} matching "${query}" — nothing was changed.`,
      };
    }
    if (hits.length > 1) return ambiguous(tag, kind, hits, query);
    const fields = parseFields(rawFields);
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
    await upsert(kind, next);
    const ok = verify(kind, target.id, (x) =>
      keys.every((k) => {
        if (k === "amount" || k === "balance")
          return String(x[k]) === String(next[k]);
        return x[k] === next[k];
      }),
    );
    if (!ok) {
      activity.set("action_failed");
      return {
        tag,
        status: "failed",
        message: `Could not update ${kind} "${label(kind, target)}".`,
      };
    }
    const what = keys.map((k) => `${k} → ${next[k]}`).join(", ");
    return {
      tag,
      status: "success",
      message: `Updated ${kind} "${label(kind, next)}": ${what}`,
    };
  };

  const updMemRe = /\[\[UPDATE_MEMORY:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = updMemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const res = await runAsyncUpdate("memory", "UPDATE_MEMORY", ["topic", "detail"], match[1].trim(), match[2] || "");
    results.push(res);
    text = text.replace(fullMatch, "");
    updMemRe.lastIndex = 0;
  }

  const updBillRe = /\[\[UPDATE_BILL:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = updBillRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const res = await runAsyncUpdate("bill", "UPDATE_BILL", ["name", "amount", "balance", "dueDate", "status"], match[1].trim(), match[2] || "");
    results.push(res);
    text = text.replace(fullMatch, "");
    updBillRe.lastIndex = 0;
  }

  // ---------------- MARK BILL PAID
  const markBillPaidRe = /\[\[MARK_BILL_PAID:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = markBillPaidRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set("writing_bill");
    const hits = findMatches("bill", query);
    if (!hits.length) {
      results.push({ tag: "MARK_BILL_PAID", status: "not_found", message: `No bill matching "${query}".` });
      text = text.replace(fullMatch, "");
      markBillPaidRe.lastIndex = 0;
      continue;
    }
    if (hits.length > 1) {
      results.push(ambiguous("MARK_BILL_PAID", "bill", hits, query));
      text = text.replace(fullMatch, "");
      markBillPaidRe.lastIndex = 0;
      continue;
    }
    const b = hits[0] as Bill;
    const next = { ...b, balance: 0, status: "paid" as const };
    await upsert("bill", next);
    const ok = verify("bill", b.id, (x) => x.status === "paid");
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "MARK_BILL_PAID", status: "success", message: `Marked bill "${b.name}" as paid.` }
        : { tag: "MARK_BILL_PAID", status: "failed", message: `Could not mark bill "${b.name}" as paid.` }
    );
    text = text.replace(fullMatch, "");
    markBillPaidRe.lastIndex = 0;
  }

  // ---------------- DELETE LAST (note|memory|bill)
  const delLastRe = /\[\[DELETE_LAST:\s*(note|memory|bill)\s*\]\]/gi;
  while ((match = delLastRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const kind = match[1].toLowerCase() as Kind;
    if (kind === "note") activity.set("writing_note");
    else if (kind === "memory") activity.set("writing_memory");
    else if (kind === "bill") activity.set("writing_bill");
    const list = listOf(kind);
    if (!list.length) {
      results.push({
        tag: "DELETE_LAST",
        status: "not_found",
        message: `There are no ${KIND_PLURAL[kind]} to delete.`,
      });
      text = text.replace(fullMatch, "");
      delLastRe.lastIndex = 0;
      continue;
    }
    const victim = list[0];
    await deleteById(kind, victim.id);
    const ok = !listOf(kind).some((x) => x.id === victim.id);
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "DELETE_LAST", status: "success", message: `Deleted ${kind} "${label(kind, victim)}".` }
        : { tag: "DELETE_LAST", status: "failed", message: `Could not delete ${kind} "${label(kind, victim)}".` }
    );
    text = text.replace(fullMatch, "");
    delLastRe.lastIndex = 0;
  }

  // ---------------- DELETE SPECIFIC (note|memory|bill)
  const runAsyncDelete = async (kind: Kind, tag: string, query: string): Promise<ActionResult> => {
    if (kind === "note") activity.set("writing_note");
    else if (kind === "memory") activity.set("writing_memory");
    else if (kind === "bill") activity.set("writing_bill");
    const all = /^all\s+/i.test(query);
    const hits = findMatches(kind, query);
    if (!hits.length) {
      return {
        tag,
        status: "not_found",
        message: `No ${kind} matching "${query}" — nothing was deleted.`,
      };
    }
    if (hits.length > 1 && !all) return ambiguous(tag, kind, hits, query);
    for (const h of hits) {
      await deleteById(kind, h.id);
    }
    const remaining = listOf(kind);
    const stuck = hits.filter((h) => remaining.some((x) => x.id === h.id));
    if (stuck.length) {
      activity.set("action_failed");
      return {
        tag,
        status: "failed",
        message: `Could not delete ${stuck.length} ${KIND_PLURAL[kind]}.`,
      };
    }
    return {
      tag,
      status: "success",
      message: `Deleted ${hits.length} ${hits.length === 1 ? kind : KIND_PLURAL[kind]}: ${hits.map((h) => `"${label(kind, h)}"`).join(", ")}.`,
    };
  };

  const delNoteRe = /\[\[DELETE_NOTE:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = delNoteRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const res = await runAsyncDelete("note", "DELETE_NOTE", match[1].trim());
    results.push(res);
    text = text.replace(fullMatch, "");
    delNoteRe.lastIndex = 0;
  }

  const delMemRe = /\[\[DELETE_MEMORY:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = delMemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const res = await runAsyncDelete("memory", "DELETE_MEMORY", match[1].trim());
    results.push(res);
    text = text.replace(fullMatch, "");
    delMemRe.lastIndex = 0;
  }

  const delBillRe = /\[\[DELETE_BILL:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = delBillRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const res = await runAsyncDelete("bill", "DELETE_BILL", match[1].trim());
    results.push(res);
    text = text.replace(fullMatch, "");
    delBillRe.lastIndex = 0;
  }

  // ---------------- CLEAR ALL (notes|memories|bills)
  const clearAllRe = /\[\[CLEAR_ALL:\s*(notes|memories|bills)\s*\]\]/gi;
  while ((match = clearAllRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const plural = match[1].toLowerCase();
    const kind = (Object.keys(KIND_PLURAL) as Kind[]).find((k) => KIND_PLURAL[k] === plural)!;
    if (kind === "note") activity.set("writing_note");
    else if (kind === "memory") activity.set("writing_memory");
    else if (kind === "bill") activity.set("writing_bill");
    const list = [...listOf(kind)];
    if (!list.length) {
      results.push({ tag: "CLEAR_ALL", status: "not_found", message: `There are no ${plural} to clear.` });
      text = text.replace(fullMatch, "");
      clearAllRe.lastIndex = 0;
      continue;
    }
    for (const x of list) {
      await deleteById(kind, x.id);
    }
    const ok = listOf(kind).length === 0;
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "CLEAR_ALL", status: "success", message: `Cleared all ${list.length} ${plural}.` }
        : { tag: "CLEAR_ALL", status: "failed", message: `Could not clear all ${plural} — ${listOf(kind).length} remain.` }
    );
    text = text.replace(fullMatch, "");
    clearAllRe.lastIndex = 0;
  }

  // ---------------- SETTINGS & PROFILE
  const setSettingRe = /\[\[SET_SETTING:\s*([a-zA-Z0-9_-]+)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = setSettingRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const tag = "SET_SETTING";
    const key = match[1].trim();
    const raw = match[2].trim();
    activity.set("editing_settings");
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

    if ((boolKeys as readonly string[]).includes(key)) {
      await alphaStore.setSettings({ [key]: boolVal } as any);
      const ok = (alphaStore.get().settings as any)[key] === boolVal;
      if (!ok) activity.set("action_failed");
      results.push(
        ok
          ? { tag, status: "success", message: `${key} ${boolVal ? "enabled" : "disabled"}.` }
          : { tag, status: "failed", message: `Could not change ${key}.` }
      );
    } else if (key === "kokoroVoice") {
      await alphaStore.setSettings({ kokoroVoice: raw });
      const ok = alphaStore.get().settings.kokoroVoice === raw;
      if (!ok) activity.set("action_failed");
      results.push(
        ok
          ? { tag, status: "success", message: `Kokoro voice set to ${raw}.` }
          : { tag, status: "failed", message: `Could not change ${key}.` }
      );
    } else if (key === "ttsRate") {
      const rate = Math.max(0.7, Math.min(1.4, Number(raw) || cur.ttsRate));
      await alphaStore.setSettings({ ttsRate: rate });
      const ok = alphaStore.get().settings.ttsRate === rate;
      if (!ok) activity.set("action_failed");
      results.push(
        ok
          ? { tag, status: "success", message: `Speech rate set to ${rate.toFixed(2)}x.` }
          : { tag, status: "failed", message: `Could not change ${key}.` }
      );
    } else if (key === "fastModel" || key === "thinkingModel" || key === "codingModel") {
      const lane = key.replace("Model", "") as "fast" | "thinking" | "coding";
      await alphaStore.setSettings({ taskModels: { ...cur.taskModels, [lane]: raw } });
      const ok = alphaStore.get().settings.taskModels[lane] === raw;
      if (!ok) activity.set("action_failed");
      results.push(
        ok
          ? { tag, status: "success", message: `${lane} model set to ${raw}.` }
          : { tag, status: "failed", message: `Could not change ${key}.` }
      );
    } else if (/^(?:eye|camera|vision)$/i.test(key)) {
      results.push({
        tag,
        status: "invalid",
        message: `Eye state cannot be changed via settings — use commands like "open your eyes" or "close your eyes".`,
      });
    } else {
      results.push({
        tag,
        status: "invalid",
        message: `"${key}" is not a setting I can change — nothing was changed.`,
      });
    }
    text = text.replace(fullMatch, "");
    setSettingRe.lastIndex = 0;
  }

  const setProfileRe = /\[\[SET_PROFILE:\s*([^|\]]*?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = setProfileRe.exec(text)) !== null) {
    const fullMatch = match[0];
    activity.set("editing_settings");
    const p = alphaStore.get().profile;
    const name = match[1].trim() || p.name;
    const bio = match[2].trim() || p.bio;
    await alphaStore.setProfile({ name, bio });
    const after = alphaStore.get().profile;
    const ok = after.name === name && after.bio === bio;
    if (!ok) activity.set("action_failed");
    results.push(
      ok
        ? { tag: "SET_PROFILE", status: "success", message: `Profile updated${name ? ` for ${name}` : ""}.` }
        : { tag: "SET_PROFILE", status: "failed", message: "Could not update your profile." }
    );
    text = text.replace(fullMatch, "");
    setProfileRe.lastIndex = 0;
  }

  // ---------------- REMINDERS (Individual Logical Operation Deduplication)
  // Handle ADD_REMINDER asynchronously
  const addRemRe = /\[\[ADD_REMINDER:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([\s\S]*?)\s*)?\]\]/gi;
  while ((match = addRemRe.exec(text)) !== null) {
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
      addRemRe.lastIndex = 0;
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
      addRemRe.lastIndex = 0;
      continue;
    }

    const id = uid();
    const dueAt = parsedMs;
    const keyWithParsedDue = getCanonicalReminderCreateKey({ title, dueAt, notes });
    const keyWithRawDue = getCanonicalReminderCreateKey({ title, dueAt: rawWhen, notes });

    if (
      executedMutations.has(keyWithParsedDue) ||
      executedMutations.has(keyWithRawDue)
    ) {
      // Suppress redundant mutation — already executed authoritatively in this turn
      text = text.replace(fullMatch, "");
      addRemRe.lastIndex = 0;
      continue;
    }
    executedMutations.add(keyWithParsedDue);
    executedMutations.add(keyWithRawDue);
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
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "ADD_REMINDER",
        status: "failed",
        message: `Reminder "${title}" could not be saved: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    text = text.replace(fullMatch, "");
    addRemRe.lastIndex = 0;
  }

  // Handle UPDATE_REMINDER asynchronously
  const updRemRe = /\[\[UPDATE_REMINDER:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;
  while ((match = updRemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    const lcQuery = query.toLowerCase();
    activity.set(actionActivity("UPDATE_REMINDER"));

    let hits: FirestoreReminder[];
    try {
      hits = await findReminderHits(query);
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "failed",
        message: `Could not access reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
      text = text.replace(fullMatch, "");
      updRemRe.lastIndex = 0;
      continue;
    }

    if (!hits.length) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "not_found",
        message: `No reminder matching "${query}" — nothing was changed.`,
      });
      text = text.replace(fullMatch, "");
      updRemRe.lastIndex = 0;
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
      updRemRe.lastIndex = 0;
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
      updRemRe.lastIndex = 0;
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
      updRemRe.lastIndex = 0;
      continue;
    }

    const canonicalUpdateKey = getCanonicalReminderUpdateKey({ targetId: target.id, patch });
    const canonicalUpdateKeyRaw = fields.when
      ? getCanonicalReminderUpdateKey({ targetId: target.id, patch: { ...patch, dueAt: fields.when } })
      : null;

    if (
      executedMutations.has(canonicalUpdateKey) ||
      (canonicalUpdateKeyRaw && executedMutations.has(canonicalUpdateKeyRaw))
    ) {
      text = text.replace(fullMatch, "");
      updRemRe.lastIndex = 0;
      continue;
    }

    executedMutations.add(canonicalUpdateKey);
    if (canonicalUpdateKeyRaw) executedMutations.add(canonicalUpdateKeyRaw);

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
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "failed",
        message: `Could not update reminder "${target.title}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    text = text.replace(fullMatch, "");
    updRemRe.lastIndex = 0;
  }

  // Handle DELETE_REMINDER asynchronously
  const delRemRe = /\[\[DELETE_REMINDER:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = delRemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set(actionActivity("DELETE_REMINDER"));

    const all = /^all\s+/i.test(query);
    let hits: FirestoreReminder[];
    try {
      hits = await findReminderHits(query);
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_REMINDER",
        status: "failed",
        message: `Could not access reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
      text = text.replace(fullMatch, "");
      delRemRe.lastIndex = 0;
      continue;
    }

    if (!hits.length) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_REMINDER",
        status: "not_found",
        message: `No reminder matching "${query}" — nothing was deleted.`,
      });
      text = text.replace(fullMatch, "");
      delRemRe.lastIndex = 0;
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
      delRemRe.lastIndex = 0;
      continue;
    }

    const targetIds = hits.map((h) => h.id);
    const setKey = getCanonicalReminderDeleteKey({ targetIds });
    const singleKeys = targetIds.map((id) => getCanonicalReminderDeleteKey({ targetIds: [id] }));

    if (
      executedMutations.has(setKey) ||
      (targetIds.length === 1 && executedMutations.has(singleKeys[0]))
    ) {
      text = text.replace(fullMatch, "");
      delRemRe.lastIndex = 0;
      continue;
    }

    executedMutations.add(setKey);
    for (const k of singleKeys) executedMutations.add(k);

    try {
      for (const h of hits) {
        await repo.deleteReminder(effectiveUserId, h.id);
      }
      results.push({
        tag: "DELETE_REMINDER",
        status: "success",
        message: `Deleted ${hits.length} ${hits.length === 1 ? "reminder" : "reminders"}: ${hits.map((h) => `"${h.title}"`).join(", ")}.`,
      });
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_REMINDER",
        status: "failed",
        message: `Could not delete reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    text = text.replace(fullMatch, "");
    delRemRe.lastIndex = 0;
  }

  // Handle MARK_REMINDER_DONE asynchronously
  const markDoneRe = /\[\[MARK_REMINDER_DONE:\s*([^\]]+?)\s*\]\]/gi;
  while ((match = markDoneRe.exec(text)) !== null) {
    const fullMatch = match[0];
    const query = match[1].trim();
    activity.set(actionActivity("MARK_REMINDER_DONE"));

    let hits: FirestoreReminder[];
    try {
      hits = await findReminderHits(query);
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "failed",
        message: `Could not access reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
      text = text.replace(fullMatch, "");
      markDoneRe.lastIndex = 0;
      continue;
    }

    if (!hits.length) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "not_found",
        message: `No reminder matching "${query}" — nothing was changed.`,
      });
      text = text.replace(fullMatch, "");
      markDoneRe.lastIndex = 0;
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
      markDoneRe.lastIndex = 0;
      continue;
    }

    const target = hits[0];
    const compKey = getCanonicalReminderCompleteKey({ targetId: target.id });
    const updKey = getCanonicalReminderUpdateKey({
      targetId: target.id,
      patch: { reminderState: "completed" },
    });

    if (executedMutations.has(compKey) || executedMutations.has(updKey)) {
      text = text.replace(fullMatch, "");
      markDoneRe.lastIndex = 0;
      continue;
    }

    executedMutations.add(compKey);
    executedMutations.add(updKey);

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
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "failed",
        message: `Could not mark reminder "${target.title}" as done: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    text = text.replace(fullMatch, "");
    markDoneRe.lastIndex = 0;
  }

  // Handle DELETE_LAST: reminder
  const delLastRemRe = /\[\[DELETE_LAST:\s*(reminder)\s*\]\]/gi;
  while ((match = delLastRemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    activity.set(actionActivity("DELETE_LAST"));

    let list: FirestoreReminder[];
    try {
      list = await repo.listReminders(effectiveUserId);
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_LAST",
        status: "failed",
        message: `Could not access reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
      text = text.replace(fullMatch, "");
      delLastRemRe.lastIndex = 0;
      continue;
    }
    if (!list.length) {
      activity.set("action_failed");
      results.push({ tag: "DELETE_LAST", status: "not_found", message: "There are no reminders to delete." });
      text = text.replace(fullMatch, "");
      delLastRemRe.lastIndex = 0;
      continue;
    }
    const victim = list[0];
    const victimKey = getCanonicalReminderDeleteKey({ targetIds: [victim.id] });
    if (executedMutations.has(victimKey)) {
      text = text.replace(fullMatch, "");
      delLastRemRe.lastIndex = 0;
      continue;
    }

    executedMutations.add(victimKey);

    try {
      await repo.deleteReminder(effectiveUserId, victim.id);
      results.push({ tag: "DELETE_LAST", status: "success", message: `Deleted reminder "${victim.title}".` });
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_LAST",
        status: "failed",
        message: `Could not delete reminder: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    text = text.replace(fullMatch, "");
    delLastRemRe.lastIndex = 0;
  }

  // Handle CLEAR_ALL: reminders
  const clearRemRe = /\[\[CLEAR_ALL:\s*(reminders)\s*\]\]/gi;
  while ((match = clearRemRe.exec(text)) !== null) {
    const fullMatch = match[0];
    activity.set(actionActivity("CLEAR_ALL"));

    if (
      executedMutations.has("rem:clear_all") ||
      executedMutations.has("reminder:clear_all")
    ) {
      text = text.replace(fullMatch, "");
      clearRemRe.lastIndex = 0;
      continue;
    }

    let list: FirestoreReminder[];
    try {
      list = await repo.listReminders(effectiveUserId);
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "CLEAR_ALL",
        status: "failed",
        message: `Could not access reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
      text = text.replace(fullMatch, "");
      clearRemRe.lastIndex = 0;
      continue;
    }
    if (!list.length) {
      activity.set("action_failed");
      results.push({ tag: "CLEAR_ALL", status: "not_found", message: "There are no reminders to clear." });
      text = text.replace(fullMatch, "");
      clearRemRe.lastIndex = 0;
      continue;
    }

    executedMutations.add("rem:clear_all");
    executedMutations.add("reminder:clear_all");

    try {
      for (const r of list) {
        await repo.deleteReminder(effectiveUserId, r.id);
      }
      results.push({ tag: "CLEAR_ALL", status: "success", message: `Cleared all ${list.length} reminders.` });
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "CLEAR_ALL",
        status: "failed",
        message: `Could not clear reminders: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    text = text.replace(fullMatch, "");
    clearRemRe.lastIndex = 0;
  }

  // ---------------- UNSUPPORTED TAG CATCH-ALL
  const unknownTagRe = /\[\[([A-Z_]+)(?::[^\]]*)?\]\]/g;
  while ((match = unknownTagRe.exec(text)) !== null) {
    const fullMatch = match[0];
    results.push({
      tag: match[1],
      status: "invalid",
      message: `I tried to use an action I don't support ("${match[1]}") — nothing was changed.`,
    });
    text = text.replace(fullMatch, "");
    unknownTagRe.lastIndex = 0;
  }

  if (options?.lifecycle) {
    for (const res of results) {
      if (res.status === "success") {
        options.lifecycle.recordSuccess({
          name: res.tag,
          isMutation: true,
          result: res.message,
          logicalKeys: res.logicalKeys,
        });
      } else if (res.status === "failed") {
        options.lifecycle.recordFailure({
          name: res.tag,
          isMutation: true,
          error: res.message,
        });
      } else if (res.status === "ambiguous") {
        options.lifecycle.recordClarification(res.message, res.tag);
      }
    }
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), results };
}

/**
 * Synchronous executor is permanently eliminated in favor of executeActionTagsAsync.
 * Aliased directly to executeActionTagsAsync to satisfy any callers with full async safety.
 */
export const executeActionTags = executeActionTagsAsync;

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
