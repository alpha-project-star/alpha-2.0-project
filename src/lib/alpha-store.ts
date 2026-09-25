import { useSyncExternalStore } from "react";
import { z } from "zod";
import { reminderContextManager } from "./reminder-context";
import { MODEL_TRIO, isSupportedModel, parseRouteSpec } from "./models";
import { withCrossContextLock } from "./cross-context-lock";

import {
  Goal, GoalSchema,
  Task, TaskSchema,
  Run, RunSchema,
  Step, StepSchema,
  Observation, ObservationSchema,
  Result, ResultSchema,
} from "./execution";

export type ChatRole = "user" | "model" | "system" | "tool";
export type MessageOrigin = "user" | "model" | "system" | "proactive";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  origin?: MessageOrigin;
  proactiveEventId?: string;
  text: string;
  images?: string[];
  ts: number;
  error?: boolean;
  /** OpenAI tool call ID for 'tool' role or 'model' role responding with tools. */
  tool_call_id?: string;
  /** Tools requested by the model in this turn. */
  tool_calls?: any[];
  intermediate?: boolean;
}

export type { Task, Goal, Run, Step, Observation, Result } from "./execution";

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}
export interface Bill {
  id: string;
  name: string;
  amount?: number;
  dueDate: string;
  balance: number | string;
  status: "due" | "paid" | "overdue" | "unpaid";
  category?: string;
}
export type MemoryProvenance =
  | "explicit_user"
  | "imported_user_data"
  | "system_verified"
  | "model_inferred"
  | "derived_from_history"
  | "tool_observation";

export type MemoryConfidence = "high" | "medium" | "low";

export type MemoryLifecycle =
  | "candidate"
  | "validated"
  | "active"
  | "stale"
  | "conflicted"
  | "archived";

export interface Memory {
  id: string;
  topic: string;
  detail: string;
  category?: string;
  provenance?: MemoryProvenance;
  confidence?: MemoryConfidence;
  status?: MemoryLifecycle;
  createdAt?: number;
  updatedAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
}
export interface Profile {
  name: string;
  bio: string;
}

export interface Settings {
  voiceEnabled: boolean;
  continuousListen: boolean;
  /** Speak completed replies automatically. Manual Speak always works. */
  autoSpeak: boolean;
  /** Send the final voice transcript automatically instead of waiting for Send. */
  autoSubmitVoice: boolean;
  preferredVoice: string;
  personaExtra: string;
  kokoroEndpoint: string;
  kokoroVoice: string;
  ttsRate: number;
  // ---- Local / offline backends ----
  ollamaEndpoint: string; // e.g. http://localhost:11434
  ollamaModel: string; // active local model tag
  ollamaModels: string[]; // custom list the user typed in Settings
  sttBackend: "browser" | "whisper" | "auto"; // "auto" → whisper when offline
  whisperEndpoint: string; // e.g. http://localhost:8001  (OpenAI-compat)
  whisperModel: string; // model name for the whisper server
  // ---- Multi-provider model routing ----
  groqApiKey: string;
  openaiCompatKey: string;
  openaiCompatBase: string; // e.g. https://api.openai.com/v1
  openRouterKey: string; // OpenRouter API key
  // Free-form "watchlist" — comma or newline separated topics Alpha
  // proactively surfaces via the alert bus when a hit lands.
  backgroundData: string;
  // Toggle for background scanners (lights out on scanner when false).
  backgroundEnabled: boolean;
  // Persistent build/spec record — Alpha reads this so he knows himself.
  buildRecord: string;
  // ---- Vision (Cyber-Eye camera) ----
  visionAmbientEnabled: boolean;
  visionAmbientIntervalSec: number;
  // Task -> "provider:model" e.g. "groq:llama-3.1-8b-instant" | "gemini:gemini-2.5-pro" | "openai:gpt-4o-mini"
  taskModels: { fast: string; thinking: string; coding: string };
}

export interface AlphaState {
  chat: ChatMessage[];
  internalHistory?: ChatMessage[];
  notes: Note[];
  bills: Bill[];
  tasks: Task[];
  goals: Goal[];
  runs: Run[];
  steps: Step[];
  observations: Observation[];
  results: Result[];
  memories: Memory[];
  profile: Profile;
  settings: Settings;
}

