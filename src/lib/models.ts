/**
 * Centralised model configuration.
 *
 * Every model id Alpha can use lives here — nothing else in the app should
 * contain a hard-coded model slug. Swapping a model later means editing this
 * file only.
 *
 * Availability, price and rate limits on free tiers change constantly. None of
 * these ids are guaranteed to stay free or reachable; the fallback chains below
 * exist precisely because they rotate.
 *
 * Live-verified against OpenRouter on 2026-09-03 (real completions returned):
 *   minimax/minimax-m3:free                              ~1.9s, 1M ctx, clean output
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free   ~1.2s, 256k ctx, clean output
 *   nvidia/nemotron-3-super-120b-a12b:free               ~3.5s, 262k ctx, clean output
 *   nvidia/nemotron-3-ultra-550b-a55b:free               ~2.9s, 1M ctx, clean output
 *   cohere/north-mini-code:free                          ~1.4s, 256k ctx, code-tuned
 *   dots-studio/dots-3-note-preview:free                 ~2.0s, 512k ctx, accepts images
 *   openrouter/free                                      ~1.9s, 200k ctx, accepts images
 * Rate-limited or withdrawn at verification time (kept out of the defaults):
 *   z-ai/glm-5.2:free, poolside/laguna-s-2.1:free, google/gemma-4-*:free (429),
 *   nvidia/nemotron-nano-12b-v2-vl:free, inclusionai/ling-3.0-flash:free (404).
 */

export type ProviderId = "groq" | "openai" | "openrouter";

/** A route is "provider:model" — the format persisted in settings. */
export type RouteSpec = string;

/** The model trio: one primary, one fast fallback, one capable fallback. */
export const MODEL_TRIO = {
  /** Primary general-purpose lane: broad quality, 1M context, fast enough. */
  primary: "openrouter:minimax/minimax-m3:free" as RouteSpec,
  /** Fast lane: lowest latency verified, for short chat and voice turns. */
  fast: "openrouter:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" as RouteSpec,
  /** Capable lane: demanding reasoning / long technical answers. */
  capable: "openrouter:nvidia/nemotron-3-super-120b-a12b:free" as RouteSpec,
  /** Code-tuned lane. */
  coding: "openrouter:cohere/north-mini-code:free" as RouteSpec,
};

/** Canonical default model reference across the entire application */
export const DEFAULT_MODEL: RouteSpec = MODEL_TRIO.primary;

/** Text fallback chain, walked on 404 / 429 / provider failure. Fastest first. */
export const TEXT_FALLBACKS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "cohere/north-mini-code:free",
];

