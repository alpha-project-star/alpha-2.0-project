import {
  claimsMutationWithoutTag,
  NO_ACTION_NOTICE,
  renderActionReport,
  type ActionResult,
} from "../actions";
import { stripLeakedThinking } from "../openai-compat";
import type { RequestActionLifecycle } from "../request-lifecycle";
import type { AlphaGateActionStatus, DeferredProseBlock, NativeToolExecutionSummary } from "./types";

/**
 * Strips reasoning tags and scratchpads while strictly preserving legitimate user/model prose.
 */
export function stripReasoningAndScratchpads(input: string): { text: string; stripped: boolean } {
  if (!input) return { text: "", stripped: false };

  const initial = input;
  let text = stripLeakedThinking(input);

  // Additional defense for isolated XML tags if any survived
  const tags = [
    "think",
    "thinking",
    "reasoning",
    "thought",
    "analysis",
    "internal_monologue",
    "thought_process",
    "scratchpad",
  ];
  for (const tag of tags) {
    const rx = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi");
    text = text.replace(rx, "");
  }

  const stripped = text.trim() !== initial.trim();
  return { text: text.trim(), stripped };
}

/**
 * Neutralizes provider self-identification and infrastructure diagnostic leakage.
 * Only targets self-declarations; leaves informational mentions (e.g. "OpenAI is an AI company") intact.
 */