export const K = {
  chat: "alpha.chat.v1",
  internalHistory: "alpha.internalHistory.v1",
  notes: "alpha.notes.v1",
  bills: "alpha.bills.v1",
  goals: "alpha.goals.v1",
  tasks: "alpha.tasks.v1",
  runs: "alpha.runs.v1",
  steps: "alpha.steps.v1",
  observations: "alpha.observations.v1",
  results: "alpha.results.v1",
  memories: "alpha.memories.v1",
  profile: "alpha.profile.v1",
  settings: "alpha.settings.v1",
  summary: "alpha.summary.v1",
};

const DEFAULT_SETTINGS: Settings = {
  voiceEnabled: true,
  continuousListen: true,
  autoSpeak: true,
  autoSubmitVoice: true,
  preferredVoice: "",
  personaExtra: "",
  kokoroEndpoint: "",
  kokoroVoice: "am_michael",
  ttsRate: 1.0,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3.2:3b",
  ollamaModels: [],
  sttBackend: "auto",
  whisperEndpoint: "http://localhost:8001",
  whisperModel: "Systran/faster-whisper-small",
  groqApiKey: "",
  openaiCompatKey: "",
  openaiCompatBase: "https://api.openai.com/v1",
  openRouterKey: "",
  backgroundData: "",
  backgroundEnabled: true,
  buildRecord: "",
  visionAmbientEnabled: false,
  visionAmbientIntervalSec: 30,
  taskModels: {
    fast: MODEL_TRIO.fast,
    thinking: MODEL_TRIO.capable,
    coding: MODEL_TRIO.coding,
  },
};

export const SettingsSchema = z.object({
  voiceEnabled: z.boolean().default(DEFAULT_SETTINGS.voiceEnabled),
  continuousListen: z.boolean().default(DEFAULT_SETTINGS.continuousListen),
  autoSpeak: z.boolean().default(DEFAULT_SETTINGS.autoSpeak),
  autoSubmitVoice: z.boolean().default(DEFAULT_SETTINGS.autoSubmitVoice),
  preferredVoice: z.string().default(DEFAULT_SETTINGS.preferredVoice),
  personaExtra: z.string().default(DEFAULT_SETTINGS.personaExtra),
  kokoroEndpoint: z.string().default(DEFAULT_SETTINGS.kokoroEndpoint),
  kokoroVoice: z.string().default(DEFAULT_SETTINGS.kokoroVoice),
  ttsRate: z.number().min(0.5).max(3.0).default(DEFAULT_SETTINGS.ttsRate),
  ollamaEndpoint: z.string().default(DEFAULT_SETTINGS.ollamaEndpoint),
  ollamaModel: z.string().default(DEFAULT_SETTINGS.ollamaModel),
  ollamaModels: z.array(z.string()).default(DEFAULT_SETTINGS.ollamaModels),
  sttBackend: z.enum(["browser", "whisper", "auto"]).default(DEFAULT_SETTINGS.sttBackend),
  whisperEndpoint: z.string().default(DEFAULT_SETTINGS.whisperEndpoint),
  whisperModel: z.string().default(DEFAULT_SETTINGS.whisperModel),
  groqApiKey: z.string().default(DEFAULT_SETTINGS.groqApiKey),
  openaiCompatKey: z.string().default(DEFAULT_SETTINGS.openaiCompatKey),
  openaiCompatBase: z.string().default(DEFAULT_SETTINGS.openaiCompatBase),
  openRouterKey: z.string().default(DEFAULT_SETTINGS.openRouterKey),
  backgroundData: z.string().default(DEFAULT_SETTINGS.backgroundData),
  backgroundEnabled: z.boolean().default(DEFAULT_SETTINGS.backgroundEnabled),
  buildRecord: z.string().default(DEFAULT_SETTINGS.buildRecord),
  visionAmbientEnabled: z.boolean().default(DEFAULT_SETTINGS.visionAmbientEnabled),
  visionAmbientIntervalSec: z.number().min(5).default(DEFAULT_SETTINGS.visionAmbientIntervalSec),
  taskModels: z.object({
    fast: z.string().refine((s) => {
      const parsed = parseRouteSpec(s);
      return parsed !== null && isSupportedModel(parsed.prov, parsed.model);
    }, { message: "Unsupported model route for fast lane" }).default(DEFAULT_SETTINGS.taskModels.fast),
    thinking: z.string().refine((s) => {
      const parsed = parseRouteSpec(s);
      return parsed !== null && isSupportedModel(parsed.prov, parsed.model);
    }, { message: "Unsupported model route for thinking lane" }).default(DEFAULT_SETTINGS.taskModels.thinking),
    coding: z.string().refine((s) => {
      const parsed = parseRouteSpec(s);
      return parsed !== null && isSupportedModel(parsed.prov, parsed.model);
    }, { message: "Unsupported model route for coding lane" }).default(DEFAULT_SETTINGS.taskModels.coding),
  }).default(DEFAULT_SETTINGS.taskModels),
}) as z.ZodType<Settings>;