/** Vision fallback chain (models that actually accepted a base64 image). */
export const VISION_FALLBACKS = [
  "dots-studio/dots-3-note-preview:free",
  "openrouter/free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

/** Last-ditch Groq model when the user has a Groq key and OpenRouter is down. */
export const GROQ_EMERGENCY_MODEL = "llama-3.1-8b-instant";

/** Model used for the background conversation compactor (cheap + short). */
export const COMPACTOR_ROUTE: RouteSpec = MODEL_TRIO.fast;

/** Output-token ceilings per task so one turn cannot blow a TPM budget. */
export const MAX_OUTPUT_TOKENS = {
  fast: 1200,
  auto: 2000,
  thinking: 3000,
  coding: 3000,
  vision: 1200,
} as const;

/** How many prior turns are sent to the model. Smaller = fewer tokens burned. */
export const HISTORY_TURNS = {
  fast: 12,
  auto: 20,
  thinking: 24,
  coding: 24,
  vision: 8,
} as const;

export function parseRouteSpec(spec: string): { prov: ProviderId; model: string } | null {
  const [rawProv, ...rest] = (spec || "").split(":");
  const model = rest.join(":").trim();
  const prov = rawProv.trim() as ProviderId;
  if (!model || !["groq", "openai", "openrouter"].includes(prov)) return null;
  return { prov, model };
}

/** Canonical list of supported models by provider */
export const SUPPORTED_MODELS: Record<ProviderId, readonly string[]> = {
  openrouter: [
    "minimax/minimax-m3:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "openrouter/free",
  ],
  groq: [
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "mixtral-8x7b-32768",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "o1-mini",
    "o3-mini",
  ],
} as const;

export function isSupportedModel(provider: string, model: string): boolean {
  const prov = provider as ProviderId;
  const list = SUPPORTED_MODELS[prov];
  if (!list) return false;
  return list.includes(model) || list.some((m) => m.toLowerCase() === model.toLowerCase());
}

/** Human-readable label for a route, for the "answered by" record. */
export function routeLabel(prov: ProviderId, model: string): string {
  const short =
    model
      .replace(/:free$/, "")
      .split("/")
      .pop() || model;
  const provName =
    prov === "openrouter" ? "OpenRouter" : prov === "groq" ? "Groq" : "OpenAI-compatible";
  return `${short} (${provName})`;
}

export function cleanApiKey(k?: string): string {
  return (k || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

export function hasProviderKey(
  prov: ProviderId,
  settings?: { groqApiKey?: string; openaiCompatKey?: string; openRouterKey?: string }
): boolean {
  if (!settings) return false;
  if (prov === "groq") return !!cleanApiKey(settings.groqApiKey);
  if (prov === "openai") return !!cleanApiKey(settings.openaiCompatKey);
  return !!cleanApiKey(settings.openRouterKey);
}

/** Dynamically constructs the authoritative runtime model routing specification for self-description. */
export function getAuthoritativeModelSummary(settings?: {
  taskModels?: { fast?: string; thinking?: string; coding?: string };
  groqApiKey?: string;
  openaiCompatKey?: string;
  openRouterKey?: string;
}): string {
  const fast = settings?.taskModels?.fast || MODEL_TRIO.fast;
  const thinking = settings?.taskModels?.thinking || MODEL_TRIO.capable;
  const coding = settings?.taskModels?.coding || MODEL_TRIO.coding;
  const primary = MODEL_TRIO.primary;

  const hasOpenRouter = hasProviderKey("openrouter", settings);
  const hasGroq = hasProviderKey("groq", settings);
  const hasOpenAI = hasProviderKey("openai", settings);

  const activeProviders: string[] = [];
  if (hasOpenRouter) activeProviders.push("OpenRouter");
  if (hasGroq) activeProviders.push("Groq");
  if (hasOpenAI) activeProviders.push("OpenAI-compatible");

  const sessionStatus = activeProviders.length > 0
    ? `Active credentials configured for: ${activeProviders.join(", ")}`
    : `No online API keys configured in Settings (offline / local fallback mode active)`;

  const groqStatus = hasGroq
    ? `Groq (${GROQ_EMERGENCY_MODEL}) [AVAILABLE for emergency fallback]`
    : `Groq (${GROQ_EMERGENCY_MODEL}) [UNAVAILABLE — API key not configured in Settings]`;

  const fallbackChainStatus = hasOpenRouter
    ? `${TEXT_FALLBACKS.join(", ")} [AVAILABLE via OpenRouter]`
    : `${TEXT_FALLBACKS.join(", ")} [UNAVAILABLE — OpenRouter API key not configured in Settings]`;

  return `MODEL ROUTING (Configured Architecture & Session Availability):\n` +
    `• Session Provider Credential Status: ${sessionStatus}\n` +
    `• Primary General Lane: ${primary}\n` +
    `• Fast / Voice Lane: ${fast}\n` +
    `• Thinking / Capable Lane: ${thinking}\n` +
    `• Coding Lane: ${coding}\n` +
    `• Emergency Fallback: ${groqStatus}\n` +
    `• Fallback Chain: ${fallbackChainStatus}`;
}

/** Dynamically constructs the complete authoritative runtime system architecture specification for self-description. */
export function getAuthoritativeSystemArchitecture(settings?: {
  taskModels?: { fast?: string; thinking?: string; coding?: string };
  groqApiKey?: string;
  openaiCompatKey?: string;
  openRouterKey?: string;
}): string {
  return getAuthoritativeModelSummary(settings);
}
