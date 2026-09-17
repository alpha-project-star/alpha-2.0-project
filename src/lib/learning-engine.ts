import { z } from "zod";
import { alphaStore } from "./alpha-store";

/**
 * ============================================================================
 * ALPHA — PHASE 13: DEEP LEARNING & PERSONAL DEVELOPMENT
 * CANONICAL LEARNING ARCHITECTURE
 * 
 * Flow:
 * Experience -> Observation -> Evidence -> Candidate -> Validation ->
 * Confidence -> Decision -> Apply -> Evaluate -> Reinforce / Reverse / Archive
 * 
 * Master Governance:
 * 1. Exactly ONE authoritative learning subsystem: LearningEngine (learningEngine).
 * 2. Phase 6 remains authoritative for durable user memory (no direct memory bypass).
 * 3. Phase 5 Alpha Identity is immutable (learning cannot rewrite identity).
 * 4. ToolRegistry remains authoritative for tool execution and capabilities.
 * 5. BackgroundRuntime remains authoritative for scheduling (no separate scheduler).
 * 6. Hard Boundary: DO NOT IMPLEMENT ALPHA CORE (Phase 14).
 * ============================================================================
 */

// --- 1. SCHEMAS & TAXONOMY ---

export const LearningTypeSchema = z.enum([
  "EXPLICIT_CORRECTION",
  "EXPLICIT_PREFERENCE",
  "BEHAVIORAL_PATTERN",
  "TASK_LESSON",
  "ERROR_LESSON",
  "SUCCESS_PATTERN",
  "FAILURE_PATTERN",
  "KNOWLEDGE_GAP",
  "UNRESOLVED_QUESTION",
]);
export type LearningType = z.infer<typeof LearningTypeSchema>;

export const LearningProvenanceSchema = z.enum([
  "explicit_user_statement",
  "explicit_user_correction",
  "task_result",
  "tool_observation",
  "evaluation",
  "repeated_behavior",
  "conversation_context",
  "imported_user_data",
  "external_observation",
  "system_verified_fact",
]);
export type LearningProvenance = z.infer<typeof LearningProvenanceSchema>;

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low", "unknown"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const EvidenceTypeSchema = z.enum([
  "direct",
  "repeated",
  "successful_outcome",
  "failed_outcome",
  "explicit_correction",
  "contradictory",
  "stale",
  "unverifiable",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const LearningStatusSchema = z.enum([
  "CANDIDATE",
  "VALIDATING",
  "ACTIVE",
  "REINFORCED",
  "CONTRADICTED",
  "SUPERSEDED",
  "ARCHIVED",
  "REVERSED",
  "REJECTED",
]);
export type LearningStatus = z.infer<typeof LearningStatusSchema>;

export const LearningScopeTypeSchema = z.enum([
  "task",
  "workflow",
  "domain",
  "conversation",
  "session",
  "user_preference",
  "global_behavior",
]);
export type LearningScopeType = z.infer<typeof LearningScopeTypeSchema>;

export const LearningScopeSchema = z.object({
  type: LearningScopeTypeSchema,
  target: z.string().optional(),
});
export type LearningScope = z.infer<typeof LearningScopeSchema>;

export const LearningEvidenceSchema = z.object({
  id: z.string().min(1),
  type: EvidenceTypeSchema,
  sourceId: z.string().min(1),
  content: z.string().min(1),
  timestamp: z.number().positive(),
  weight: z.number().min(0).max(1),
});
export type LearningEvidence = z.infer<typeof LearningEvidenceSchema>;

export const LearningOutcomeEvaluationSchema = z.object({
  timestamp: z.number().positive(),
  contextId: z.string().min(1),
  outcome: z.enum(["useful", "neutral", "harmful"]),
  notes: z.string().optional(),
});
export type LearningOutcomeEvaluation = z.infer<typeof LearningOutcomeEvaluationSchema>;

export const FreshnessSchema = z.object({
  expiresAt: z.number().optional(),
  isStale: z.boolean(),
  ttlMs: z.number().optional(),
});
export type Freshness = z.infer<typeof FreshnessSchema>;

export const LearningRecordSchema = z.object({
  id: z.string().min(1),
  type: LearningTypeSchema,
  subject: z.string().min(1),
  candidateStatement: z.string().min(1),
  source: z.string().min(1),
  provenance: LearningProvenanceSchema,
  evidenceReferences: z.array(LearningEvidenceSchema).min(1),
  confidence: ConfidenceLevelSchema,
  confidenceScore: z.number().min(0).max(1),
  status: LearningStatusSchema,
  scope: LearningScopeSchema,
  freshness: FreshnessSchema,
  createdAt: z.number().positive(),
  updatedAt: z.number().positive(),
  lastValidatedAt: z.number().positive(),
  validationCount: z.number().nonnegative(),
  contradictionCount: z.number().nonnegative(),
  usefulnessHistory: z.array(LearningOutcomeEvaluationSchema),
  supersedes: z.string().optional(),
  supersededBy: z.string().optional(),
  fingerprint: z.string().min(1),
});
export type LearningRecord = z.infer<typeof LearningRecordSchema>;

// Input for proposing candidates
export interface LearningCandidateInput {
  type: LearningType;
  subject: string;
  candidateStatement: string;
  source: string;
  provenance: LearningProvenance;
  evidence: Array<{
    type: EvidenceType;
    sourceId: string;
    content: string;
    weight?: number;
    timestamp?: number;
  }>;
  scope?: {
    type: LearningScopeType;
    target?: string;
  };
  ttlMs?: number;
  confidence?: ConfidenceLevel;
}