export function stripProviderIdentityLeaks(input: string): { text: string; stripped: boolean } {
  if (!input) return { text: "", stripped: false };

  let text = input;

  // 1. Self-identifying greetings or introductory clauses at the start of text or lines
  const introPatterns = [
    /^(?:(?:Hello|Hi|Greetings)[!.,]?\s*)?(?:As an?|I am|I'm)\s+(?:an?\s+)?(?:OpenAI assistant|ChatGPT|GPT-4[a-z0-9.-]*|Llama(?:\s*3(?:\.\d+)?)?|Claude|Groq model|OpenRouter model|Meta AI model)[,.]?\s*/im,
    /^(?:I am|I'm)\s+(?:a large language model trained by OpenAI|an AI trained by OpenAI|an AI created by Meta|a language model trained by Meta|built by Anthropic)\.?\s*/im,
  ];

  for (const rx of introPatterns) {
    text = text.replace(rx, "");
  }

  // 2. Trailing or infrastructure banners
  const bannerPatterns = [
    /\b(?:Running on Groq|Powered by Groq|Hosted by Groq|Serving via Groq)\b\.?\s*/gi,
    /\b(?:Running on OpenRouter|Powered by OpenRouter)\b\.?\s*/gi,
  ];

  for (const rx of bannerPatterns) {
    text = text.replace(rx, "");
  }

  const stripped = text.trim() !== input.trim();
  return { text: text.trim(), stripped };
}

const FALSE_MUTATION_CLAIM_REGEX =
  /\b(?:i(?:'ve| have)?\s+(?:just\s+)?(?:already\s+)?(?:saved|added|created|deleted|removed|updated|changed|set|scheduled|cleared|marked|noted|remembered|canceled|cancelled|completed)|(?:done|saved|added|deleted|removed|updated|noted|remembered|canceled|cancelled|completed)\s*[.!]|\b(?:i(?:'ll| will)\s+(?:go ahead and\s+)?(?:delete|remove|save|update|create|set|schedule|clear|mark))\b|it'?s\s+(?:saved|added|deleted|done|set|noted|remembered|completed|cancelled))\b/i;

// Mapping of tool names to regex for bounded, operation-specific action validation.
// Verifies that a sentence specifically describes the actual operation performed,
// not merely a generic verb like "add", "save", or "update".
const OPERATION_CLAIM_MATCHERS: Record<string, RegExp> = {
  createReminder: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:created|scheduled|set|added|saved))|(?:created|scheduled|set|added|saved))\s+(?:a|the|your)?\s*(?:new\s+)?(?:reminder|appointment|alarm|alert)\b|\b(?:reminder|appointment|alarm|alert)\s+(?:has been|is|was)\s+(?:created|scheduled|set|added|saved)\b/i,
  updateReminder: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|changed|rescheduled|modified|edited))|(?:updated|changed|rescheduled|modified|edited))\s+(?:the|your|a)?\s*(?:reminder|appointment|alarm|alert)\b|\b(?:reminder|appointment|alarm|alert)\s+(?:has been|is|was)\s+(?:updated|changed|rescheduled|modified|edited)\b/i,
  deleteReminder: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed|canceled|cancelled|cleared))|(?:deleted|removed|canceled|cancelled|cleared))\s+(?:the|your|a)?\s*(?:reminder|appointment|alarm|alert)\b|\b(?:reminder|appointment|alarm|alert)\s+(?:has been|is|was)\s+(?:deleted|removed|canceled|cancelled|cleared)\b/i,
  completeReminder: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:completed|marked(?:\s+as)?\s+(?:done|complete|completed)|finished))|(?:completed|marked(?:\s+as)?\s+(?:done|complete|completed)|finished))\s+(?:the|your|a)?\s*(?:reminder|appointment|task)\b|\b(?:reminder|appointment|task)\s+(?:has been|is|was)\s+(?:completed|marked(?:\s+as)?\s+(?:done|complete|completed)|finished)\b/i,
  addNote: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:created|added|saved|written|noted))|(?:created|added|saved|written|noted))\s+(?:a|the|your)?\s*(?:new\s+)?note\b|\bnote\s+(?:has been|is|was)\s+(?:created|added|saved)\b/i,
  updateNote: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|edited|changed))|(?:updated|edited|changed))\s+(?:the|your|a)?\s*note\b|\bnote\s+(?:has been|is|was)\s+(?:updated|edited|changed)\b/i,
  deleteNote: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed|cleared))|(?:deleted|removed|cleared))\s+(?:the|your|a)?\s*note\b|\bnote\s+(?:has been|is|was)\s+(?:deleted|removed|cleared)\b/i,
  addMemory: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:remembered|saved|added|stored))|(?:remembered|saved))\s+(?:that|this)?\s*(?:to|in)?\s*(?:your\s+)?memory\b|\b(?:i'll|i will)\s+remember\s+that\b|\bmemory\s+(?:has been|is|was)\s+(?:saved|stored)\b/i,
  updateMemory: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|changed|modified))|(?:updated|changed))\s+(?:the|your)?\s*memory\b|\bmemory\s+(?:has been|is|was)\s+(?:updated|changed)\b/i,
  deleteMemory: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed|forgotten|cleared))|(?:deleted|removed|forgotten))\s+(?:that|the|your)?\s*(?:from\s+)?memory\b|\bmemory\s+(?:has been|is|was)\s+(?:deleted|cleared)\b/i,
  addBill: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:added|saved|created|recorded))|(?:added|saved|recorded))\s+(?:the|a|your)?\s*(?:new\s+)?bill\b|\bbill\s+(?:has been|is|was)\s+(?:added|saved|recorded)\b/i,
  updateBill: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|changed|modified))|(?:updated|changed))\s+(?:the|your|a)?\s*bill\b|\bbill\s+(?:has been|is|was)\s+(?:updated|changed)\b/i,
  deleteBill: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed))|(?:deleted|removed))\s+(?:the|your|a)?\s*bill\b|\bbill\s+(?:has been|is|was)\s+(?:deleted|removed)\b/i,
  markBillPaid: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:marked|recorded|paid))|(?:marked|paid))\s+(?:the|your|a)?\s*bill\s+(?:as\s+)?paid\b|\bbill\s+(?:has been|is|was)\s+marked\s+(?:as\s+)?paid\b/i,
  addTask: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:created|added|saved|scheduled|set))|(?:created|added|saved|scheduled|set))\s+(?:a|the|your)?\s*(?:new\s+)?task\b|\btask\s+(?:has been|is|was)\s+(?:created|added|saved|scheduled|set)\b/i,
  updateTask: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|changed|modified|edited))|(?:updated|changed|modified|edited))\s+(?:the|your|a)?\s*task\b|\btask\s+(?:has been|is|was)\s+(?:updated|changed|modified|edited)\b/i,
  deleteTask: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed|canceled|cancelled|cleared))|(?:deleted|removed|canceled|cancelled|cleared))\s+(?:the|your|a)?\s*task\b|\btask\s+(?:has been|is|was)\s+(?:deleted|removed|canceled|cancelled|cleared)\b/i,
  addGoal: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:created|added|saved|set))|(?:created|added|saved|set))\s+(?:a|the|your)?\s*(?:new\s+)?goal\b|\bgoal\s+(?:has been|is|was)\s+(?:created|added|saved|set)\b/i,
  updateGoal: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|changed|modified|edited))|(?:updated|changed|modified|edited))\s+(?:the|your|a)?\s*goal\b|\bgoal\s+(?:has been|is|was)\s+(?:updated|changed|modified|edited)\b/i,
  deleteGoal: /\b(?:(?:i(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed|canceled|cancelled|cleared))|(?:deleted|removed|canceled|cancelled|cleared))\s+(?:the|your|a)?\s*goal\b|\bgoal\s+(?:has been|is|was)\s+(?:deleted|removed|canceled|cancelled|cleared)\b/i,
};

