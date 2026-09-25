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
import { normalizeWhen, formatWhen, isAmbiguousTime } from "./when";
import { activity, actionActivity } from "./activity";
import { auth } from "./firebase";
import { reminderContextManager } from "./reminder-context";
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
  getCanonicalNoteKey,
  getCanonicalMemoryKey,
  getCanonicalBillKey,
  getCanonicalTaskKey,
  getCanonicalNoteCreateKey,
  getCanonicalMemoryCreateKey,
  getCanonicalBillCreateKey,
  getCanonicalTaskCreateKey,
  getCanonicalSettingKey,
  getCanonicalProfileKey,
  getCanonicalBulkDeleteKey,
  getCanonicalClearAllKey,
  getCanonicalUpdateKey,
  getCanonicalDeleteKey,
  getCanonicalBillMarkPaidKey,
} from "./mutation-identity";
import type { RequestActionLifecycle } from "./request-lifecycle";
import { getReminderTool } from "./tool-registry";

export type ActionStatus = "success" | "failed" | "ambiguous" | "not_found" | "invalid" | "partial";

export interface ActionResult {
  tag: string;
  status: ActionStatus;
  message: string;
  logicalKeys?: string[];
  failedKeys?: string[];
  structuredResult?: any;
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
    const opKey = getCanonicalNoteCreateKey(title, body);
    if (executedMutations.has(opKey)) {
      text = text.replace(fullMatch, "");
      addNoteRe.lastIndex = 0;
      continue;
    }
    const id = uid();
    try {
      await upsert("note", { id, title, body, updatedAt: Date.now() } satisfies Note);
      const ok = verify("note", id, (x) => x.body === body && x.title === title);
      if (!ok) {
        activity.set("action_failed");
        results.push({ tag: "ADD_NOTE", status: "failed", message: `Note "${title}" could not be saved.` });
      } else {
        executedMutations.add(opKey);
        results.push({ tag: "ADD_NOTE", status: "success", message: `Note saved: "${title}"`, logicalKeys: [opKey] });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({ tag: "ADD_NOTE", status: "failed", message: `Note "${title}" could not be saved: ${err instanceof Error ? err.message : String(err)}` });
    }
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
    const opKey = getCanonicalMemoryCreateKey(finalTopic, detail);
    if (executedMutations.has(opKey)) {
      text = text.replace(fullMatch, "");
      addMemRe.lastIndex = 0;
      continue;
    }
    const id = uid();
    try {
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
      if (!ok) {
        activity.set("action_failed");
        results.push({ tag: "ADD_MEMORY", status: "failed", message: `Memory "${finalTopic}" could not be saved.` });
      } else {
        executedMutations.add(opKey);
        results.push({ tag: "ADD_MEMORY", status: "success", message: `Memory saved: "${finalTopic}"`, logicalKeys: [opKey] });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({ tag: "ADD_MEMORY", status: "failed", message: `Memory "${finalTopic}" could not be saved: ${err instanceof Error ? err.message : String(err)}` });
    }
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
    const opKey = getCanonicalBillCreateKey(name, amount, dueDate);
    if (executedMutations.has(opKey)) {
      text = text.replace(fullMatch, "");
      addBillRe.lastIndex = 0;
      continue;
    }
    const id = uid();
    try {
      await upsert("bill", {
        id,
        name,
        amount,
        balance: amount,
        dueDate,
        status: "due",
      } satisfies Bill);
      const ok = verify("bill", id, (x) => x.amount === amount);
      if (!ok) {
        activity.set("action_failed");
        results.push({ tag: "ADD_BILL", status: "failed", message: `Bill "${name}" could not be saved.` });
      } else {
        executedMutations.add(opKey);
        results.push({
          tag: "ADD_BILL",
          status: "success",
          message: `Bill saved: "${name}"${amount ? ` — ${amount}` : ""}`,
          logicalKeys: [opKey],
        });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({ tag: "ADD_BILL", status: "failed", message: `Bill "${name}" could not be saved: ${err instanceof Error ? err.message : String(err)}` });
    }
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
    const updateKey = getCanonicalUpdateKey("note", n.id, { title, body });
    if (executedMutations.has(updateKey)) {
      text = text.replace(fullMatch, "");
      updNoteRe.lastIndex = 0;
      continue;
    }
    try {
      await upsert("note", { ...n, title, body, updatedAt: Date.now() });
      const ok = verify("note", n.id, (x) => x.title === title && x.body === body);
      if (!ok) {
        activity.set("action_failed");
        results.push({
          tag: "UPDATE_NOTE",
          status: "failed",
          message: `Could not update note "${n.title}".`,
        });
      } else {
        executedMutations.add(updateKey);
        results.push({
          tag: "UPDATE_NOTE",
          status: "success",
          message: `Updated note "${title}".`,
          logicalKeys: [updateKey],
        });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "UPDATE_NOTE",
        status: "failed",
        message: `Could not update note "${n.title}": ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
    const updateKey = getCanonicalUpdateKey(kind, target.id, patch);
    const what = keys.map((k) => `${k} → ${next[k]}`).join(", ");
    return {
      tag,
      status: "success",
      message: `Updated ${kind} "${label(kind, next)}": ${what}`,
      logicalKeys: [updateKey],
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
    const paidKey = getCanonicalBillMarkPaidKey(b.id);
    if (executedMutations.has(paidKey)) {
      text = text.replace(fullMatch, "");
      markBillPaidRe.lastIndex = 0;
      continue;
    }
    try {
      await upsert("bill", next);
      const ok = verify("bill", b.id, (x) => x.status === "paid");
      if (!ok) {
        activity.set("action_failed");
        results.push({
          tag: "MARK_BILL_PAID",
          status: "failed",
          message: `Could not mark bill "${b.name}" as paid.`,
          logicalKeys: [paidKey],
          failedKeys: [paidKey],
          structuredResult: next,
        });
      } else {
        executedMutations.add(paidKey);
        results.push({
          tag: "MARK_BILL_PAID",
          status: "success",
          message: `Marked bill "${b.name}" as paid.`,
          logicalKeys: [paidKey],
          structuredResult: next,
        });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_BILL_PAID",
        status: "failed",
        message: `Could not mark bill "${b.name}" as paid: ${err instanceof Error ? err.message : String(err)}`,
        logicalKeys: [paidKey],
        failedKeys: [paidKey],
        structuredResult: next,
      });
    }
    text = text.replace(fullMatch, "");
    markBillPaidRe.lastIndex = 0;
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
    const targetIds = hits.map(h => h.id);
    const sortedIds = Array.from(new Set(targetIds)).sort();
    const bulkKey = getCanonicalBulkDeleteKey(kind, sortedIds);

    const intendedIds = sortedIds;
    const successfulIds: string[] = [];
    const successfulKeys: string[] = [];
    const failedIds: string[] = [];

    for (const h of hits) {
      const singleKey = getCanonicalDeleteKey(kind, h.id);
      if (executedMutations.has(singleKey)) {
        successfulIds.push(h.id);
        successfulKeys.push(singleKey);
        continue;
      }
      try {
        await deleteById(kind, h.id);
        const remaining = listOf(kind);
        const gone = !remaining.some((x) => x.id === h.id);
        if (gone) {
          successfulIds.push(h.id);
          successfulKeys.push(singleKey);
          executedMutations.add(singleKey);
        } else {
          failedIds.push(h.id);
        }
      } catch (err) {
        failedIds.push(h.id);
      }
    }

    if (successfulIds.length === 0) {
      activity.set("action_failed");
      const failedKeys = intendedIds.map((id) => getCanonicalDeleteKey(kind, id));
      return {
        tag,
        status: "failed",
        message: `Could not delete ${kind}.`,
        failedKeys,
        structuredResult: { count: 0, targetIds: intendedIds, successfulIds: [], failedIds: intendedIds },
      };
    } else if (successfulIds.length === intendedIds.length) {
      if (hits.length > 1) {
        executedMutations.add(bulkKey);
      }
      return {
        tag,
        status: "success",
        message: `Deleted ${hits.length} ${hits.length === 1 ? kind : KIND_PLURAL[kind]}: ${hits.map((h) => `"${label(kind, h)}"`).join(", ")}.`,
        logicalKeys: hits.length > 1 ? [bulkKey, ...successfulKeys] : [...successfulKeys],
        structuredResult: { count: successfulIds.length, targetIds: intendedIds, successfulIds },
      };
    } else {
      activity.set("action_failed");
      const failedKeys = failedIds.map((id) => getCanonicalDeleteKey(kind, id));
      return {
        tag,
        status: "partial",
        message: `Deleted ${successfulIds.length} out of ${intendedIds.length} ${KIND_PLURAL[kind]} (${failedIds.length} failed).`,
        logicalKeys: [...successfulKeys],
        failedKeys,
        structuredResult: { count: successfulIds.length, targetIds: intendedIds, successfulIds, failedIds },
      };
    }
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
    const targetIds = list.map(x => x.id);
    const sortedIds = Array.from(new Set(targetIds)).sort();
    const bulkKey = getCanonicalBulkDeleteKey(kind, sortedIds);
    const clearKey = getCanonicalClearAllKey(plural);

    const intendedIds = sortedIds;
    const successfulIds: string[] = [];
    const successfulKeys: string[] = [];
    const failedIds: string[] = [];

    for (const id of intendedIds) {
      const singleKey = getCanonicalDeleteKey(kind, id);
      if (executedMutations.has(singleKey)) {
        successfulIds.push(id);
        successfulKeys.push(singleKey);
        continue;
      }
      try {
        await deleteById(kind, id);
        const remaining = listOf(kind);
        const gone = !remaining.some((x) => x.id === id);
        if (gone) {
          successfulIds.push(id);
          successfulKeys.push(singleKey);
          executedMutations.add(singleKey);
        } else {
          failedIds.push(id);
        }
      } catch (err) {
        failedIds.push(id);
      }
    }

    if (successfulIds.length === 0) {
      activity.set("action_failed");
      const failedKeys = intendedIds.map((id) => getCanonicalDeleteKey(kind, id));
      results.push({
        tag: "CLEAR_ALL",
        status: "failed",
        message: `Could not clear ${plural}.`,
        failedKeys,
        structuredResult: { count: 0, targetIds: intendedIds, successfulIds: [], failedIds: intendedIds },
      });
    } else if (successfulIds.length === intendedIds.length) {
      executedMutations.add(bulkKey);
      executedMutations.add(clearKey);
      results.push({
        tag: "CLEAR_ALL",
        status: "success",
        message: `Cleared all ${list.length} ${plural}.`,
        logicalKeys: [bulkKey, clearKey, ...successfulKeys],
        structuredResult: { count: successfulIds.length, targetIds: intendedIds, successfulIds },
      });
    } else {
      activity.set("action_failed");
      const failedKeys = failedIds.map((id) => getCanonicalDeleteKey(kind, id));
      results.push({
        tag: "CLEAR_ALL",
        status: "partial",
        message: `Cleared ${successfulIds.length} out of ${intendedIds.length} ${plural} (${failedIds.length} failed).`,
        logicalKeys: [...successfulKeys],
        failedKeys,
        structuredResult: { count: successfulIds.length, targetIds: intendedIds, successfulIds, failedIds },
      });
    }
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
      const settingKey = getCanonicalSettingKey(key, boolVal);
      if (executedMutations.has(settingKey)) {
        text = text.replace(fullMatch, "");
        setSettingRe.lastIndex = 0;
        continue;
      }
      try {
        await alphaStore.setSettings({ [key]: boolVal } as any);
        const ok = (alphaStore.get().settings as any)[key] === boolVal;
        if (!ok) {
          activity.set("action_failed");
          results.push({ tag, status: "failed", message: `Could not change ${key}.` });
        } else {
          executedMutations.add(settingKey);
          results.push({ tag, status: "success", message: `${key} ${boolVal ? "enabled" : "disabled"}.`, logicalKeys: [settingKey] });
        }
      } catch (err: unknown) {
        activity.set("action_failed");
        results.push({ tag, status: "failed", message: `Could not change ${key}: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else if (key === "kokoroVoice") {
      const settingKey = getCanonicalSettingKey("kokoroVoice", raw);
      if (executedMutations.has(settingKey)) {
        text = text.replace(fullMatch, "");
        setSettingRe.lastIndex = 0;
        continue;
      }
      try {
        await alphaStore.setSettings({ kokoroVoice: raw });
        const ok = alphaStore.get().settings.kokoroVoice === raw;
        if (!ok) {
          activity.set("action_failed");
          results.push({ tag, status: "failed", message: `Could not change ${key}.` });
        } else {
          executedMutations.add(settingKey);
          results.push({ tag, status: "success", message: `Kokoro voice set to ${raw}.`, logicalKeys: [settingKey] });
        }
      } catch (err: unknown) {
        activity.set("action_failed");
        results.push({ tag, status: "failed", message: `Could not change ${key}: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else if (key === "ttsRate") {
      const rate = Math.max(0.7, Math.min(1.4, Number(raw) || cur.ttsRate));
      const settingKey = getCanonicalSettingKey("ttsRate", rate);
      if (executedMutations.has(settingKey)) {
        text = text.replace(fullMatch, "");
        setSettingRe.lastIndex = 0;
        continue;
      }
      try {
        await alphaStore.setSettings({ ttsRate: rate });
        const ok = alphaStore.get().settings.ttsRate === rate;
        if (!ok) {
          activity.set("action_failed");
          results.push({ tag, status: "failed", message: `Could not change ${key}.` });
        } else {
          executedMutations.add(settingKey);
          results.push({ tag, status: "success", message: `Speech rate set to ${rate.toFixed(2)}x.`, logicalKeys: [settingKey] });
        }
      } catch (err: unknown) {
        activity.set("action_failed");
        results.push({ tag, status: "failed", message: `Could not change ${key}: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else if (key === "fastModel" || key === "thinkingModel" || key === "codingModel") {
      const lane = key.replace("Model", "") as "fast" | "thinking" | "coding";
      const settingKey = getCanonicalSettingKey(`taskModel:${lane}`, raw);
      if (executedMutations.has(settingKey)) {
        text = text.replace(fullMatch, "");
        setSettingRe.lastIndex = 0;
        continue;
      }
      try {
        await alphaStore.setSettings({ taskModels: { ...cur.taskModels, [lane]: raw } });
        const ok = alphaStore.get().settings.taskModels[lane] === raw;
        if (!ok) {
          activity.set("action_failed");
          results.push({ tag, status: "failed", message: `Could not change ${key}.` });
        } else {
          executedMutations.add(settingKey);
          results.push({ tag, status: "success", message: `${lane} model set to ${raw}.`, logicalKeys: [settingKey] });
        }
      } catch (err: unknown) {
        activity.set("action_failed");
        results.push({ tag, status: "failed", message: `Could not change ${key}: ${err instanceof Error ? err.message : String(err)}` });
      }
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
    const profileKey = getCanonicalProfileKey("name_bio", `${name}:${bio}`);
    if (executedMutations.has(profileKey)) {
      text = text.replace(fullMatch, "");
      setProfileRe.lastIndex = 0;
      continue;
    }
    try {
      await alphaStore.setProfile({ name, bio });
      const after = alphaStore.get().profile;
      const ok = after.name === name && after.bio === bio;
      if (!ok) {
        activity.set("action_failed");
        results.push({ tag: "SET_PROFILE", status: "failed", message: "Could not update your profile." });
      } else {
        executedMutations.add(profileKey);
        results.push({ tag: "SET_PROFILE", status: "success", message: `Profile updated${name ? ` for ${name}` : ""}.`, logicalKeys: [profileKey] });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({ tag: "SET_PROFILE", status: "failed", message: `Could not update profile: ${err instanceof Error ? err.message : String(err)}` });
    }
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

    if (isAmbiguousTime(rawWhen)) {
      const matchHour = rawWhen.match(/(\d{1,2})/);
      const hour = matchHour ? Number(matchHour[1]) : 9;
      await reminderContextManager.setPendingClarification(effectiveUserId, {
        title,
        rawWhen,
        notes,
        hour,
      });
      activity.set("action_failed");
      results.push({
        tag: "ADD_REMINDER",
        status: "failed",
        message: `Do you mean ${hour} AM or ${hour} PM?`,
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
    try {
      const reminderTool = getReminderTool(effectiveUserId);
      const createResult = await reminderTool.createReminder({
        title,
        dueAt,
        notes,
      });
      if (createResult.success && createResult.data) {
        const reminder = createResult.data;
        const keyWithParsedDue = getCanonicalReminderCreateKey({ title: reminder.title, dueAt: reminder.dueAt, notes: reminder.notes });
        const keyWithRawDue = getCanonicalReminderCreateKey({ title: reminder.title, dueAt: rawWhen, notes: reminder.notes });
        executedMutations.add(keyWithParsedDue);
        executedMutations.add(keyWithRawDue);
        results.push({
          tag: "ADD_REMINDER",
          status: "success",
          message: `Reminder saved: "${reminder.title}" — ${formatWhen(reminder.dueAt)}`,
          logicalKeys: [keyWithParsedDue, keyWithRawDue],
        });
      } else {
        activity.set("action_failed");
        results.push({
          tag: "ADD_REMINDER",
          status: "failed",
          message: `Reminder "${title}" could not be saved: ${createResult.error?.message || 'Unknown error'}`,
        });
      }
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

    try {
      await repo.updateReminder(effectiveUserId, target.id, patch);
      executedMutations.add(canonicalUpdateKey);
      if (canonicalUpdateKeyRaw) executedMutations.add(canonicalUpdateKeyRaw);
      const what = keys
        .map((k) => `${k} → ${k === "when" && patch.dueAt ? formatWhen(new Date(patch.dueAt).toISOString()) : fields[k]}`)
        .join(", ");
      results.push({
        tag: "UPDATE_REMINDER",
        status: "success",
        message: `Updated reminder "${target.title}": ${what}`,
        logicalKeys: [canonicalUpdateKey, ...(canonicalUpdateKeyRaw ? [canonicalUpdateKeyRaw] : [])],
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
    const sortedIds = Array.from(new Set(targetIds)).sort();
    const setKey = getCanonicalReminderDeleteKey({ targetIds: sortedIds });
    const singleKeys = targetIds.map((id) => getCanonicalReminderDeleteKey({ targetIds: [id] }));

    const successfulIds: string[] = [];
    const successfulKeys: string[] = [];
    const failedIds: string[] = [];
    const reminderTool = getReminderTool(effectiveUserId);

    for (const id of targetIds) {
      const singleKey = getCanonicalReminderDeleteKey({ targetIds: [id] });
      if (executedMutations.has(singleKey)) {
        successfulIds.push(id);
        successfulKeys.push(singleKey);
        continue;
      }
      try {
        const delRes = await reminderTool.deleteReminder(id);
        if (delRes.success) {
          successfulIds.push(id);
          successfulKeys.push(singleKey);
          executedMutations.add(singleKey);
        } else {
          failedIds.push(id);
        }
      } catch (err) {
        failedIds.push(id);
      }
    }

    if (successfulIds.length === 0) {
      activity.set("action_failed");
      const failedKeys = intendedIds.map((id) => getCanonicalReminderDeleteKey({ targetIds: [id] }));
      results.push({
        tag: "DELETE_REMINDER",
        status: "failed",
        message: `Could not delete reminders.`,
        failedKeys,
        structuredResult: { count: 0, targetIds: intendedIds, successfulIds: [], failedIds: intendedIds },
      });
    } else if (successfulIds.length === targetIds.length) {
      if (hits.length > 1) {
        executedMutations.add(setKey);
      }
      results.push({
        tag: "DELETE_REMINDER",
        status: "success",
        message: `Deleted ${hits.length} ${hits.length === 1 ? "reminder" : "reminders"}: ${hits.map((h) => `"${h.title}"`).join(", ")}.`,
        logicalKeys: hits.length > 1 ? [setKey, ...singleKeys] : [...singleKeys],
        structuredResult: { count: successfulIds.length, targetIds, successfulIds },
      });
    } else {
      activity.set("action_failed");
      const failedKeys = failedIds.map((id) => getCanonicalReminderDeleteKey({ targetIds: [id] }));
      results.push({
        tag: "DELETE_REMINDER",
        status: "partial",
        message: `Deleted ${successfulIds.length} out of ${targetIds.length} reminders (${failedIds.length} failed).`,
        logicalKeys: [...successfulKeys],
        failedKeys,
        structuredResult: { count: successfulIds.length, targetIds, successfulIds, failedIds },
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

    try {
      const reminderTool = getReminderTool(effectiveUserId);
      const completeRes = await reminderTool.completeReminder(target.id);
      if (completeRes.success) {
        executedMutations.add(compKey);
        executedMutations.add(updKey);
        results.push({
          tag: "MARK_REMINDER_DONE",
          status: "success",
          message: `Marked reminder "${target.title}" as done ✅`,
          logicalKeys: [compKey, updKey],
          structuredResult: completeRes.data || target,
        });
      } else {
        activity.set("action_failed");
        results.push({
          tag: "MARK_REMINDER_DONE",
          status: "failed",
          message: `Could not mark reminder "${target.title}" as done: ${completeRes.error?.message || "unknown error"}`,
          logicalKeys: [compKey, updKey],
          failedKeys: [compKey, updKey],
          structuredResult: target,
        });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "MARK_REMINDER_DONE",
        status: "failed",
        message: `Could not mark reminder "${target.title}" as done: ${err instanceof Error ? err.message : String(err)}`,
        logicalKeys: [compKey, updKey],
        failedKeys: [compKey, updKey],
        structuredResult: target,
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
    const sorted = [...list].sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
    const victim = sorted[0];
    const victimKey = getCanonicalReminderDeleteKey({ targetIds: [victim.id] });
    if (executedMutations.has(victimKey)) {
      text = text.replace(fullMatch, "");
      delLastRemRe.lastIndex = 0;
      continue;
    }

    try {
      const reminderTool = getReminderTool(effectiveUserId);
      const delRes = await reminderTool.deleteReminder(victim.id);
      if (delRes.success) {
        executedMutations.add(victimKey);
        results.push({
          tag: "DELETE_LAST",
          status: "success",
          message: `Deleted reminder "${victim.title}".`,
          logicalKeys: [victimKey],
          structuredResult: delRes.data || victim,
        });
      } else {
        activity.set("action_failed");
        results.push({
          tag: "DELETE_LAST",
          status: "failed",
          message: `Could not delete reminder: ${delRes.error?.message || "unknown error"}`,
          logicalKeys: [victimKey],
          failedKeys: [victimKey],
          structuredResult: victim,
        });
      }
    } catch (err: unknown) {
      activity.set("action_failed");
      results.push({
        tag: "DELETE_LAST",
        status: "failed",
        message: `Could not delete reminder: ${err instanceof Error ? err.message : String(err)}`,
        logicalKeys: [victimKey],
        failedKeys: [victimKey],
        structuredResult: victim,
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

    const targetIds = list.map(r => r.id);
    const sortedIds = Array.from(new Set(targetIds)).sort();
    const bulkKey = getCanonicalReminderDeleteKey({ targetIds: sortedIds });
    const clearKey = getCanonicalClearAllKey("reminders");

    const intendedIds = sortedIds;
    const successfulIds: string[] = [];
    const successfulKeys: string[] = [];
    const failedIds: string[] = [];
    const reminderTool = getReminderTool(effectiveUserId);

    for (const id of intendedIds) {
      const singleKey = getCanonicalReminderDeleteKey({ targetIds: [id] });
      if (executedMutations.has(singleKey)) {
        successfulIds.push(id);
        successfulKeys.push(singleKey);
        continue;
      }
      try {
        const delRes = await reminderTool.deleteReminder(id);
        if (delRes.success) {
          successfulIds.push(id);
          successfulKeys.push(singleKey);
          executedMutations.add(singleKey);
        } else {
          failedIds.push(id);
        }
      } catch (err) {
        failedIds.push(id);
      }
    }

    if (successfulIds.length === 0) {
      activity.set("action_failed");
      const failedKeys = intendedIds.map((id) => getCanonicalReminderDeleteKey({ targetIds: [id] }));
      results.push({
        tag: "CLEAR_ALL",
        status: "failed",
        message: "Could not clear reminders.",
        failedKeys,
        structuredResult: { count: 0, targetIds: intendedIds, successfulIds: [], failedIds: intendedIds },
      });
    } else if (successfulIds.length === intendedIds.length) {
      executedMutations.add(bulkKey);
      executedMutations.add(clearKey);
      results.push({
        tag: "CLEAR_ALL",
        status: "success",
        message: `Cleared all ${list.length} reminders.`,
        logicalKeys: [bulkKey, clearKey, ...successfulKeys],
        structuredResult: { count: successfulIds.length, targetIds: intendedIds, successfulIds },
      });
    } else {
      activity.set("action_failed");
      const failedKeys = failedIds.map((id) => getCanonicalReminderDeleteKey({ targetIds: [id] }));
      results.push({
        tag: "CLEAR_ALL",
        status: "partial",
        message: `Cleared ${successfulIds.length} out of ${intendedIds.length} reminders (${failedIds.length} failed).`,
        logicalKeys: [...successfulKeys],
        failedKeys,
        structuredResult: { count: successfulIds.length, targetIds: intendedIds, successfulIds, failedIds },
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
      const isPartial =
        res.status === "partial" ||
        Boolean(res.structuredResult?.failedIds?.length && res.structuredResult?.successfulIds?.length);

      if (isPartial) {
        // Record successful individual logical keys as successes
        if (res.logicalKeys && res.logicalKeys.length > 0) {
          for (const sk of res.logicalKeys) {
            options.lifecycle.recordSuccess({
              name: res.tag,
              isMutation: true,
              result: res.structuredResult !== undefined ? res.structuredResult : { key: sk },
              logicalKeys: [sk],
            });
          }
        }
        // Record each failed target as an individual lifecycle failure using that target's canonical delete key
        if (res.failedKeys && res.failedKeys.length > 0) {
          for (const fk of res.failedKeys) {
            options.lifecycle.recordFailure({
              name: res.tag,
              isMutation: true,
              error: { message: `Failed mutation for ${fk}`, failedKey: fk, structuredResult: res.structuredResult },
              logicalKeys: [fk],
            });
          }
        } else if (res.structuredResult?.failedIds?.length) {
          for (const fid of res.structuredResult.failedIds) {
            options.lifecycle.recordFailure({
              name: res.tag,
              isMutation: true,
              error: { message: `Failed mutation for target id: ${fid}`, targetId: fid, structuredResult: res.structuredResult },
            });
          }
        }
      } else if (res.status === "success") {
        options.lifecycle.recordSuccess({
          name: res.tag,
          isMutation: true,
          result: res.structuredResult !== undefined ? res.structuredResult : res.message,
          logicalKeys: res.logicalKeys,
        });
      } else if (res.status === "failed") {
        if (res.failedKeys && res.failedKeys.length > 0) {
          for (const fk of res.failedKeys) {
            options.lifecycle.recordFailure({
              name: res.tag,
              isMutation: true,
              error: { message: res.message, failedKey: fk, structuredResult: res.structuredResult },
              logicalKeys: [fk],
            });
          }
        } else {
          options.lifecycle.recordFailure({
            name: res.tag,
            isMutation: true,
            error: res.message,
            logicalKeys: res.logicalKeys,
          });
        }
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
  partial: "⚠️",
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
