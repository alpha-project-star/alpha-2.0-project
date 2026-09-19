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
