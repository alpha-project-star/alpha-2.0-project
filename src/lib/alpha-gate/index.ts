import { normalizePresentation } from "../presentation";
import { stripLeakedThinking } from "../openai-compat";
import type {
  AlphaGateCandidate,
  AlphaGateDiagnostics,
  AlphaGateResult,
} from "./types";
import {
  stripProviderIdentityLeaks,
  stripReasoningAndScratchpads,
  verifyAndReconcileActions,
  verifyAndReconcileSources,
} from "./verifiers";

export * from "./types";
export * from "./verifiers";

/**
 * Standard in-character fallback response for empty or unrecoverable inputs.
 */
export const ALPHA_GATE_FALLBACK_TEXT =
  "I'm here, but I didn't produce a response. Could you say that again?";

/**
 * Alpha Gate — The Authoritative Final-Response Boundary for Alpha 2.0.
 *
 * Enforces a strict presentation, security, and verification contract across all
 * response-producing subsystems (models, local intents, settings, proactive, ambient, etc.).
 */
export class AlphaGate {
  /**
   * Processes a candidate response through the authoritative Alpha Gate pipeline.
   * Deterministic, local, non-mutating, and fail-safe.
   */
  public process(candidate: AlphaGateCandidate): AlphaGateResult {
    // 0. Cancellation Check
    if (candidate?.signal?.aborted) {
      return {
        approvedText: "Generation stopped.",
        status: "fallback",
        actionStatus: "none",
      };
    }

    // 1. Input Validation & Action Execution Gate
    let raw = candidate?.rawText || "";
    if (candidate?.deferredProse && candidate.deferredProse.length > 0) {
      const combinedProse = candidate.deferredProse
        .map((p) => p.trim())
        .filter(Boolean)
        .join("\n\n");
      if (combinedProse) {
        raw = combinedProse + (raw ? "\n\n" + raw : "");
      }
    }

    const hasExecution = Boolean(
      (candidate?.actionResults && candidate.actionResults.length > 0) ||
      (candidate?.toolSummary && candidate.toolSummary.hasMutation) ||
      (candidate?.lifecycle && (candidate.lifecycle.hasCompletedMutations() || candidate.lifecycle.hasFailedMutations()))
    );

    if (!raw.trim() && !hasExecution) {
      return {
        approvedText: ALPHA_GATE_FALLBACK_TEXT,
        status: "fallback",
        actionStatus: "none",
      };
    }

    try {
      const diagnostics: AlphaGateDiagnostics = {};

      // Stage 1: Reasoning Isolation
      const reasoningResult = stripReasoningAndScratchpads(raw);
      let currentText = reasoningResult.text;
      if (reasoningResult.stripped) {
        diagnostics.thinkingStripped = true;
      }

      // Stage 2: Provider Identity Filtering
      const providerResult = stripProviderIdentityLeaks(currentText);
      currentText = providerResult.text;
      if (providerResult.stripped) {
        diagnostics.providerLeakStripped = true;
      }

      // Stage 3: Action Claim & Execution Verification
      const actionResult = verifyAndReconcileActions(
        currentText,
        candidate.toolSummary,
        candidate.actionResults,
        candidate.lifecycle,
      );
      currentText = actionResult.text;
      if (actionResult.repaired) {
        diagnostics.actionRepaired = true;
      }

      // Stage 4: Web Sources & Citation Verification
      const sourceResult = verifyAndReconcileSources(currentText, candidate.webContext);
      currentText = sourceResult.text;
      if (sourceResult.filtered) {
        diagnostics.sourcesFiltered = true;
      }

      // Stage 5: Structural & Presentation Normalization
      // Inspect pre-normalization syntax for diagnostics
      const preNormFences = (currentText.match(/^(?:`{3,}|~{3,})/gm) || []).length;
      const preNormMath = (currentText.match(/\$\$/g) || []).length;

      currentText = normalizePresentation(currentText);

      const postNormFences = (currentText.match(/^(?:`{3,}|~{3,})/gm) || []).length;
      const postNormMath = (currentText.match(/\$\$/g) || []).length;

      if (preNormFences % 2 !== 0 && postNormFences % 2 === 0) {
        diagnostics.fencesRepaired = true;
      }
      if (preNormMath % 2 !== 0 && postNormMath % 2 === 0) {
        diagnostics.mathRepaired = true;
      }

      // Stage 6: Final Safety Boundary
      const approvedText = currentText.trim() || ALPHA_GATE_FALLBACK_TEXT;
      const hasRepairs = Boolean(
        diagnostics.thinkingStripped ||
          diagnostics.providerLeakStripped ||
          diagnostics.actionRepaired ||
          diagnostics.sourcesFiltered ||
          diagnostics.fencesRepaired ||
          diagnostics.mathRepaired,
      );

      const status: "approved" | "repaired" | "fallback" =
        approvedText === ALPHA_GATE_FALLBACK_TEXT
          ? "fallback"
          : hasRepairs
            ? "repaired"
            : "approved";

      return {
        approvedText,
        status,
        diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
        actionStatus: actionResult.actionStatus,
      };
    } catch {
      // Fail-Safe Fallback: never throw, never leak internal state or diagnostics
      try {
        const fallbackText = stripLeakedThinking(raw || "").trim();
        return {
          approvedText: fallbackText || ALPHA_GATE_FALLBACK_TEXT,
          status: "fallback",
          actionStatus: "none",
        };
      } catch {
        return {
          approvedText: ALPHA_GATE_FALLBACK_TEXT,
          status: "fallback",
          actionStatus: "none",
        };
      }
    }
  }
}

/**
 * Global singleton instance of AlphaGate.
 */
export const alphaGate = new AlphaGate();
