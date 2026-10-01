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

// Mapping of tool names to regex for bounded action validation
const TOOL_ACTION_VALIDATORS: Record<string, RegExp> = {
  createReminder: /\b(?:create|add|save|set|schedule)\b/i,
  updateReminder: /\b(?:update|change|edit)\b/i,
  deleteReminder: /\b(?:delete|remove|cancel|clear)\b/i,
  completeReminder: /\b(?:complete|done|mark|finish)\b/i,
  addNote: /\b(?:save|add|create)\b/i,
  updateNote: /\b(?:update|change)\b/i,
  deleteNote: /\b(?:delete|remove)\b/i,
  addMemory: /\b(?:save|add|remember)\b/i,
  updateMemory: /\b(?:update|change)\b/i,
  deleteMemory: /\b(?:delete|remove)\b/i,
  addBill: /\b(?:save|add)\b/i,
  updateBill: /\b(?:update|change)\b/i,
  deleteBill: /\b(?:delete|remove)\b/i,
  markBillPaid: /\b(?:paid|pay)\b/i,
};

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
      if (r.executionKey) {
        const existing = toolResultsMap.get(r.executionKey) || [];
        existing.push({ success: r.success, name: r.name });
        toolResultsMap.set(r.executionKey, existing);
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

    // 3. Sentence-level validation against specific tool outcomes
    const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-Z])/);
    const keptSentences: string[] = [];

    for (const s of sentences) {
      const isAction = claimsMutationWithoutTag(s) || FALSE_MUTATION_CLAIM_REGEX.test(s);
      if (!isAction) {
        keptSentences.push(s.trim());
        continue;
      }

      // If it's an action claim, it MUST have associated successful tool calls for every operation described.
      if (!block.toolCalls || block.toolCalls.length === 0) continue;

      // Ensure every tool call in the block succeeded, AND the claim matches the operation name exactly
      const isVerified = block.toolCalls.every((tc) => {
        const key = (tc as any)._executionKey;
        const results = toolResultsMap.get(key);
        
        // Unambiguous, successful result required
        if (!results || results.length !== 1 || !results[0].success) return false;

        const res = results[0];
        const rx = TOOL_ACTION_VALIDATORS[res.name];
        return rx ? rx.test(s) : false; // Fail closed for unknown tools
      });

      if (isVerified) {
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