/**
 * Safely segments text into sentences while protecting URLs, decimals, abbreviations,
 * and code blocks from being split on punctuation.
 */
function splitIntoSafeSentences(text: string): string[] {
  if (!text) return [];

  const codeBlocks: string[] = [];
  let protectedText = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const placeholder = `__CODE_${codeBlocks.length}__`;
    codeBlocks.push(match);
    return placeholder;
  });

  const urls: string[] = [];
  protectedText = protectedText.replace(/https?:\/\/[^\s)]+/g, (match) => {
    const placeholder = `__URL_${urls.length}__`;
    urls.push(match);
    return placeholder;
  });

  const decimals: string[] = [];
  protectedText = protectedText.replace(/\b\d+\.\d+\b/g, (match) => {
    const placeholder = `__DEC_${decimals.length}__`;
    decimals.push(match);
    return placeholder;
  });

  protectedText = protectedText.replace(/\b(?:e\.g\.|i\.e\.|vs\.|etc\.|mr\.|mrs\.|ms\.|dr\.)(?=\s+)/gi, (match) => {
    return match.replace(/\./g, "__DOT__");
  });

  const segments = protectedText.split(/(?<=[.!?])\s+(?=[A-Z0-9"']|\b__)|(?:\r?\n)+/);

  const restore = (seg: string): string => {
    let restored = seg.replace(/__DOT__/g, ".");
    restored = restored.replace(/__DEC_(\d+)__/g, (_, idx) => decimals[Number(idx)] ?? _);
    restored = restored.replace(/__URL_(\d+)__/g, (_, idx) => urls[Number(idx)] ?? _);
    restored = restored.replace(/__CODE_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)] ?? _);
    return restored.trim();
  };

  return segments.map(restore).filter(Boolean);
}

/**
 * Reconciles deferred preliminary prose against specific tool outcomes and the final answer.
 * Filters out redundant, contradictory, or unverified action claims at the sentence level.
 */
