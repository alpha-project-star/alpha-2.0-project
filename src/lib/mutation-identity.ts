/**
 * Canonical mutation operation identity model shared across native tools and action tags.
 * Ensures that:
 * 1. Identical logical mutations execute exactly once.
 * 2. Distinct logical mutations execute independently without false collisions.
 * 3. Successful native mutations prevent redundant action tag mutations.
 * 4. Failed native mutations do not block action tags.
 */

export function normalizeMutationString(val: unknown): string {
  return String(val ?? "").trim().toLowerCase();
}

export function getCanonicalReminderCreateKey(params: {
  title: string;
  dueAt: string | number;
  notes?: string;
}): string {
  const normTitle = normalizeMutationString(params.title);
  const normDue =
    typeof params.dueAt === "number"
      ? String(params.dueAt)
      : normalizeMutationString(params.dueAt);
  const normNotes = (params.notes || "").trim();

  return `mutation:reminder:create:${JSON.stringify({
    dueAt: normDue,
    notes: normNotes,
    title: normTitle,
  })}`;
}

export function getCanonicalReminderUpdateKey(params: {
  targetId: string;
  patch: Record<string, any>;
}): string {
  const normId = normalizeMutationString(params.targetId);
  const cleanPatch: Record<string, string> = {};

  const forbidden = new Set([
    "userId",
    "uid",
    "ownerId",
    "user_id",
    "updatedAt",
    "createdAt",
    "id",
    "idOrQuery",
    "query",
  ]);

  for (const [k, v] of Object.entries(params.patch || {})) {
    if (forbidden.has(k)) continue;
    if (v === undefined || v === null) continue;
    cleanPatch[k.toLowerCase()] =
      typeof v === "string" ? normalizeMutationString(v) : String(v);
  }

  const sortedEntries = Object.keys(cleanPatch)
    .sort()
    .map((k) => `${k}=${cleanPatch[k]}`)
    .join(";");

  return `mutation:reminder:update:${normId}:${sortedEntries}`;
}

export function getCanonicalReminderDeleteKey(params: {
  targetIds: string[];
}): string {
  const sortedIds = Array.from(
    new Set(
      params.targetIds
        .map((id) => normalizeMutationString(id))
        .filter(Boolean),
    ),
  ).sort();

  return `mutation:reminder:delete:${sortedIds.join(",")}`;
}

export function getCanonicalReminderCompleteKey(params: {
  targetId: string;
}): string {
  const normId = normalizeMutationString(params.targetId);
  return `mutation:reminder:complete:${normId}`;
}

/**
 * Derives canonical mutation keys for native tool calls.
 * When called after successful execution (with resultData), incorporates resolved IDs and timestamps.
 */
export function extractNativeReminderMutationKeys(
  callName: string,
  args: any,
  resultData?: any,
): string[] {
  const keys: string[] = [];
  const parsedArgs = typeof args === "string" ? safeJsonParse(args) : (args || {});

  if (callName === "createReminder") {
    const title = resultData?.title || parsedArgs?.title || "";
    const notes = resultData?.notes !== undefined ? resultData.notes : (parsedArgs?.notes || "");

    if (resultData?.dueAt !== undefined) {
      keys.push(
        getCanonicalReminderCreateKey({
          title,
          dueAt: resultData.dueAt,
          notes,
        }),
      );
    }
    if (parsedArgs?.dueAt !== undefined && String(parsedArgs.dueAt) !== String(resultData?.dueAt)) {
      keys.push(
        getCanonicalReminderCreateKey({
          title,
          dueAt: parsedArgs.dueAt,
          notes,
        }),
      );
    }
    if (!keys.length && title) {
      keys.push(
        getCanonicalReminderCreateKey({
          title,
          dueAt: parsedArgs?.dueAt || "",
          notes,
        }),
      );
    }
  } else if (callName === "updateReminder") {
    const targetId = resultData?.id || parsedArgs?.id || parsedArgs?.idOrQuery || parsedArgs?.query || "";
    if (targetId) {
      const patch = { ...parsedArgs };
      delete patch.id;
      delete patch.query;
      delete patch.idOrQuery;

      if (resultData?.dueAt !== undefined) {
        keys.push(
          getCanonicalReminderUpdateKey({
            targetId,
            patch: { ...patch, dueAt: resultData.dueAt },
          }),
        );
      }
      if (parsedArgs?.dueAt !== undefined && String(parsedArgs.dueAt) !== String(resultData?.dueAt)) {
        keys.push(
          getCanonicalReminderUpdateKey({
            targetId,
            patch: { ...patch, dueAt: parsedArgs.dueAt },
          }),
        );
      }
      if (!keys.length) {
        keys.push(
          getCanonicalReminderUpdateKey({
            targetId,
            patch,
          }),
        );
      }
    }
  } else if (callName === "deleteReminder") {
    const targetId = resultData?.id || parsedArgs?.id || parsedArgs?.idOrQuery || parsedArgs?.query || "";
    if (targetId) {
      keys.push(getCanonicalReminderDeleteKey({ targetIds: [targetId] }));
    }
  } else if (callName === "completeReminder") {
    const targetId = resultData?.id || parsedArgs?.id || parsedArgs?.idOrQuery || parsedArgs?.query || "";
    if (targetId) {
      keys.push(getCanonicalReminderCompleteKey({ targetId }));
      keys.push(
        getCanonicalReminderUpdateKey({
          targetId,
          patch: { reminderState: "completed" },
        }),
      );
    }
  }

  return keys;
}