export const ProfileSchema = z.object({
  name: z.string().default(""),
  bio: z.string().default(""),
}) as z.ZodType<Profile>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "model", "system", "tool"]),
  origin: z.enum(["user", "model", "system", "proactive"]).optional(),
  proactiveEventId: z.string().optional(),
  text: z.string().optional().default(""),
  name: z.string().optional(),
  images: z.array(z.string()).optional(),
  ts: z.number(),
  error: z.boolean().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  intermediate: z.boolean().optional(),
});

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.number(),
});

export const BillSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: z.union([z.number(), z.string().transform(v => parseFloat(v) || 0)]).optional().default(0),
  dueDate: z.string(),
  balance: z.union([z.number(), z.string().transform(v => parseFloat(v) || 0)]).default(0),
  status: z.union([z.enum(["due", "paid", "overdue"]), z.string()]).transform(s => (s === "unpaid" ? "overdue" : s) as "due" | "paid" | "overdue"),
  category: z.string().optional(),
});

export const MemorySchema = z.object({
  id: z.string(),
  topic: z.string(),
  detail: z.string(),
  category: z.string().optional().default("general"),
  provenance: z
    .enum([
      "explicit_user",
      "imported_user_data",
      "system_verified",
      "model_inferred",
      "derived_from_history",
      "tool_observation",
    ])
    .optional()
    .default("explicit_user"),
  confidence: z.enum(["high", "medium", "low"]).optional().default("high"),
  status: z
    .enum(["candidate", "validated", "active", "stale", "conflicted", "archived"])
    .optional()
    .default("active"),
  createdAt: z.number().optional(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  expiresAt: z.number().optional(),
});

export class PersistenceError extends Error {
  constructor(key: string, originalError: any) {
    super(`Storage operation failed for key "${key}": ${originalError?.message || originalError}`);
    this.name = "PersistenceError";
  }
}

import { auth } from "./firebase";

let currentStoreUid: string = "local-user";

export const ALPHA_USER_KEY_PREFIXES: readonly string[] = [
  ...Object.values(K),
  "alpha.reminders.v1",
  "alpha.deliveries.v1",
  "alpha.reminder_context.v1",
  "alpha.proactive.lastBrief",
  "alpha.proactive.lastBillsNudge",
  "alpha.proactive.lastPlansNudge",
  "alpha_ambient_hourly_counter",
  "alpha_ambient_hourly_reset_at",
];

/**
 * Checks if a localStorage key belongs to Alpha's canonical user-scoped storage namespace
 * AND the UID is the exact authenticated UID occupying the canonical UID namespace position.
 */
export function isKeyForUid(key: string, uid: string): boolean {
  if (!key || !uid) return false;

  for (let i = 0; i < ALPHA_USER_KEY_PREFIXES.length; i++) {
    if (key === `${ALPHA_USER_KEY_PREFIXES[i]}.${uid}`) {
      return true;
    }
  }
  return false;
}

export function isAlphaKeyPrefix(key: string): boolean {
  return ALPHA_USER_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

/**
 * Returns the stable canonical key for Alpha's single-user local storage.
 * All Alpha data is now stored under the base key with no UID scoping to ensure
 * data persistence across restarts and auth state changes.
 */
export function getKey(baseKey: string): string {
  if (!isAlphaKeyPrefix(baseKey)) {
    return baseKey;
  }
  // All Alpha data now uses the stable "local-user" identity or the base key directly.
  // We prefer the base key directly for a clean namespace.
  return baseKey;
}

export function getCurrentStoreUser(): string {
  return "local-user";
}

/**
 * Sets the active storage scope. In the single-user Alpha architecture, this is 
 * now a no-op that preserves the stable local identity.
 */
export function setStoreUser(uid: string | null) {
  // Stable identity is maintained regardless of Firebase auth state.
  reloadState();
  emit();
}

/**
 * Migrates legacy UID-scoped storage keys to the canonical base keys.
 * This ensures users don't lose data during the transition to the stable local identity.
 */
function migrateLegacyScopedKeys() {
  const storage = getStorage();
  if (!storage) return;

  const keysToMigrate: { from: string; to: string }[] = [];
  
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;

    for (const prefix of ALPHA_USER_KEY_PREFIXES) {
      if (key.startsWith(`${prefix}.`) && key !== prefix) {
        keysToMigrate.push({ from: key, to: prefix });
        break;
      }
    }
  }

  for (const { from, to } of keysToMigrate) {
    const data = storage.getItem(from);
    if (data) {
      const existing = storage.getItem(to);
      if (!existing || existing === "[]" || existing === "{}" || existing.trim() === "") {
        // Safe to migrate if target is empty
        storage.setItem(to, data);
      } else {
        // If both exist, we may need to merge for certain keys (like reminders)
        if (to === "alpha.reminders.v1") {
          try {
            const fromList = JSON.parse(data);
            const toList = JSON.parse(existing);
            if (Array.isArray(fromList) && Array.isArray(toList)) {
              // Merge reminders, updating userId to 'local-user'
              const merged = [...toList];
              for (const item of fromList) {
                if (!merged.some(r => r.id === item.id)) {
                  merged.push({ ...item, userId: "local-user" });
                }
              }
              storage.setItem(to, JSON.stringify(merged));
            }
          } catch (e) {
            console.error("Failed to merge reminders during migration:", e);
          }
        }
        // For other keys, we prioritize the existing canonical key or just skip
      }
      // Remove the legacy key after migration attempt
      storage.removeItem(from);
    }
  }
}

/**
 * Retrieves the browser-local storage instance.
 * Note: localStorage provides browser-origin/profile-local storage, not server-side
 * durable persistence or transactional storage. Cross-context mutations are serialized
 * via withCrossContextLock with reload-before-write to avoid lost updates across tabs.
 */
export function getStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function parseLS<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  const storage = getStorage();
  if (!storage) return fallback;
  const targetKey = getKey(key);
  let v = storage.getItem(targetKey);
  if ((v === null || v === undefined || typeof v !== "string" || v.trim() === "") && key === K.settings) {
    const unauthKey = `${K.settings}.unauthenticated`;
    v = storage.getItem(unauthKey) || storage.getItem(K.settings);
  }
  if (v === null || v === undefined || typeof v !== "string" || v.trim() === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return fallback;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.log("PARSELS FAIL for", key, result.error);
    if (typeof parsed === "object" && parsed !== null) {
      const merged = { ...(fallback as any), ...parsed };
      const retry = schema.safeParse(merged);
      if (retry.success) return retry.data;
      return merged as T;
    }
    return fallback;
  }
  return result.data;
}