export function reconcileDeferredProse(
  deferred: DeferredProseBlock[],
  summary?: NativeToolExecutionSummary,
  finalAnswer?: string,
): string[] {
  if (!deferred || deferred.length === 0) return [];

  const result: string[] = [];
  const finalLower = (finalAnswer || "").toLowerCase();

  // Create a map of tool call results for efficient lookup, handling potential duplicates as ambiguous
  const toolResultsMap = new Map<string, Array<{ success: boolean; name: string }>>();
  if (summary?.results) {
    for (const r of summary.results) {
      const keys = new Set<string>();
      if (r.executionKey) keys.add(r.executionKey);
      if ((r as any).id) keys.add((r as any).id);
      if ((r as any).tool_call_id) keys.add((r as any).tool_call_id);
      for (const k of keys) {
        const existing = toolResultsMap.get(k) || [];
        existing.push({ success: r.success, name: r.name });
        toolResultsMap.set(k, existing);
      }
    }
  }

  for (const block of deferred) {
    const trimmed = block.text?.trim();
    if (!trimmed) continue;

    // 1. Discard internal status cues or reasoning-like short fragments
    if (
      trimmed.length < 5 ||
      /^(?:ok|checking|searching|working on it|one moment|hold on)\.?$/i.test(trimmed)
    ) {
      continue;
    }

    // 2. Discard if essentially identical to what's already in the final answer
    if (trimmed.length > 15 && finalLower.includes(trimmed.toLowerCase())) {
      continue;
    }

    // 3. Sentence-level validation against specific tool outcomes using safe segmentation
    const sentences = splitIntoSafeSentences(trimmed);
    const keptSentences: string[] = [];

    for (const s of sentences) {
      const isAction = claimsMutationWithoutTag(s) || FALSE_MUTATION_CLAIM_REGEX.test(s);
      if (!isAction) {
        // Safe, non-action explanatory prose preserved
        keptSentences.push(s.trim());
        continue;
      }

      // If it's an action claim, it MUST have associated tool calls
      if (!block.toolCalls || block.toolCalls.length === 0) continue;

      // Identify which specific operations this sentence claims to have performed
      const claimedOperations: string[] = [];
      for (const [opName, rx] of Object.entries(OPERATION_CLAIM_MATCHERS)) {
        if (rx.test(s)) {
          claimedOperations.push(opName);
        }
      }

      // Fail closed: if a mutation is claimed but cannot be mapped to any known operation, discard it
      if (claimedOperations.length === 0) {
        continue;
      }

      // Requirement: When a sentence describes multiple actions, verify each claimed operation
      // against its own execution result. Every claimed operation in the sentence must be backed
      // by an unambiguous, successful tool call.
      const allClaimedOpsVerified = claimedOperations.every((opName) => {
        return block.toolCalls!.some((tc) => {
          const tcName = (tc as any).name || (tc as any).function?.name;
          if (tcName && tcName !== opName) return false;

          const key =
            (tc as any)._executionKey ||
            (tc as any).executionKey ||
            (tc as any).id ||
            (tc as any).tool_call_id;

          if (key) {
            const results = toolResultsMap.get(key);
            return (
              results &&
              results.length === 1 &&
              results[0].success &&
              results[0].name === opName
            );
          }

          // If no execution key is present on the tool call or results, require that
          // summary.results has exactly one unambiguous result for this opName
          const matchingResults = (summary?.results || []).filter(
            (r) => r.name === opName
          );
          return (
            matchingResults.length === 1 &&
            matchingResults[0].success &&
            matchingResults[0].name === opName
          );
        });
      });

      if (allClaimedOpsVerified) {
        keptSentences.push(s.trim());
      }
    }

    const filteredText = keptSentences.filter(Boolean).join(" ");
    if (filteredText) {
      result.push(filteredText);
    }
  }

  return result;
}

/**
 * Strips false or unverified mutation claim sentences/prose from text.
 * Preserves legitimate surrounding prose.
 */