function safeJsonParse(val: string): any {
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}

export function getCanonicalNoteCreateKey(title: string, body: string): string {
  return `mutation:note:create:${normalizeMutationString(title)}:${normalizeMutationString(body)}`;
}

export function getCanonicalMemoryCreateKey(topic: string, detail: string): string {
  return `mutation:memory:create:${normalizeMutationString(topic)}:${normalizeMutationString(detail)}`;
}

export function getCanonicalBillCreateKey(name: string, amount: number, dueDate?: string): string {
  return `mutation:bill:create:${normalizeMutationString(name)}:${Number(amount || 0)}:${normalizeMutationString(dueDate || "")}`;
}

export function getCanonicalBillMarkPaidKey(billId: string): string {
  return `mutation:bill:mark_paid:${normalizeMutationString(billId)}`;
}

export function getCanonicalTaskCreateKey(title: string): string {
  return `mutation:task:create:${normalizeMutationString(title)}`;
}

export function getCanonicalClearAllKey(entityType: string): string {
  return `mutation:${normalizeMutationString(entityType)}:clear_all`;
}

export function getCanonicalNoteKey(action: string, id: string, title?: string): string {
  return `mutation:note:${action}:${normalizeMutationString(id)}:${normalizeMutationString(title || "")}`;
}

export function getCanonicalMemoryKey(action: string, id: string, topic?: string): string {
  return `mutation:memory:${action}:${normalizeMutationString(id)}:${normalizeMutationString(topic || "")}`;
}

export function getCanonicalBillKey(action: string, id: string, name?: string): string {
  return `mutation:bill:${action}:${normalizeMutationString(id)}:${normalizeMutationString(name || "")}`;
}

export function getCanonicalTaskKey(action: string, id: string, title?: string): string {
  return `mutation:task:${action}:${normalizeMutationString(id)}:${normalizeMutationString(title || "")}`;
}

export function getCanonicalUpdateKey(entityType: string, targetId: string, patch: Record<string, any>): string {
  const normType = normalizeMutationString(entityType);
  const normId = normalizeMutationString(targetId);
  const cleanPatch: Record<string, string> = {};
  const forbidden = new Set(["id", "updatedat", "createdat", "userid", "uid"]);
  for (const [k, v] of Object.entries(patch || {})) {
    const lk = k.toLowerCase();
    if (forbidden.has(lk)) continue;
    if (v === undefined || v === null) continue;
    cleanPatch[lk] = typeof v === "string" ? normalizeMutationString(v) : String(v);
  }
  const sorted = Object.keys(cleanPatch)
    .sort()
    .map((k) => `${k}=${cleanPatch[k]}`)
    .join(";");
  return `mutation:${normType}:update:${normId}:${sorted}`;
}

export function getCanonicalDeleteKey(entityType: string, targetId: string): string {
  return `mutation:${normalizeMutationString(entityType)}:delete:${normalizeMutationString(targetId)}`;
}

export function getCanonicalBulkDeleteKey(entityType: string, targetIds: string[]): string {
  const sorted = Array.from(
    new Set(
      targetIds
        .map((id) => normalizeMutationString(id))
        .filter(Boolean),
    ),
  ).sort();
  return `mutation:${normalizeMutationString(entityType)}:bulk_delete:${sorted.join(",")}`;
}

export function getCanonicalSettingKey(field: string, value: any): string {
  return `mutation:setting:${normalizeMutationString(field)}:${normalizeMutationString(value)}`;
}

export function getCanonicalProfileKey(field: string, value: any): string {
  return `mutation:profile:${normalizeMutationString(field)}:${normalizeMutationString(value)}`;
}