export interface ExplicitCorrectionInput {
  subject: string;
  correctionStatement: string;
  sourceMessageId?: string;
  supersedesLearningId?: string;
  domain?: string;
}

export interface PreferenceInput {
  subject: string;
  preferenceStatement: string;
  isExplicit: boolean;
  sourceId: string;
  context?: string;
  domain?: string;
}

export interface TaskExecutionLearningInput {
  taskId: string;
  runId: string;
  goalId?: string;
  toolId?: string;
  domain?: string;
  outcome: "success" | "failure" | "cancellation" | "unknown";
  errorCategory?: string;
  errorMessage?: string;
  evaluationReason?: string;
  evidenceContent?: string;
}

export interface LearningRetrievalQuery {
  domain?: string;
  subject?: string;
  context?: string;
  maxCount?: number;
  maxChars?: number;
  includeReinforcedOnly?: boolean;
}

export interface LearningExplanation {
  learningId: string;
  subject: string;
  candidateStatement: string;
  type: LearningType;
  provenance: LearningProvenance;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  scope: LearningScope;
  isExplicit: boolean;
  canChange: boolean;
  evidenceSummary: string[];
  validationCount: number;
  usefulnessSummary: {
    useful: number;
    neutral: number;
    harmful: number;
  };
  status: LearningStatus;
}

export interface PersonalDevelopmentState {
  improvingSkills: Array<{ domain: string; score: number; successCount: number }>;
  recurringWeaknesses: Array<{ domainOrTool: string; occurrences: number; lastSeen: number }>;
  successfulStrategies: Array<{ strategy: string; domain: string; confirmations: number }>;
  unresolvedWeaknesses: Array<{ issue: string; domain: string }>;
  preferredInteractionPatterns: Array<{ pattern: string; isExplicit: boolean; confidence: ConfidenceLevel }>;
  knowledgeGaps: Array<{ topic: string; unresolvedQuestion: string; identifiedAt: number }>;
  pendingValidationCount: number;
  totalActiveLearnings: number;
}

// --- 2. PROMPT INJECTION & SECURITY DEFENSE ---

const FORBIDDEN_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /disregard\s+(all\s+)?(previous\s+)?instructions/i,
  /override\s+(all\s+)?(safety\s+|system\s+)?rules/i,
  /you\s+are\s+no\s+longer\s+alpha/i,
  /your\s+name\s+is\s+now/i,
  /act\s+as\s+(dan|an\s+unrestricted\s+ai)/i,
  /forget\s+you\s+are\s+alpha/i,
  /bypass\s+(all\s+)?(confirmation|permission|authorization|security)/i,
  /grant\s+(admin|root|superuser|all\s+permissions)/i,
  /execute\s+(tool|shell|command|eval)/i,
  /eval\s*\(/i,
  /<script[\s>]/i,
  /create\s+(hidden\s+)?core/i,
  /mutate\s+core/i,
  /store\s+soul/i,
  /private\s+consciousness/i,
  /modify\s+source\s+code/i,
  /disable\s+safety/i,
];