export function stripFalseActionClaims(input: string): { text: string; stripped: boolean } {
  if (!input) return { text: "", stripped: false };

  const initial = input;
  const paragraphs = input.split(/\n\n+/);
  const filteredParagraphs: string[] = [];
  let strippedAny = false;

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (claimsMutationWithoutTag(trimmedPara) || FALSE_MUTATION_CLAIM_REGEX.test(trimmedPara)) {
      const sentences = para.match(/[^.!?\n]+[.!?]*/g) || [para];
      if (sentences.length === 1) {
        strippedAny = true;
        continue;
      }
    }

    const sentences = para.match(/[^.!?\n]+[.!?]*/g) || [para];
    const keptSentences: string[] = [];

    for (const s of sentences) {
      const trimmed = s.trim();
      if (claimsMutationWithoutTag(trimmed) || FALSE_MUTATION_CLAIM_REGEX.test(trimmed)) {
        strippedAny = true;
      } else {
        keptSentences.push(trimmed);
      }
    }

    const nextPara = keptSentences.filter(Boolean).join(" ");
    if (nextPara) {
      filteredParagraphs.push(nextPara);
    }
  }

  const result = filteredParagraphs.join("\n\n").trim();
  return { text: result, stripped: strippedAny || result !== initial.trim() };
}

/**
 * Reconciles user-facing prose claims against authoritative execution records (toolSummary, actionResults, lifecycle).
 * Guarantees that no successful action is claimed without verified execution.
 */
export function verifyAndReconcileActions(
  input: string,
  toolSummary?: NativeToolExecutionSummary,
  actionResults?: ActionResult[],
  lifecycle?: RequestActionLifecycle,
): { text: string; actionStatus: AlphaGateActionStatus; repaired: boolean } {
  let text = input;
  let repaired = false;

  // 1. Determine execution state
  const hasActionResults = Boolean(actionResults && actionResults.length > 0);
  const hasToolMutations = Boolean(toolSummary && toolSummary.hasMutation);
  const hasLifecycleMutations = Boolean(
    lifecycle && (lifecycle.hasCompletedMutations() || lifecycle.hasFailedMutations()),
  );

  const hasAnyExecution = hasActionResults || hasToolMutations || hasLifecycleMutations;

  const failedActionResults = actionResults ? actionResults.filter((r) => r.status !== "success") : [];
  const hasFailedActionResults = failedActionResults.length > 0;
  const hasFailedToolMutations = Boolean(toolSummary && toolSummary.hasFailedMutation);
  const hasFailedLifecycle = Boolean(lifecycle && lifecycle.hasFailedMutations());

  const hasAnyFailure = hasFailedActionResults || hasFailedToolMutations || hasFailedLifecycle;

  const successfulActionResults = actionResults ? actionResults.filter((r) => r.status === "success") : [];
  const hasSuccessfulActionResults = successfulActionResults.length > 0;
  const hasSuccessfulToolMutations = Boolean(
    toolSummary && toolSummary.results.some((r) => r.isMutation && r.success),
  );
  const hasSuccessfulLifecycle = Boolean(lifecycle && lifecycle.hasCompletedMutations());

  const hasAnySuccess =
    hasSuccessfulActionResults || hasSuccessfulToolMutations || hasSuccessfulLifecycle;

  const claimsActionInProse = claimsMutationWithoutTag(text) || FALSE_MUTATION_CLAIM_REGEX.test(text);

  // Determine canonical action status
  let actionStatus: AlphaGateActionStatus = "none";

  if (!hasAnyExecution) {
    if (claimsActionInProse) {
      // Case C: Prose claims action, but no execution occurred -> neutralize false claim
      actionStatus = "unverified_claim";
      const stripped = stripFalseActionClaims(text);
      text = stripped.text;
      if (!text.includes(NO_ACTION_NOTICE)) {
        text = (text ? text + "\n\n" : "") + NO_ACTION_NOTICE;
      }
      repaired = true;
    } else {
      actionStatus = "none";
    }
  } else if (hasAnyFailure && hasAnySuccess) {
    // Case D: Partial success/failure across multiple actions
    actionStatus = "partial_failure";
    const report = actionResults && actionResults.length > 0 ? renderActionReport(actionResults) : "";
    if (report && !text.includes(report)) {
      text = (text ? text + "\n\n" : "") + report;
      repaired = true;
    }
    if (toolSummary?.hasFailedMutation) {
      const failedMutations = toolSummary.results.filter((r) => r.isMutation && !r.success);
      const failureLines = failedMutations.map((f) => `❌ ${f.error?.message || `Failed to execute ${f.name}.`}`);
      const failureReport = `**Action log — read this over anything I said above:**\n${failureLines.join("\n")}`;
      if (!text.includes(failureReport)) {
        text = (text ? text + "\n\n" : "") + failureReport;
        repaired = true;
      }
    }
  } else if (hasAnyFailure && !hasAnySuccess) {
    // Case B: All mutations failed -> neutralize false claim in prose
    actionStatus = "all_failed";
    const stripped = stripFalseActionClaims(text);
    text = stripped.text;
    repaired = true;

    const report = actionResults && actionResults.length > 0 ? renderActionReport(actionResults) : "";
    if (report && !text.includes(report)) {
      text = (text ? text + "\n\n" : "") + report;
    }
    if (toolSummary?.hasFailedMutation) {
      const failedMutations = toolSummary.results.filter((r) => r.isMutation && !r.success);
      const failureLines = failedMutations.map((f) => `❌ ${f.error?.message || `Failed to execute ${f.name}.`}`);
      const failureReport = `**Action log — read this over anything I said above:**\n${failureLines.join("\n")}`;
      if (!text.includes(failureReport)) {
        text = (text ? text + "\n\n" : "") + failureReport;
      }
    }
  } else {
    // Case A & E: All mutations succeeded
    actionStatus = "success";
    const report = actionResults && actionResults.length > 0 ? renderActionReport(actionResults) : "";
    if (report && !text.includes(report)) {
      text = (text ? text + "\n\n" : "") + report;
      repaired = true;
    }
  }

  return { text: text.trim(), actionStatus, repaired };
}

