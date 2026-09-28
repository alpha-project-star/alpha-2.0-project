import {
  claimsMutationWithoutTag,
  NO_ACTION_NOTICE,
  renderActionReport,
  type ActionResult,
} from "../actions";
import { stripLeakedThinking } from "../openai-compat";
import type { RequestActionLifecycle } from "../request-lifecycle";
import type { AlphaGateActionStatus, NativeToolExecutionSummary } from "./types";

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

  // 2. Trailing or inline infrastructure banners
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

  const claimsActionInProse = claimsMutationWithoutTag(text);

  // Determine canonical action status
  let actionStatus: AlphaGateActionStatus = "none";

  if (!hasAnyExecution) {
    if (claimsActionInProse) {
      // Case C: Prose claims action, but no execution occurred
      actionStatus = "unverified_claim";
      if (!text.includes(NO_ACTION_NOTICE)) {
        text = (text ? text + "\n\n" : "") + NO_ACTION_NOTICE;
        repaired = true;
      }
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
    // Case B: All mutations failed
    actionStatus = "all_failed";
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
 * Reconciles web sources and citations against verified retrieved context.
 * Strips hallucinated sources; retains only verified, cited references.
 */
export function verifyAndReconcileSources(
  input: string,
  webContext?: string,
): { text: string; filtered: boolean } {
  if (!input) return { text: "", filtered: false };

  const hadSourcesSection = /\n+\*\*Sources:?\*\*[\s\S]*$/i.test(input);
  const bodyText = input.replace(/\n+\*\*Sources:?\*\*[\s\S]*$/i, "").trim();

  // If the reply explicitly expresses that search results were insufficient, do not display sources
  const admitsInsufficient =
    /\b(?:insufficient (?:evidence|results|details)|returned (?:no usable|mostly general)|couldn\x27t responsibly|cannot responsibly|risking (?:another )?fabricated|could not verify)\b/i.test(
      bodyText,
    );

  if (admitsInsufficient || !webContext) {
    const filtered = hadSourcesSection;
    return { text: bodyText, filtered };
  }

  const sourcesMap = parseSourcesFromWebContext(webContext);
  if (sourcesMap.size === 0) {
    return { text: bodyText, filtered: hadSourcesSection };
  }

  // Extract all citation markers [N] or [N, M] in body
  const citationMatches = [...bodyText.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)];
  const citedNumbers = new Set<number>();
  for (const m of citationMatches) {
    const parts = m[1].split(",");
    for (const p of parts) {
      const num = Number(p.trim());
      if (!isNaN(num) && num > 0) {
        citedNumbers.add(num);
      }
    }
  }

  if (citedNumbers.size === 0) {
    return { text: bodyText, filtered: hadSourcesSection };
  }

  const validCited = [...citedNumbers]
    .filter((n) => sourcesMap.has(n))
    .sort((a, b) => a - b)
    .map((n) => sourcesMap.get(n)!);

  if (validCited.length === 0) {
    return { text: bodyText, filtered: hadSourcesSection };
  }

  const sourcesList = validCited.map((r) => `- [${r.n}] [${r.title}](${r.url})`).join("\n");
  const resultText = `${bodyText}\n\n**Sources:**\n${sourcesList}`;
  return { text: resultText, filtered: hadSourcesSection && resultText !== input };
}
