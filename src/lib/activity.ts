/**
 * Centralised activity-status bus.
 *
 * The APPLICATION sets these — never the model's prose. Chat, voice-first mode,
 * the desktop HUD and the mini orb all read the same value, so what the user
 * sees always corresponds to the operation actually running.
 */

import { useEffect, useState } from "react";

export type ActivityKind =
  | "idle"
  | "listening"
  | "thinking"
  | "preparing"
  | "searching"
  | "reading_image"
  | "reading_article"
  | "search_deciding"
  | "processing_attachment"
  | "reading_memory"
  | "reading_note"
  | "reading_reminder"
  | "checking_settings"
  | "writing_note"
  | "writing_reminder"
  | "writing_bill"
  | "writing_memory"
  | "updating_plan"
  | "editing_settings"
  | "writing_code"
  | "calculating"
  | "calling_tool"
  | "executing_action"
  | "waiting_confirmation"
  | "waiting_provider"
  | "switching_model"
  | "retrying"
  | "preparing_voice"
  | "speaking"
  | "stopping_speech"
  | "action_failed"
  | "error";

const LABELS: Record<ActivityKind, string> = {
  idle: "",
  listening: "Listening…",
  thinking: "Thinking…",
  preparing: "Preparing response…",
  searching: "Searching the web…",
  reading_image: "Reading image…",
  reading_article: "Reading article…",
  search_deciding: "Deciding to search…",
  processing_attachment: "Processing attachment…",
  reading_memory: "Reading memory…",
  reading_note: "Reading note…",
  reading_reminder: "Checking reminder…",
  checking_settings: "Checking settings…",
  writing_note: "Writing note…",
  writing_reminder: "Writing reminder…",
  writing_bill: "Writing bill…",
  writing_memory: "Writing memory…",
  updating_plan: "Updating plan…",
  editing_settings: "Editing settings…",
  writing_code: "Writing code…",
  calculating: "Running calculation…",
  calling_tool: "Calling tool…",
  executing_action: "Executing action…",
  waiting_confirmation: "Waiting for confirmation…",
  waiting_provider: "Waiting for provider…",
  switching_model: "Switching model…",
  retrying: "Retrying…",
  preparing_voice: "Preparing voice…",
  speaking: "Speaking…",
  stopping_speech: "Stopping speech…",
  action_failed: "Action failed",
  error: "Error",
};

export const DEFAULT_ERROR_AUTOCLEAR_MS = 2500;

export interface Activity {
  kind: ActivityKind;
  /** Optional override text — still user-facing wording, never API details. */
  detail?: string;
  /** Generation token associated with this activity state */
  generation?: number;
}

export interface ActivitySession {
  readonly generation: number;
  set: (kind: ActivityKind, detail?: string) => boolean;
  error: (detail?: string, autoClearMs?: number) => boolean;
  clear: () => boolean;
  isCurrent: () => boolean;
}

let currentGeneration = 0;
let current: Activity = { kind: "idle", generation: 0 };
const listeners = new Set<(a: Activity) => void>();
let autoRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

function clearAutoRecoveryTimer(): void {
  if (autoRecoveryTimer !== null) {
    clearTimeout(autoRecoveryTimer);
    autoRecoveryTimer = null;
  }
}

function scheduleErrorRecovery(targetGen: number, autoClearMs = DEFAULT_ERROR_AUTOCLEAR_MS): void {
  clearAutoRecoveryTimer();
  autoRecoveryTimer = setTimeout(() => {
    autoRecoveryTimer = null;
    if (
      currentGeneration === targetGen &&
      (current.kind === "error" || current.kind === "action_failed")
    ) {
      current = { kind: "idle", generation: currentGeneration };
      listeners.forEach((l) => l(current));
    }
  }, autoClearMs);
}

export const activity = {
  get: (): Activity => current,
  getGeneration: (): number => currentGeneration,

  /** Human label for the current (or a given) activity. */
  label(a: Activity = current): string {
    return a.detail || LABELS[a.kind] || "";
  },

  /**
   * Start a new operation session. Increments the generation counter and
   * transitions activity out of idle/error. Returns a session handle tied
   * to this generation.
   */
  start(kind: ActivityKind = "thinking", detail?: string): ActivitySession {
    clearAutoRecoveryTimer();
    currentGeneration += 1;
    const sessionGen = currentGeneration;
    current = { kind, detail, generation: sessionGen };
    listeners.forEach((l) => l(current));

    return {
      generation: sessionGen,
      set: (k: ActivityKind, d?: string) => activity.set(k, d, sessionGen),
      error: (d?: string, ms?: number) => {
        if (sessionGen !== currentGeneration) return false;
        return activity.set("error", d, sessionGen, ms);
      },
      clear: () => activity.clear(sessionGen),
      isCurrent: () => sessionGen === currentGeneration,
    };
  },

  /**
   * Update the activity status.
   * If a token/generation is provided, updates from stale generations are rejected.
   */
  set(
    kind: ActivityKind,
    detail?: string,
    token?: number,
    autoClearMs = DEFAULT_ERROR_AUTOCLEAR_MS,
  ): boolean {
    if (token !== undefined && token !== currentGeneration) {
      // Stale update rejected
      return false;
    }

    if (current.kind === kind && current.detail === detail) {
      return true;
    }

    clearAutoRecoveryTimer();

    // If no token was provided and this transitions from idle/error to an active state,
    // advance generation to establish a new active window.
    if (
      token === undefined &&
      (current.kind === "idle" || current.kind === "error" || current.kind === "action_failed") &&
      kind !== "idle" &&
      kind !== "error" &&
      kind !== "action_failed"
    ) {
      currentGeneration += 1;
    }

    current = { kind, detail, generation: currentGeneration };
    listeners.forEach((l) => l(current));

    if (kind === "error" || kind === "action_failed") {
      scheduleErrorRecovery(currentGeneration, autoClearMs);
    }

    return true;
  },

  /**
   * Clears activity to idle.
   * If a token/generation is passed, stale clears are rejected.
   */
  clear(token?: number): boolean {
    if (token !== undefined && token !== currentGeneration) {
      return false;
    }
    clearAutoRecoveryTimer();
    if (current.kind === "idle" && !current.detail) {
      return true;
    }
    current = { kind: "idle", generation: currentGeneration };
    listeners.forEach((l) => l(current));
    return true;
  },

  /**
   * Hard reset of activity state and timer, advancing generation.
   */
  reset(): void {
    clearAutoRecoveryTimer();
    currentGeneration += 1;
    current = { kind: "idle", generation: currentGeneration };
    listeners.forEach((l) => l(current));
  },

  sub(l: (a: Activity) => void): () => void {
    listeners.add(l);
    l(current);
    return () => {
      listeners.delete(l);
    };
  },

  isBusy(): boolean {
    return current.kind !== "idle" && current.kind !== "listening";
  },
};

/** Map an action tag name to the status shown while it executes. */
export function actionActivity(tag: string): ActivityKind {
  const t = tag.toUpperCase();
  if (t.includes("NOTE"))
    return t.startsWith("ADD") || t.startsWith("UPDATE") ? "writing_note" : "executing_action";
  if (t.includes("REMINDER")) return "writing_reminder";
  if (t.includes("BILL")) return "writing_bill";
  if (t.includes("MEMORY")) return "writing_memory";
  if (t.includes("PLAN")) return "updating_plan";
  if (t.includes("SETTING") || t.includes("PROFILE")) return "editing_settings";
  return "executing_action";
}

export function useActivity(): Activity {
  const [act, setAct] = useState<Activity>(activity.get());
  useEffect(() => activity.sub(setAct), []);
  return act;
}