export function writeLS<T>(key: string, v: T): { status: "success" | "unavailable" } {
  const storage = getStorage();
  if (!storage) {
    return { status: "unavailable" };
  }
  const targetKey = getKey(key);
  try {
    let serialized = "";
    if (key === K.chat || targetKey.startsWith(K.chat)) {
      // Clean/strip/replace giant base64 images from ChatMessages to prevent QuotaExceededError
      const cleaned = (v as any).map((m: any) => {
        if (m.images && m.images.length > 0) {
          return {
            ...m,
            images: m.images.map((img: string) => img.startsWith("data:") && img.length > 200 ? "[image_transient]" : img)
          };
        }
        return m;
      });
      serialized = JSON.stringify(cleaned);
    } else {
      serialized = JSON.stringify(v);
    }
    storage.setItem(targetKey, serialized);
    return { status: "success" };
  } catch (err) {
    throw new PersistenceError(targetKey, err);
  }
}

// Initial bootstrap check
if (typeof window !== "undefined") {
  migrateLegacyScopedKeys();
  if (auth.currentUser) {
    currentStoreUid = "local-user";
  }
}

let state: AlphaState = {
  chat: parseLS<ChatMessage[]>(K.chat, z.array(ChatMessageSchema), []),
  internalHistory: parseLS<ChatMessage[]>(K.internalHistory, z.array(ChatMessageSchema), []),
  notes: parseLS<Note[]>(K.notes, z.array(NoteSchema), []),
  bills: parseLS<Bill[]>(K.bills, z.array(BillSchema), []),
  tasks: parseLS<Task[]>(K.tasks, z.array(TaskSchema) as any, []),
  goals: parseLS<Goal[]>(K.goals, z.array(GoalSchema) as any, []),
  runs: parseLS<Run[]>(K.runs, z.array(RunSchema) as any, []),
  steps: parseLS<Step[]>(K.steps, z.array(StepSchema) as any, []),
  observations: parseLS<Observation[]>(K.observations, z.array(ObservationSchema) as any, []),
  results: parseLS<Result[]>(K.results, z.array(ResultSchema) as any, []),
  memories: parseLS<Memory[]>(K.memories, z.array(MemorySchema), []),
  profile: parseLS<Profile>(K.profile, ProfileSchema, { name: "", bio: "" }),
  settings: parseLS<Settings>(K.settings, SettingsSchema, DEFAULT_SETTINGS),
};