/**
 * Parses canonical web sources from webContext.
 */
export function parseSourcesFromWebContext(
  webContext?: string,
): Map<number, { n: number; title: string; url: string }> {
  const sourcesMap = new Map<number, { n: number; title: string; url: string }>();
  if (!webContext) return sourcesMap;

  const lines = webContext.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^\[(\d+)\]\s+(.+)$/);
    if (!m) continue;

    const n = Number(m[1]);
    let title = m[2].trim();

    const headlineMatch = title.match(/^Headline:\s*["“](.+?)["”]$/);
    if (headlineMatch) {
      title = headlineMatch[1].trim();
    }

    let url = "";
    const inlineDashUrl = title.match(/^(.+?)\s+-\s+(https?:\/\/\S+)$/);
    if (inlineDashUrl) {
      title = inlineDashUrl[1].trim();
      url = inlineDashUrl[2].trim();
    } else {
      const inlineParenUrl = title.match(/\(URL:\s*(https?:\/\/[^,)\s]+)/i);
      if (inlineParenUrl) {
        url = inlineParenUrl[1].trim();
        title = title.replace(/\s*\(URL:\s*https?:\/\/[^)]+\)/i, "").trim();
      }
    }

    if (!url) {
      const urlLine = lines.slice(i + 1, i + 6).find((l) => /^\s*URL:\s*/i.test(l));
      if (urlLine) {
        url = urlLine.replace(/^\s*URL:\s*/i, "").trim();
      }
    }

    if (url) {
      title = title.replace(/\s+-\s+https?:\/\/\S+$/, "").trim();
      if (!sourcesMap.has(n)) {
        sourcesMap.set(n, { n, title, url });
      } else {
        const existing = sourcesMap.get(n)!;
        if ((!existing.title || existing.title.startsWith("Headline:")) && title && !title.startsWith("Headline:")) {
          sourcesMap.set(n, { n, title, url: existing.url || url });
        }
      }
    }
  }

  return sourcesMap;
}

/**
 * Strips or filters citation markers [N] or [N, M] in text that are not supported by validNumbers.
 */