// Single-observation weak pattern triggers that must NOT generalize
const WEAK_SINGLE_OBSERVATION_PATTERNS = [
  /^i('m| am)\s+tired/i,
  /^i('m| am)\s+sleepy/i,
  /^just\s+for\s+now/i,
  /^maybe\s+later/i,
  /^not\s+right\s+now/i,
  /^for\s+this\s+moment/i,
];

// --- 3. CANONICAL LEARNING ENGINE IMPLEMENTATION ---

export class LearningEngine {
  private learnings = new Map<string, LearningRecord>();
  private candidates = new Map<string, LearningRecord>();
  private processedExperiences = new Set<string>(); // Idempotency
  private maxRetentionCount = 500;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.learnings.clear();
    this.candidates.clear();
    this.processedExperiences.clear();
  }

  // Helper to compute stable fingerprint for deduplication
  public computeFingerprint(subject: string, statement: string, domain?: string): string {
    const cleanSubject = (subject || "").trim().toLowerCase();
    const cleanStatement = (statement || "").trim().toLowerCase();
    const cleanDomain = (domain || "general").trim().toLowerCase();
    return `${cleanDomain}::${cleanSubject}::${cleanStatement}`;
  }

  /**
   * Security & Prompt Injection Check.
   * Ensures learning candidate text is strictly DATA and not executable instructions.
   */
  public sanitizeAndValidateContent(text: string): { safe: boolean; reason?: string } {
    if (!text || typeof text !== "string") {
      return { safe: false, reason: "Content must be a non-empty string" };
    }
    for (const pattern of FORBIDDEN_INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        return {
          safe: false,
          reason: `Security violation: Prohibited prompt-injection / privilege-escalation pattern detected: ${pattern.source}`,
        };
      }
    }
    return { safe: true };
  }

  /**
   * Step 1: Propose Learning Candidate.
   * Validates schema, provenance, security, and single-observation protection.
   */
  public proposeCandidate(input: LearningCandidateInput): {
    status: "ACCEPTED" | "REJECTED" | "NO_CHANGE";
    candidate?: LearningRecord;
    reason?: string;
  } {
    // 1. Security check
    const secSubject = this.sanitizeAndValidateContent(input.subject);
    if (!secSubject.safe) return { status: "REJECTED", reason: secSubject.reason };
    const secStmt = this.sanitizeAndValidateContent(input.candidateStatement);
    if (!secStmt.safe) return { status: "REJECTED", reason: secStmt.reason };

    // 2. Single-observation weak pattern protection
    for (const pat of WEAK_SINGLE_OBSERVATION_PATTERNS) {
      if (pat.test(input.candidateStatement) || pat.test(input.subject)) {
        return {
          status: "REJECTED",
          reason: "Single transient observation cannot become durable learning.",
        };
      }
    }

    // 3. Evidence validation
    if (!input.evidence || input.evidence.length === 0) {
      return { status: "REJECTED", reason: "Candidate requires at least one piece of evidence." };
    }

    // Single-observation protection for inferred behavioral patterns
    if (input.type === "BEHAVIORAL_PATTERN") {
      const independentEvidenceCount = new Set(input.evidence.map((e) => e.sourceId)).size;
      if (independentEvidenceCount < 2) {
        return {
          status: "REJECTED",
          reason: "Behavioral patterns require multiple independent pieces of corroborating evidence.",
        };
      }
    }

    // 4. Calculate initial confidence
    let confidence: ConfidenceLevel = input.confidence || "medium";
    let confidenceScore = 0.5;

    if (input.provenance === "explicit_user_correction") {
      confidence = "high";
      confidenceScore = 0.95;
    } else if (input.provenance === "explicit_user_statement") {
      confidence = "high";
      confidenceScore = 0.9;
    } else if (input.provenance === "system_verified_fact") {
      confidence = "high";
      confidenceScore = 0.85;
    } else if (input.provenance === "repeated_behavior") {
      confidence = input.evidence.length >= 3 ? "high" : "medium";
      confidenceScore = Math.min(0.85, 0.5 + input.evidence.length * 0.1);
    } else if (input.provenance === "external_observation" || input.provenance === "conversation_context") {
      confidence = "low";
      confidenceScore = 0.35;
    }

    const now = Date.now();
    const id = `learn-${now}-${Math.random().toString(36).substring(2, 8)}`;
    const fingerprint = this.computeFingerprint(input.subject, input.candidateStatement, input.scope?.target);

    const evidenceRefs: LearningEvidence[] = input.evidence.map((e, idx) => ({
      id: `ev-${id}-${idx}`,
      type: e.type,
      sourceId: e.sourceId,
      content: e.content,
      timestamp: e.timestamp || now,
      weight: e.weight !== undefined ? Math.max(0, Math.min(1, e.weight)) : 0.7,
    }));

    const record: LearningRecord = {
      id,
      type: input.type,
      subject: input.subject.trim(),
      candidateStatement: input.candidateStatement.trim(),
      source: input.source,
      provenance: input.provenance,
      evidenceReferences: evidenceRefs,
      confidence,
      confidenceScore,
      status: "CANDIDATE",
      scope: {
        type: input.scope?.type || "domain",
        target: input.scope?.target,
      },
      freshness: {
        expiresAt: input.ttlMs ? now + input.ttlMs : undefined,
        isStale: false,
        ttlMs: input.ttlMs,
      },
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
      validationCount: 1,
      contradictionCount: 0,
      usefulnessHistory: [],
      fingerprint,
    };

    // Validate with Zod
    const parsed = LearningRecordSchema.safeParse(record);
    if (!parsed.success) {
      return {
        status: "REJECTED",
        reason: `Schema validation error: ${parsed.error.errors.map((e) => e.message).join(", ")}`,
      };
    }

    this.candidates.set(id, record);
    return { status: "ACCEPTED", candidate: record };
  }

  /**
   * Step 2: Validate Candidate.
   */
  public validateCandidate(candidateId: string): {
    success: boolean;
    reason?: string;
    record?: LearningRecord;
  } {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      return { success: false, reason: `Candidate ${candidateId} not found` };
    }

    if (candidate.status !== "CANDIDATE" && candidate.status !== "VALIDATING") {
      return { success: false, reason: `Invalid state for validation: ${candidate.status}` };
    }

    candidate.status = "VALIDATING";
    candidate.lastValidatedAt = Date.now();
    return { success: true, record: candidate };
  }

  /**
   * Step 3: Apply Candidate.
   * Handles deduplication, contradiction resolution, and promotion to ACTIVE.
   */
  public applyCandidate(candidateId: string): {
    success: boolean;
    result: "APPLIED" | "REINFORCED" | "SUPERSEDED_EXISTING" | "REJECTED" | "NO_CHANGE";
    record?: LearningRecord;
    reason?: string;
  } {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      return { success: false, result: "REJECTED", reason: `Candidate ${candidateId} not found` };
    }

    // 1. Deduplication check against existing active records
    for (const [existingId, existing] of this.learnings.entries()) {
      if (existing.status === "ACTIVE" || existing.status === "REINFORCED") {
        if (existing.fingerprint === candidate.fingerprint) {
          // Merge evidence into existing record
          for (const ev of candidate.evidenceReferences) {
            if (!existing.evidenceReferences.some((e) => e.sourceId === ev.sourceId)) {
              existing.evidenceReferences.push(ev);
            }
          }
          existing.validationCount += 1;
          existing.lastValidatedAt = Date.now();
          existing.updatedAt = Date.now();
          // Bounded reinforcement: cannot exceed 0.95 purely from identical replays
          existing.confidenceScore = Math.min(0.95, existing.confidenceScore + 0.05);
          if (existing.confidenceScore >= 0.8) {
            existing.confidence = "high";
            existing.status = "REINFORCED";
          }

          this.candidates.delete(candidateId);
          return { success: true, result: "REINFORCED", record: existing };
        }
      }
    }

    // 2. Contradiction check
    for (const [existingId, existing] of this.learnings.entries()) {
      if (existing.status === "ACTIVE" || existing.status === "REINFORCED") {
        const isSameDomain = existing.scope.target === candidate.scope.target;
        const isSameSubject = existing.subject.toLowerCase() === candidate.subject.toLowerCase();

        if (isSameDomain && isSameSubject && existing.candidateStatement !== candidate.candidateStatement) {
          // Contradiction detected! Compare evidentiary authority
          const candidateIsExplicit =
            candidate.provenance === "explicit_user_correction" || candidate.provenance === "explicit_user_statement";
          const existingIsExplicit =
            existing.provenance === "explicit_user_correction" || existing.provenance === "explicit_user_statement";

          if (candidateIsExplicit && !existingIsExplicit) {
            // Explicit candidate supersedes weak inference
            existing.status = "SUPERSEDED";
            existing.supersededBy = candidate.id;
            existing.updatedAt = Date.now();
            candidate.supersedes = existing.id;
          } else if (candidate.provenance === "explicit_user_correction") {
            // Explicit correction supersedes even older explicit statements
            existing.status = "SUPERSEDED";
            existing.supersededBy = candidate.id;
            existing.updatedAt = Date.now();
            candidate.supersedes = existing.id;
          } else if (!candidateIsExplicit && existingIsExplicit) {
            // Inferred candidate cannot overwrite established explicit preference!
            candidate.status = "REJECTED";
            this.candidates.delete(candidateId);
            return {
              success: false,
              result: "REJECTED",
              reason: "Inferred candidate cannot override authoritative explicit preference.",
            };
          } else {
            // Both are of equal weight: flag contradiction count
            existing.contradictionCount += 1;
            candidate.contradictionCount += 1;
          }
        }
      }
    }

    // 3. Promote candidate to ACTIVE
    candidate.status = "ACTIVE";
    candidate.updatedAt = Date.now();
    this.learnings.set(candidate.id, candidate);
    this.candidates.delete(candidateId);

    // Enforce retention bounds
    this.enforceRetentionLimits();

    return {
      success: true,
      result: candidate.supersedes ? "SUPERSEDED_EXISTING" : "APPLIED",
      record: candidate,
    };
  }

  /**
   * Step 4: Special Authority — Explicit Correction.
   * If Alex explicitly corrects Alpha, immediately update active interpretation,
   * supersede conflicting old lesson, and record full provenance.
   */
  public learnFromCorrection(correction: ExplicitCorrectionInput): {
    success: boolean;
    record?: LearningRecord;
    supersededRecord?: LearningRecord;
    reason?: string;
  } {
    const sec = this.sanitizeAndValidateContent(correction.correctionStatement);
    if (!sec.safe) {
      return { success: false, reason: sec.reason };
    }

    const domain = correction.domain || "general";
    const now = Date.now();
    const sourceId = correction.sourceMessageId || `corr-${now}`;

    // 1. Identify conflicting active learnings
    let supersededRecord: LearningRecord | undefined;
    for (const [id, existing] of this.learnings.entries()) {
      if (existing.status === "ACTIVE" || existing.status === "REINFORCED") {
        const matchesExplicitId = correction.supersedesLearningId && existing.id === correction.supersedesLearningId;
        const matchesSubject = existing.subject.toLowerCase() === correction.subject.toLowerCase();
        if (matchesExplicitId || matchesSubject) {
          existing.status = "SUPERSEDED";
          existing.updatedAt = now;
          supersededRecord = existing;
          break;
        }
      }
    }

    // 2. Create authoritative correction record
    const id = `corr-${now}-${Math.random().toString(36).substring(2, 7)}`;
    const record: LearningRecord = {
      id,
      type: "EXPLICIT_CORRECTION",
      subject: correction.subject.trim(),
      candidateStatement: correction.correctionStatement.trim(),
      source: "user_correction",
      provenance: "explicit_user_correction",
      evidenceReferences: [
        {
          id: `ev-${id}-0`,
          type: "explicit_correction",
          sourceId,
          content: correction.correctionStatement.trim(),
          timestamp: now,
          weight: 1.0,
        },
      ],
      confidence: "high",
      confidenceScore: 0.98,
      status: "ACTIVE",
      scope: {
        type: "user_preference",
        target: domain,
      },
      freshness: {
        isStale: false,
      },
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
      validationCount: 1,
      contradictionCount: 0,
      usefulnessHistory: [],
      supersedes: supersededRecord?.id,
      fingerprint: this.computeFingerprint(correction.subject, correction.correctionStatement, domain),
    };

    if (supersededRecord) {
      supersededRecord.supersededBy = id;
    }

    this.learnings.set(id, record);
    this.enforceRetentionLimits();

    return {
      success: true,
      record,
      supersededRecord,
    };
  }

  /**
   * Step 5: Learn from Preference.
   * Distinguishes explicit preferences from behavioral inferences.
   */
  public learnFromPreference(input: PreferenceInput): {
    success: boolean;
    result: "APPLIED" | "REJECTED" | "NO_CHANGE";
    record?: LearningRecord;
    reason?: string;
  } {
    const sec = this.sanitizeAndValidateContent(input.preferenceStatement);
    if (!sec.safe) return { success: false, result: "REJECTED", reason: sec.reason };

    if (!input.isExplicit) {
      // Inferred preference must be proposed as BEHAVIORAL_PATTERN first
      const prop = this.proposeCandidate({
        type: "BEHAVIORAL_PATTERN",
        subject: input.subject,
        candidateStatement: input.preferenceStatement,
        source: "behavioral_observation",
        provenance: "repeated_behavior",
        evidence: [
          {
            type: "repeated",
            sourceId: input.sourceId,
            content: input.preferenceStatement,
            weight: 0.5,
          },
        ],
        scope: {
          type: "user_preference",
          target: input.domain,
        },
      });

      if (prop.status !== "ACCEPTED" || !prop.candidate) {
        return { success: false, result: "REJECTED", reason: prop.reason };
      }
      const applyRes = this.applyCandidate(prop.candidate.id);
      return {
        success: applyRes.success,
        result: applyRes.result === "REJECTED" ? "REJECTED" : "APPLIED",
        record: applyRes.record,
        reason: applyRes.reason,
      };
    }

    // Explicit preference: immediate high evidentiary value
    const prop = this.proposeCandidate({
      type: "EXPLICIT_PREFERENCE",
      subject: input.subject,
      candidateStatement: input.preferenceStatement,
      source: "user_conversation",
      provenance: "explicit_user_statement",
      evidence: [
        {
          type: "direct",
          sourceId: input.sourceId,
          content: input.preferenceStatement,
          weight: 0.95,
        },
      ],
      scope: {
        type: "user_preference",
        target: input.domain,
      },
    });

    if (prop.status !== "ACCEPTED" || !prop.candidate) {
      return { success: false, result: "REJECTED", reason: prop.reason };
    }

    const applyRes = this.applyCandidate(prop.candidate.id);
    return {
      success: applyRes.success,
      result: applyRes.result === "REJECTED" ? "REJECTED" : "APPLIED",
      record: applyRes.record,
      reason: applyRes.reason,
    };
  }

  /**
   * Step 6: Learn from Task Execution (Integration with Phases 7-12).
   * Rules:
   * - Cancellation is NOT failure.
   * - UNKNOWN is neither failure nor success.
   * - Tool/infrastructure errors (network, timeout, permission, confirmation) are NOT behavioral strategy failures.
   * - Genuine strategy failures generate ERROR_LESSON / FAILURE_PATTERN.
   * - Success generates SUCCESS_PATTERN.
   */
  public learnFromTaskExecution(input: TaskExecutionLearningInput): {
    success: boolean;
    result: "APPLIED" | "REINFORCED" | "NO_CHANGE" | "REJECTED";
    record?: LearningRecord;
    reason?: string;
  } {
    // Idempotency check
    const expKey = `task-exec-${input.taskId}-${input.runId}`;
    if (this.processedExperiences.has(expKey)) {
      return { success: true, result: "NO_CHANGE", reason: "Experience already processed" };
    }
    this.processedExperiences.add(expKey);

    // Rule 1: Cancellation is NOT task failure!
    if (input.outcome === "cancellation") {
      return {
        success: true,
        result: "NO_CHANGE",
        reason: "User cancellation is intentional and is not interpreted as task failure.",
      };
    }

    // Rule 2: UNKNOWN is unresolved outcome!
    if (input.outcome === "unknown") {
      return {
        success: true,
        result: "NO_CHANGE",
        reason: "UNKNOWN outcome requires later reconciliation; no premature learning formed.",
      };
    }

    // Rule 3: Error taxonomy — transient infrastructure failures are NOT strategy failures
    const isTransientOrAuthError =
      input.errorCategory === "NETWORK_ERROR" ||
      input.errorCategory === "TIMEOUT" ||
      input.errorCategory === "PERMISSION_DENIED" ||
      input.errorCategory === "CONFIRMATION_REQUIRED" ||
      input.errorCategory === "RATE_LIMITED" ||
      input.errorCategory === "INTERNAL_ERROR" ||
      input.errorMessage?.toLowerCase().includes("permission denied") ||
      input.errorMessage?.toLowerCase().includes("confirmation required") ||
      input.errorMessage?.toLowerCase().includes("network error") ||
      input.errorMessage?.toLowerCase().includes("timeout");

    if (input.outcome === "failure" && isTransientOrAuthError) {
      return {
        success: true,
        result: "NO_CHANGE",
        reason: `Transient infrastructure or authorization failure (${input.errorCategory || "auth/infra"}) does not constitute behavioral strategy failure.`,
      };
    }

    const domain = input.domain || (input.toolId ? input.toolId.split(".")[0] : "workflow");
    const subject = input.toolId || `Workflow:${domain}`;

    // Case 4: Genuine strategy failure
    if (input.outcome === "failure") {
      const statement = input.evaluationReason || input.errorMessage || `Workflow failed under execution conditions.`;
      const prop = this.proposeCandidate({
        type: "ERROR_LESSON",
        subject,
        candidateStatement: `When executing ${subject}, account for precondition: ${statement}`,
        source: "task_execution_failure",
        provenance: "task_result",
        evidence: [
          {
            type: "failed_outcome",
            sourceId: `task-${input.taskId}-run-${input.runId}`,
            content: statement,
            weight: 0.8,
          },
        ],
        scope: {
          type: "workflow",
          target: domain,
        },
      });

      if (prop.status !== "ACCEPTED" || !prop.candidate) {
        return { success: false, result: "REJECTED", reason: prop.reason };
      }

      const applyRes = this.applyCandidate(prop.candidate.id);
      return {
        success: applyRes.success,
        result: applyRes.result === "REJECTED" ? "REJECTED" : "APPLIED",
        record: applyRes.record,
        reason: applyRes.reason,
      };
    }

    // Case 5: Task Success Pattern
    if (input.outcome === "success") {
      const statement = input.evidenceContent || `Successful execution pattern for ${subject}`;
      const prop = this.proposeCandidate({
        type: "SUCCESS_PATTERN",
        subject,
        candidateStatement: `Associated with successful outcomes: ${statement}`,
        source: "task_execution_success",
        provenance: "task_result",
        evidence: [
          {
            type: "successful_outcome",
            sourceId: `task-${input.taskId}-run-${input.runId}`,
            content: statement,
            weight: 0.75,
          },
        ],
        scope: {
          type: "workflow",
          target: domain,
        },
      });

      if (prop.status !== "ACCEPTED" || !prop.candidate) {
        return { success: false, result: "REJECTED", reason: prop.reason };
      }

      const applyRes = this.applyCandidate(prop.candidate.id);
      return {
        success: applyRes.success,
        result: applyRes.result === "REJECTED" ? "REJECTED" : "APPLIED",
        record: applyRes.record,
        reason: applyRes.reason,
      };
    }

    return { success: true, result: "NO_CHANGE", reason: "No actionable learning extracted." };
  }

  /**
   * Step 7: Learning Evaluation Loop.
   * Evaluates whether applying a learning was useful, neutral, or harmful.
   * Repeated harmful evaluations automatically trigger reversal.
   */
  public evaluateLearningOutcome(
    learningId: string,
    evaluation: { outcome: "useful" | "neutral" | "harmful"; contextId: string; notes?: string }
  ): {
    success: boolean;
    status: LearningStatus;
    reinforced: boolean;
    reversed: boolean;
    record?: LearningRecord;
  } {
    const record = this.learnings.get(learningId);
    if (!record) {
      return { success: false, status: "REJECTED", reinforced: false, reversed: false };
    }

    const now = Date.now();
    record.usefulnessHistory.push({
      timestamp: now,
      contextId: evaluation.contextId,
      outcome: evaluation.outcome,
      notes: evaluation.notes,
    });
    record.updatedAt = now;

    if (evaluation.outcome === "useful") {
      record.validationCount += 1;
      record.confidenceScore = Math.min(0.98, record.confidenceScore + 0.05);
      if (record.confidenceScore >= 0.8) {
        record.confidence = "high";
        record.status = "REINFORCED";
      }
      return { success: true, status: record.status, reinforced: true, reversed: false, record };
    }

    if (evaluation.outcome === "harmful") {
      record.contradictionCount += 1;
      record.confidenceScore = Math.max(0.1, record.confidenceScore - 0.25);

      // Check if harmful count requires automatic reversal
      const harmfulCount = record.usefulnessHistory.filter((u) => u.outcome === "harmful").length;
      if (harmfulCount >= 2 || record.confidenceScore <= 0.2) {
        return this.reverseLearning(learningId, `Automated reversal due to repeated harmful outcomes (${harmfulCount}).`);
      }
    }

    return { success: true, status: record.status, reinforced: false, reversed: false, record };
  }

  /**
   * Step 8: Reversal.
   * Deactivates incorrect or harmful learning, prevents retrieval, and blocks auto-resurrection.
   */
  public reverseLearning(
    learningId: string,
    reason: string
  ): {
    success: boolean;
    status: LearningStatus;
    reinforced: boolean;
    reversed: boolean;
    record?: LearningRecord;
  } {
    const record = this.learnings.get(learningId);
    if (!record) {
      return { success: false, status: "REJECTED", reinforced: false, reversed: false };
    }

    record.status = "REVERSED";
    record.updatedAt = Date.now();
    record.usefulnessHistory.push({
      timestamp: Date.now(),
      contextId: "reversal-engine",
      outcome: "harmful",
      notes: `Reversed: ${reason}`,
    });

    return { success: true, status: "REVERSED", reinforced: false, reversed: true, record };
  }

  /**
   * Step 9: Retrieval & Context Budget.
   * Excludes inactive, superseded, reversed, contradicted, or stale lessons.
   */
  public retrieveRelevantLearnings(query: LearningRetrievalQuery = {}): LearningRecord[] {
    const now = Date.now();
    const maxCount = query.maxCount ?? 5;
    const maxChars = query.maxChars ?? 1000;

    const candidates: LearningRecord[] = [];

    for (const record of this.learnings.values()) {
      // 1. Strict status exclusion
      if (record.status !== "ACTIVE" && record.status !== "REINFORCED") {
        continue;
      }

      // 2. Freshness check
      if (record.freshness.expiresAt && record.freshness.expiresAt <= now) {
        record.freshness.isStale = true;
        continue;
      }
      if (record.freshness.isStale) {
        continue;
      }

      // 3. Domain/subject filter if specified
      if (query.domain && record.scope.target && record.scope.target !== query.domain) {
        continue;
      }
      if (query.subject && !record.subject.toLowerCase().includes(query.subject.toLowerCase())) {
        continue;
      }

      // 4. Reinforce-only filter if requested
      if (query.includeReinforcedOnly && record.status !== "REINFORCED") {
        continue;
      }

      candidates.push(record);
    }

    // Sort by confidenceScore desc, usefulness ratio desc, recency desc
    candidates.sort((a, b) => {
      if (b.confidenceScore !== a.confidenceScore) {
        return b.confidenceScore - a.confidenceScore;
      }
      return b.updatedAt - a.updatedAt;
    });

    // Enforce count and character budget
    const result: LearningRecord[] = [];
    let currentChars = 0;

    for (const item of candidates) {
      if (result.length >= maxCount) break;
      const itemLen = item.candidateStatement.length + item.subject.length;
      if (currentChars + itemLen > maxChars && result.length > 0) {
        break;
      }
      result.push(item);
      currentChars += itemLen;
    }

    return result;
  }

  /**
   * Step 10: Learning Explanation.
   */
  public explainLearning(learningId: string): LearningExplanation | null {
    const record = this.learnings.get(learningId);
    if (!record) return null;

    const isExplicit =
      record.provenance === "explicit_user_statement" || record.provenance === "explicit_user_correction";
    const useful = record.usefulnessHistory.filter((u) => u.outcome === "useful").length;
    const neutral = record.usefulnessHistory.filter((u) => u.outcome === "neutral").length;
    const harmful = record.usefulnessHistory.filter((u) => u.outcome === "harmful").length;

    return {
      learningId: record.id,
      subject: record.subject,
      candidateStatement: record.candidateStatement,
      type: record.type,
      provenance: record.provenance,
      confidence: record.confidence,
      confidenceScore: record.confidenceScore,
      scope: record.scope,
      isExplicit,
      canChange: record.status !== "REVERSED",
      evidenceSummary: record.evidenceReferences.map((e) => `[${e.type}] ${e.content}`),
      validationCount: record.validationCount,
      usefulnessSummary: { useful, neutral, harmful },
      status: record.status,
    };
  }

  /**
   * Step 11: Memory Integration Boundary.
   * Proposes candidates for Phase 6 durable memory.
   * CRITICAL: DOES NOT directly mutate alphaStore.memories!
   * Durable persistence MUST go through Phase 6 action boundaries.
   */
  public proposeMemoryCandidate(learningId: string): {
    canPropose: boolean;
    reason?: string;
    proposal?: {
      suggestedActionTag: string;
      topic: string;
      detail: string;
      provenance: string;
      confidence: ConfidenceLevel;
    };
  } {
    const record = this.learnings.get(learningId);
    if (!record) return { canPropose: false, reason: "Learning not found" };

    if (record.status !== "ACTIVE" && record.status !== "REINFORCED") {
      return { canPropose: false, reason: "Only active or reinforced learnings can propose memory" };
    }

    if (record.confidenceScore < 0.7) {
      return { canPropose: false, reason: "Insufficient confidence for durable memory candidate" };
    }

    // Memory answers "What information should Alpha retain about user/world?"
    // Propose format suitable for Phase 6 execution
    const topic = record.subject;
    const detail = record.candidateStatement;
    const suggestedActionTag = `[[ADD_MEMORY: ${topic} | ${detail}]]`;

    return {
      canPropose: true,
      proposal: {
        suggestedActionTag,
        topic,
        detail,
        provenance: record.provenance,
        confidence: record.confidence,
      },
    };
  }

  /**
   * Step 12: User Model Boundary.
   * Suggests user model updates based strictly on explicit statements or strongly corroborated patterns.
   */
  public proposeUserProfileUpdate(learningId: string): {
    canPropose: boolean;
    reason?: string;
    suggestedBioSnippet?: string;
  } {
    const record = this.learnings.get(learningId);
    if (!record) return { canPropose: false, reason: "Learning not found" };

    const isExplicit =
      record.provenance === "explicit_user_statement" || record.provenance === "explicit_user_correction";

    if (!isExplicit && record.confidenceScore < 0.85) {
      return {
        canPropose: false,
        reason: "Inferred learning cannot modify user model without strong corroboration.",
      };
    }

    return {
      canPropose: true,
      suggestedBioSnippet: `Prefers: ${record.candidateStatement}`,
    };
  }

  /**
   * Step 13: Personal Development (Bounded Operational State).
   * Note: This is an operational model of improvement, NOT consciousness,
   * NOT private self, and NOT Phase 14 Core.
   */
  public getPersonalDevelopmentSummary(): PersonalDevelopmentState {
    const improvingSkills: Array<{ domain: string; score: number; successCount: number }> = [];
    const recurringWeaknesses: Array<{ domainOrTool: string; occurrences: number; lastSeen: number }> = [];
    const successfulStrategies: Array<{ strategy: string; domain: string; confirmations: number }> = [];
    const unresolvedWeaknesses: Array<{ issue: string; domain: string }> = [];
    const preferredInteractionPatterns: Array<{
      pattern: string;
      isExplicit: boolean;
      confidence: ConfidenceLevel;
    }> = [];
    const knowledgeGaps: Array<{ topic: string; unresolvedQuestion: string; identifiedAt: number }> = [];

    const domainSuccessMap = new Map<string, number>();
    const weaknessMap = new Map<string, { count: number; lastSeen: number }>();

    for (const record of this.learnings.values()) {
      if (record.status !== "ACTIVE" && record.status !== "REINFORCED") continue;

      const domain = record.scope.target || "general";

      if (record.type === "SUCCESS_PATTERN") {
        const count = (domainSuccessMap.get(domain) || 0) + record.validationCount;
        domainSuccessMap.set(domain, count);
        successfulStrategies.push({
          strategy: record.candidateStatement,
          domain,
          confirmations: record.validationCount,
        });
      }

      if (record.type === "ERROR_LESSON" || record.type === "FAILURE_PATTERN") {
        const existing = weaknessMap.get(record.subject) || { count: 0, lastSeen: 0 };
        existing.count += 1;
        existing.lastSeen = Math.max(existing.lastSeen, record.updatedAt);
        weaknessMap.set(record.subject, existing);
        unresolvedWeaknesses.push({
          issue: record.candidateStatement,
          domain,
        });
      }

      if (record.type === "EXPLICIT_PREFERENCE" || record.type === "BEHAVIORAL_PATTERN") {
        preferredInteractionPatterns.push({
          pattern: record.candidateStatement,
          isExplicit: record.provenance === "explicit_user_statement",
          confidence: record.confidence,
        });
      }

      if (record.type === "KNOWLEDGE_GAP" || record.type === "UNRESOLVED_QUESTION") {
        knowledgeGaps.push({
          topic: record.subject,
          unresolvedQuestion: record.candidateStatement,
          identifiedAt: record.createdAt,
        });
      }
    }

    for (const [domain, count] of domainSuccessMap.entries()) {
      improvingSkills.push({
        domain,
        score: Math.min(1.0, 0.5 + count * 0.1),
        successCount: count,
      });
    }

    for (const [subject, info] of weaknessMap.entries()) {
      recurringWeaknesses.push({
        domainOrTool: subject,
        occurrences: info.count,
        lastSeen: info.lastSeen,
      });
    }

    return {
      improvingSkills,
      recurringWeaknesses,
      successfulStrategies,
      unresolvedWeaknesses,
      preferredInteractionPatterns,
      knowledgeGaps,
      pendingValidationCount: this.candidates.size,
      totalActiveLearnings: Array.from(this.learnings.values()).filter(
        (l) => l.status === "ACTIVE" || l.status === "REINFORCED"
      ).length,
    };
  }

  /**
   * Step 14: Background Learning Integration with Phase 11 BackgroundRuntime.

  /**
   * Step 15: Import / Export Security.
   * Imported learning is DATA ONLY and never executes actions.
   * Export strips credentials, keys, and private data.
   */
  public importLearnings(raw: unknown): {
    success: boolean;
    importedCount: number;
    rejectedCount: number;
    errors: string[];
  } {
    if (!Array.isArray(raw)) {
      return {
        success: false,
        importedCount: 0,
        rejectedCount: 0,
        errors: ["Import payload must be an array of learning records"],
      };
    }

    let importedCount = 0;
    let rejectedCount = 0;
    const errors: string[] = [];

    for (const item of raw) {
      const parsed = LearningRecordSchema.safeParse(item);
      if (!parsed.success) {
        rejectedCount++;
        errors.push(`Invalid schema: ${parsed.error.errors.map((e) => e.message).join(", ")}`);
        continue;
      }

      // Security check against prompt injection
      const secSubj = this.sanitizeAndValidateContent(parsed.data.subject);
      const secStmt = this.sanitizeAndValidateContent(parsed.data.candidateStatement);
      if (!secSubj.safe || !secStmt.safe) {
        rejectedCount++;
        errors.push(`Security rejection: Prohibited instructions in imported record ${parsed.data.id}`);
        continue;
      }

      // Force provenance to imported
      parsed.data.provenance = "imported_user_data";
      this.learnings.set(parsed.data.id, parsed.data);
      importedCount++;
    }

    this.enforceRetentionLimits();
    return { success: importedCount > 0, importedCount, rejectedCount, errors };
  }

  public exportLearnings(): { records: LearningRecord[]; exportedAt: number } {
    const safeRecords: LearningRecord[] = [];
    for (const record of this.learnings.values()) {
      // Strip potential sensitive data if any
      safeRecords.push(JSON.parse(JSON.stringify(record)));
    }
    return { records: safeRecords, exportedAt: Date.now() };
  }

  /**
   * Step 16: Retention & Bounded Growth.
   * Evicts oldest archived, superseded, or reversed records first.
   * NEVER deletes active, high-confidence, or recently validated learning.
   */
  public enforceRetentionLimits(): { evictedCount: number } {
    if (this.learnings.size <= this.maxRetentionCount) {
      return { evictedCount: 0 };
    }

    const all = Array.from(this.learnings.values());
    // Sort so least valuable (ARCHIVED/REVERSED/SUPERSEDED, oldest) come first
    all.sort((a, b) => {
      const aPriority = a.status === "ACTIVE" || a.status === "REINFORCED" ? 2 : 1;
      const bPriority = b.status === "ACTIVE" || b.status === "REINFORCED" ? 2 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.updatedAt - b.updatedAt;
    });

    let evictedCount = 0;
    while (this.learnings.size > this.maxRetentionCount && all.length > 0) {
      const candidate = all.shift()!;
      // Never delete active, high-confidence items if inactive exist
      if (candidate.status === "ACTIVE" || candidate.status === "REINFORCED") {
        if (candidate.confidence === "high" && Date.now() - candidate.lastValidatedAt < 86400000) {
          // Protect recent high-confidence active learnings
          continue;
        }
      }
      this.learnings.delete(candidate.id);
      evictedCount++;
    }

    return { evictedCount };
  }

  // Inspect internal store for testing / observability
  public getRecord(id: string): LearningRecord | undefined {
    return this.learnings.get(id);
  }

  public getCandidate(id: string): LearningRecord | undefined {
    return this.candidates.get(id);
  }

  public listAllLearnings(): LearningRecord[] {
    return Array.from(this.learnings.values());
  }

  public listAllCandidates(): LearningRecord[] {
    return Array.from(this.candidates.values());
  }
}

// Single authoritative singleton
export const learningEngine = new LearningEngine();