// One-shot migration: users still on the old task-model defaults get moved to
// the new free-tier stack (Groq 70B / DeepSeek R1 / Poolside Laguna).
(function migrateTaskModels() {
  const legacy = new Set([
    "groq:llama-3.1-8b-instant",
    "gemini:gemini-2.5-pro",
    "openrouter:poolside/laguna-m.1:free",
    // Slugs OpenRouter has since pulled from the free tier (404 / "paid only"):
    "openrouter:deepseek/deepseek-r1:free",
    "openrouter:deepseek/deepseek-chat-v3.1:free",
    "openrouter:qwen/qwen3-coder:free",
    "openrouter:qwen/qwq-32b:free",
    "openrouter:qwen/qwen2.5-vl-72b-instruct:free",
    "openrouter:mistralai/mistral-small-3.2-24b-instruct:free",
    "openrouter:meta-llama/llama-3.3-70b-instruct:free",
    // Verified dead / answer-less / withdrawn:
    "openrouter:openai/gpt-oss-20b:free",
    "openai/gpt-oss-20b",
    "groq:openai/gpt-oss-20b",
    "openrouter:poolside/laguna-xs-2.1:free",
    "openrouter:poolside/laguna-s-2.1:free",
    "openrouter:nvidia/nemotron-nano-9b-v2:free",
    "openrouter:google/gemini-2.0-flash-exp:free",
    "openrouter:google/gemini-2.5-flash-thinking",
    "openrouter:google/gemini-2.5-flash-thinking:free",
    "gemini:gemini-2.5-flash-thinking",
  ]);
  const t = state.settings.taskModels;
  const migrated = {
    // Any route pointing at a gemini:… model must be moved off — Gemini is gone.
    fast:
      legacy.has(t.fast) || /^gemini:/i.test(t.fast) ? DEFAULT_SETTINGS.taskModels.fast : t.fast,
    thinking:
      legacy.has(t.thinking) || /^gemini:/i.test(t.thinking)
        ? DEFAULT_SETTINGS.taskModels.thinking
        : t.thinking,
    coding:
      legacy.has(t.coding) || /^gemini:/i.test(t.coding)
        ? DEFAULT_SETTINGS.taskModels.coding
        : t.coding,
  };
  let settingsChanged = false;
  if (
    migrated.fast !== t.fast ||
    migrated.thinking !== t.thinking ||
    migrated.coding !== t.coding
  ) {
    state = { ...state, settings: { ...state.settings, taskModels: migrated } };
    settingsChanged = true;
  }
  if (
    state.settings.buildRecord &&
    (/Alpha is a voice-first/i.test(state.settings.buildRecord) ||
     /DeepSeek R1/i.test(state.settings.buildRecord) ||
     /Poolside/i.test(state.settings.buildRecord) ||
     /Groq \(fast Llama\)/i.test(state.settings.buildRecord) ||
     /Chat routes across/i.test(state.settings.buildRecord) ||
     /every online turn is grounded/i.test(state.settings.buildRecord))
  ) {
    state = { ...state, settings: { ...state.settings, buildRecord: "" } };
    settingsChanged = true;
  }
  if (settingsChanged) {
    writeLS(K.settings, state.settings);
  }
})();

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key || !isAlphaKeyPrefix(e.key)) return;
    reloadState();
    emit();
  });
}

const getSnapshot = () => state;
const getServerSnapshot = () => serverSnap;

export function useAlpha<T>(selector: (s: AlphaState) => T): T {
  const fullState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  return selector(fullState);
}