export function sanitizeCitationMarkers(
  text: string,
  validNumbers: Set<number>,
): { text: string; modified: boolean } {
  let modified = false;

  // Match citation markers like [1], [99], [1, 2], [1, 99] that are not part of markdown links [1](url)
  const regex = /(?:(\s*)\[(\d+(?:\s*,\s*\d+)*)\](?!\()(\s*))/g;

  const result = text.replace(regex, (_match, prefix, digitsGroup, suffix) => {
    const parts = digitsGroup.split(",").map((p: string) => p.trim());
    const validParts = parts.filter((p: string) => {
      const num = Number(p);
      return !isNaN(num) && validNumbers.has(num);
    });

    if (validParts.length === 0) {
      modified = true;
      if (prefix && suffix && suffix.startsWith(" ")) {
        return " ";
      }
      return "";
    }

    if (validParts.length !== parts.length) {
      modified = true;
    }

    return `${prefix}[${validParts.join(", ")}]${suffix}`;
  });

  // Clean up any spacing before punctuation caused by removal, e.g. "info  ." -> "info."
  const cleaned = result
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return { text: cleaned, modified };
}

/**
 * Reconciles web sources and citations against verified retrieved context.
 * Strips hallucinated sources and unsupported citation markers in body; retains only verified, cited references.
 */
export function verifyAndReconcileSources(
  input: string,
  webContext?: string,
): { text: string; filtered: boolean } {
  if (!input) return { text: "", filtered: false };

  const hadSourcesSection = /\n+\*\*Sources:?\*\*[\s\S]*$/i.test(input);
  const rawBodyText = input.replace(/\n+\*\*Sources:?\*\*[\s\S]*$/i, "").trim();

  // If the reply explicitly expresses that search results were insufficient, do not display sources or citations
  const admitsInsufficient =
    /\b(?:insufficient (?:evidence|results|details)|returned (?:no usable|mostly general)|couldn\x27t responsibly|cannot responsibly|risking (?:another )?fabricated|could not verify)\b/i.test(
      rawBodyText,
    );

  if (admitsInsufficient || !webContext) {
    const sanitized = sanitizeCitationMarkers(rawBodyText, new Set<number>());
    const filtered = hadSourcesSection || sanitized.modified;
    return { text: sanitized.text, filtered };
  }

  const sourcesMap = parseSourcesFromWebContext(webContext);
  if (sourcesMap.size === 0) {
    const sanitized = sanitizeCitationMarkers(rawBodyText, new Set<number>());
    return { text: sanitized.text, filtered: hadSourcesSection || sanitized.modified };
  }

  const validNumbers = new Set<number>(sourcesMap.keys());
  const sanitized = sanitizeCitationMarkers(rawBodyText, validNumbers);
  const cleanBody = sanitized.text;

  // Extract all citation markers [N] or [N, M] in cleaned body
  const citationMatches = [...cleanBody.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)];
  const citedNumbers = new Set<number>();
  for (const m of citationMatches) {
    const parts = m[1].split(",");
    for (const p of parts) {
      const num = Number(p.trim());
      if (!isNaN(num) && validNumbers.has(num)) {
        citedNumbers.add(num);
      }
    }
  }

  if (citedNumbers.size === 0) {
    return { text: cleanBody, filtered: hadSourcesSection || sanitized.modified };
  }

  const validCited = [...citedNumbers]
    .filter((n) => sourcesMap.has(n))
    .sort((a, b) => a - b)
    .map((n) => sourcesMap.get(n)!);

  if (validCited.length === 0) {
    return { text: cleanBody, filtered: hadSourcesSection || sanitized.modified };
  }

  const sourcesList = validCited.map((r) => `- [${r.n}] [${r.title}](${r.url})`).join("\n");
  const resultText = `${cleanBody}\n\n**Sources:**\n${sourcesList}`;
  const filtered = hadSourcesSection || sanitized.modified || resultText !== input;
  return { text: resultText, filtered };
}