function reloadState() {
  migrateLegacyScopedKeys();
  state = {
    chat: parseLS<ChatMessage[]>(K.chat, z.array(ChatMessageSchema), []),
    internalHistory: parseLS<ChatMessage[]>(K.internalHistory, z.array(ChatMessageSchema), []),
    notes: parseLS<Note[]>(K.notes, z.array(NoteSchema), []),
    bills: parseLS<Bill[]>(K.bills, z.array(BillSchema), []),
    tasks: parseLS<Task[]>(K.tasks, z.array(z.any()), []),
    goals: parseLS<Goal[]>(K.goals, z.array(z.any()), []),
    runs: parseLS<Run[]>(K.runs, z.array(z.any()), []),
    steps: parseLS<Step[]>(K.steps, z.array(z.any()), []),
    observations: parseLS<Observation[]>(K.observations, z.array(z.any()), []),
    results: parseLS<Result[]>(K.results, z.array(z.any()), []),
    memories: parseLS<Memory[]>(K.memories, z.array(MemorySchema), []),
    profile: parseLS<Profile>(K.profile, ProfileSchema, { name: "", bio: "" }),
    settings: parseLS<Settings>(K.settings, SettingsSchema, DEFAULT_SETTINGS),
  };
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i >= 0 ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
}

export const alphaStore = {
  get: () => state,
  /** Subscribe to any persisted state change. Returns an unsubscribe fn. */
  sub: (l: () => void) => subscribe(l),
  setSettings(patch: Partial<Settings>): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = { ...state.settings, ...patch };
      const result = SettingsSchema.safeParse(next);
      let finalSettings: Settings;
      if (!result.success) {
        console.warn("Settings patch safeParse warning, merging safely:", result.error);
        finalSettings = {
          ...DEFAULT_SETTINGS,
          ...state.settings,
          ...patch,
        };
      } else {
        finalSettings = result.data;
      }
      writeLS(K.settings, finalSettings);
      state = { ...state, settings: finalSettings };
      emit();
    });
  },
  getCompleteHistory(): ChatMessage[] {
    reloadState();
    return [...(state.chat || [])];
  },
  getDiagnosticHistory(): ChatMessage[] {
    reloadState();
    const visible = state.chat || [];
    const internal = state.internalHistory || [];
    const combined = [...visible, ...internal];
    const seen = new Set<string>();
    const deduped: ChatMessage[] = [];
    for (const m of combined) {
      if (m.id && seen.has(m.id)) continue;
      if (m.id) seen.add(m.id);
      deduped.push(m);
    }
    return deduped.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  },
  appendChat(msg: ChatMessage): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const isIntermediate = msg.intermediate || msg.role === "tool" || (msg.role === "model" && !msg.text && msg.tool_calls?.length);
      if (isIntermediate) {
        const existingInternal = state.internalHistory || [];
        const nextInternal = [...existingInternal, msg].slice(-400);
        writeLS(K.internalHistory, nextInternal);
        state = { ...state, internalHistory: nextInternal };
      } else {
        const next = [...state.chat, msg].slice(-200);
        writeLS(K.chat, next);
        state = { ...state, chat: next };
      }
      emit();
    });
  },
  setChat(msgs: ChatMessage[]): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const visible: ChatMessage[] = [];
      const internal: ChatMessage[] = [];
      for (const m of msgs) {
        const isIntermediate = m.intermediate || m.role === "tool" || (m.role === "model" && !m.text && m.tool_calls?.length);
        if (isIntermediate) {
          internal.push(m);
        } else {
          visible.push(m);
        }
      }
      const nextChat = visible.slice(-200);
      writeLS(K.chat, nextChat);
      state = { ...state, chat: nextChat };

      if (internal.length > 0) {
        const existingInternal = state.internalHistory || [];
        const nextInternal = [...existingInternal, ...internal].slice(-400);
        writeLS(K.internalHistory, nextInternal);
        state = { ...state, internalHistory: nextInternal };
      }
      emit();
    });
  },
  clearChat(): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      conversationSummary.clear();
      writeLS(K.chat, []);
      writeLS(K.internalHistory, []);
      state = { ...state, chat: [], internalHistory: [] };
      reminderContextManager.clear();
      try {
        import("./alpha.functions").then((m) => m.resetCompactionState()).catch(() => {});
      } catch {}
      emit();
    });
  },
  upsertNote(n: Note): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = upsert(state.notes, n);
      writeLS(K.notes, next);
      state = { ...state, notes: next };
      emit();
    });
  },
  deleteNote(id: string): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = state.notes.filter((x) => x.id !== id);
      writeLS(K.notes, next);
      state = { ...state, notes: next };
      emit();
    });
  },
  upsertBill(b: Bill): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = upsert(state.bills, b);
      writeLS(K.bills, next);
      state = { ...state, bills: next };
      emit();
    });
  },
  deleteBill(id: string): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = state.bills.filter((x) => x.id !== id);
      writeLS(K.bills, next);
      state = { ...state, bills: next };
      emit();
    });
  },
  upsertTask(t: Task): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = upsert(state.tasks, t);
      writeLS(K.tasks, next);
      state = { ...state, tasks: next };
      emit();
    });
  },
  deleteTask(id: string): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = state.tasks.filter((x) => x.id !== id);
      writeLS(K.tasks, next);
      state = { ...state, tasks: next };
      emit();
    });
  },
  upsertGoal(g: Goal): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = upsert(state.goals, g);
      writeLS(K.goals, next);
      state = { ...state, goals: next };
      emit();
    });
  },
  deleteGoal(id: string): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = state.goals.filter((x) => x.id !== id);
      writeLS(K.goals, next);
      state = { ...state, goals: next };
      emit();
    });
  },
  upsertRun(r: Run): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const nextRuns = upsert(state.runs, r);
      const active = nextRuns.filter(x => ["queued", "running", "waiting", "blocked"].includes(x.status));
      let inactive = nextRuns.filter(x => ["completed", "failed", "cancelled"].includes(x.status));
      if (nextRuns.length > 50) {
        inactive = inactive.slice(-(Math.max(0, 50 - active.length)));
      }
      const next = [...inactive, ...active].sort((a,b) => (a.startedAt || 0) - (b.startedAt || 0));
      writeLS(K.runs, next);
      state = { ...state, runs: next };
      emit();
    });
  },
  deleteRun(id: string): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = state.runs.filter((x) => x.id !== id);
      writeLS(K.runs, next);
      state = { ...state, runs: next };
      emit();
    });
  },
  upsertStep(s: Step): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const nextSteps = upsert(state.steps, s);
      const active = nextSteps.filter(x => ["pending", "running"].includes(x.status));
      let inactive = nextSteps.filter(x => ["completed", "failed", "cancelled"].includes(x.status));
      if (nextSteps.length > 200) {
         inactive = inactive.slice(-(Math.max(0, 200 - active.length)));
      }
      const next = [...inactive, ...active].sort((a,b) => a.sequence - b.sequence);
      writeLS(K.steps, next);
      state = { ...state, steps: next };
      emit();
    });
  },
  upsertObservation(o: Observation): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const nextObs = upsert(state.observations, o);
      const activeRunIds = new Set(state.runs.filter(r => ["queued", "running", "waiting", "blocked"].includes(r.status)).map(r => r.id));
      const active = nextObs.filter(x => activeRunIds.has(x.runId));
      let inactive = nextObs.filter(x => !activeRunIds.has(x.runId));
      if (nextObs.length > 200) {
        inactive = inactive.slice(-(Math.max(0, 200 - active.length)));
      }
      const next = [...inactive, ...active].sort((a,b) => a.timestamp - b.timestamp);
      writeLS(K.observations, next);
      state = { ...state, observations: next };
      emit();
    });
  },
  upsertResult(r: Result): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const nextRes = upsert(state.results, r);
      const activeRunIds = new Set(state.runs.filter(r => ["queued", "running", "waiting", "blocked"].includes(r.status)).map(r => r.id));
      const active = nextRes.filter(x => activeRunIds.has(x.runId));
      let inactive = nextRes.filter(x => !activeRunIds.has(x.runId));
      if (nextRes.length > 100) {
        inactive = inactive.slice(-(Math.max(0, 100 - active.length)));
      }
      const next = [...inactive, ...active].sort((a,b) => a.timestamp - b.timestamp);
      writeLS(K.results, next);
      state = { ...state, results: next };
      emit();
    });
  },
  upsertMemory(m: Memory): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const now = Date.now();
      const cleanTopic = (m.topic || "").trim();
      const cleanDetail = (m.detail || "").trim();
      const cleanMem: Memory = {
        ...m,
        topic: cleanTopic,
        detail: cleanDetail,
        category: m.category || "general",
        provenance: m.provenance || "explicit_user",
        confidence: m.confidence || "high",
        status: m.status || "active",
        createdAt: m.createdAt || now,
        updatedAt: m.updatedAt || now,
        lastUsedAt: m.lastUsedAt || now,
      };
      const existingIdx = state.memories.findIndex(
        (x) => x.id === cleanMem.id || (cleanTopic && x.topic.toLowerCase().trim() === cleanTopic.toLowerCase() && x.status !== "archived"),
      );
      let nextMemories: Memory[];
      if (existingIdx >= 0) {
        const existing = state.memories[existingIdx];
        const updated: Memory = {
          ...existing,
          ...cleanMem,
          id: existing.id,
          createdAt: existing.createdAt || cleanMem.createdAt,
          updatedAt: now,
          lastUsedAt: now,
        };
        nextMemories = [...state.memories];
        nextMemories[existingIdx] = updated;
      } else {
        nextMemories = upsert(state.memories, cleanMem);
      }
      writeLS(K.memories, nextMemories);
      state = { ...state, memories: nextMemories };
      emit();
    });
  },
  deleteMemory(id: string): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      const next = state.memories.filter((x) => x.id !== id);
      writeLS(K.memories, next);
      state = { ...state, memories: next };
      emit();
    });
  },
  setProfile(p: Profile): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      writeLS(K.profile, p);
      state = { ...state, profile: p };
      emit();
    });
  },
  /** Replace or reset parts or all of state (useful for test isolation and data imports). */
  replaceAll(patch: Partial<AlphaState>): Promise<void> {
    return withCrossContextLock("alpha_store_lock", () => {
      reloadState();
      if (patch.notes !== undefined) writeLS(K.notes, patch.notes);
      if (patch.bills !== undefined) writeLS(K.bills, patch.bills);
      if (patch.tasks !== undefined) writeLS(K.tasks, patch.tasks);
      if (patch.goals !== undefined) writeLS(K.goals, patch.goals);
      if (patch.runs !== undefined) writeLS(K.runs, patch.runs);
      if (patch.steps !== undefined) writeLS(K.steps, patch.steps);
      if (patch.observations !== undefined) writeLS(K.observations, patch.observations);
      if (patch.results !== undefined) writeLS(K.results, patch.results);
      if (patch.memories !== undefined) writeLS(K.memories, patch.memories);
      if (patch.chat !== undefined) writeLS(K.chat, patch.chat);
      if (patch.settings !== undefined) writeLS(K.settings, patch.settings);
      if (patch.profile !== undefined) writeLS(K.profile, patch.profile);
      state = { ...state, ...patch };
      emit();
    });
  },
  /** Remove one message from persistent chat state. Returns true when it existed. */
  async deleteChatMessage(id: string): Promise<boolean> {
    return await withCrossContextLock("alpha_store_lock", async () => {
      reloadState();
      const exists = state.chat.some((m) => m.id === id);
      if (!exists) return false;
      const next = state.chat.filter((m) => m.id !== id);
      writeLS(K.chat, next);
      state = { ...state, chat: next };
      emit();
      return true;
    });
  },
  /**
   * Drop the assistant/system reply that follows a user turn so it can be
   * regenerated. Returns the user message text, or null when not retryable.
   */
  async prepareRetry(assistantId: string): Promise<{ userText: string } | null> {
    return await withCrossContextLock("alpha_store_lock", async () => {
      reloadState();
      const idx = state.chat.findIndex((m) => m.id === assistantId);
      if (idx < 0) return null;
      const msg = state.chat[idx];
      if (msg.origin === "proactive" || msg.proactiveEventId) {
        return null;
      }
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--)
        if (state.chat[i].role === "user") {
          userIdx = i;
          break;
        }
      if (userIdx < 0) return null;
      const next = state.chat.slice(0, userIdx + 1);
      writeLS(K.chat, next);
      state = { ...state, chat: next };
      emit();
      return { userText: state.chat[userIdx].text || "" };
    });
  },
};

// ----- Rolling conversation summary (semantic compactor) -----
export const conversationSummary = {
  get(): string {
    const storage = getStorage();
    if (!storage) return "";
    try {
      const key = getKey(K.summary);
      return storage.getItem(key) || "";
    } catch {
      return "";
    }
  },
  set(s: string) {
    const storage = getStorage();
    if (!storage) return;
    try {
      const key = getKey(K.summary);
      storage.setItem(key, s.slice(0, 4000));
    } catch (err) {
      throw new PersistenceError(getKey(K.summary), err);
    }
  },
  clear() {
    const storage = getStorage();
    if (!storage) return;
    try {
      const key = getKey(K.summary);
      storage.removeItem(key);
    } catch (err) {
      throw new PersistenceError(getKey(K.summary), err);
    }
  },
};

export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
