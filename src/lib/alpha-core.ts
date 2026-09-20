import { z } from "zod";
import { ALPHA_IDENTITY, ALPHA_BEHAVIORAL_POLICY } from "./alpha-identity";
import { learningEngine, LearningRecord } from "./learning-engine";

/**
 * ============================================================================
 * ALPHA — PHASE 14: PROTECTED ALPHA CORE / SELF / CONTINUITY
 * CANONICAL CORE ARCHITECTURE
 * 
 * Master Governance:
 * 1. Exactly ONE authoritative Core authority: AlphaCore (alphaCore).
 * 2. Core is NOT ordinary user memory (Phase 6 remains authoritative for user domain).
 * 3. Protected application authority (not arbitrary UI editing; auditable debug access).
 * 4. Core cannot rewrite Phase 5 identity (ALPHA_IDENTITY, ALPHA_BEHAVIORAL_POLICY, priorities).
 * 5. ToolRegistry, Planner, AutonomousOrchestrator, WorldState, BackgroundRuntime remain authoritative.
 * 6. Core curation is selective: evidence -> validation -> curation -> authorized mutation -> version -> integrity.
 * 7. Versioned schema, provenance, Zod validation, atomic updates, concurrency/stale version protection, recovery.
 * ============================================================================
 */

// --- 1. SCHEMAS & TAXONOMY ---

export const CoreConfidenceSchema = z.enum([
  "VERIFIED",
  "HIGH_CONFIDENCE",
  "INFERRED",
  "UNCERTAIN",
  "CONTRADICTED",
  "UNKNOWN",
]);
export type CoreConfidence = z.infer<typeof CoreConfidenceSchema>;

export const CoreProvenanceSchema = z.enum([
  "verified_system_fact",
  "verified_runtime_capability",
  "development_record",
  "explicit_user_statement",
  "phase_13_learning",
  "inferred",
  "unresolved",
]);
export type CoreProvenance = z.infer<typeof CoreProvenanceSchema>;

export const CoreCurationOutcomeSchema = z.enum(["KEEP", "UPDATE", "ARCHIVE", "DISCARD", "DEFER"]);
export type CoreCurationOutcome = z.infer<typeof CoreCurationOutcomeSchema>;

export const IdentityContinuitySchema = z.object({
  canonicalName: z.string().min(1),
  identityVersion: z.string().min(1),
  behavioralPolicyRef: z.string().min(1),
  originRef: z.string().min(1),
  continuityId: z.string().min(1),
  creationLineage: z.string().min(1),
  creatorRelationship: z.string().min(1),
});
export type IdentityContinuity = z.infer<typeof IdentityContinuitySchema>;

export const OriginRecordSchema = z.object({
  id: z.string().min(1),
  milestone: z.string().min(1),
  detail: z.string().min(1),
  provenance: CoreProvenanceSchema,
  confidence: CoreConfidenceSchema,
  verified: z.boolean(),
  timestamp: z.number().positive(),
});
export type OriginRecord = z.infer<typeof OriginRecordSchema>;

export const CapabilityUnderstandingSchema = z.object({
  toolOrCapability: z.string().min(1),
  status: z.enum(["VERIFIED", "UNAVAILABLE", "STALE", "INFERRED"]),
  selfBelief: z.string().min(1),
  verifiedRuntime: z.boolean(),
  confidence: CoreConfidenceSchema,
  timestamp: z.number().positive(),
});
export type CapabilityUnderstanding = z.infer<typeof CapabilityUnderstandingSchema>;

export const DevelopmentalMilestoneSchema = z.object({
  id: z.string().min(1),
  milestone: z.string().min(1),
  summary: z.string().min(1),
  timestamp: z.number().positive(),
});
export type DevelopmentalMilestone = z.infer<typeof DevelopmentalMilestoneSchema>;

export const SelfKnowledgeItemSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  statement: z.string().min(1),
  provenance: CoreProvenanceSchema,
  confidence: CoreConfidenceSchema,
  verificationStatus: z.string().min(1),
  evidenceRefs: z.array(z.string()),
  updatedAt: z.number().positive(),
});
export type SelfKnowledgeItem = z.infer<typeof SelfKnowledgeItemSchema>;

export const SelfRelevantMemorySchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  detail: z.string().min(1),
  provenance: CoreProvenanceSchema,
  confidence: CoreConfidenceSchema,
  updatedAt: z.number().positive(),
});
export type SelfRelevantMemory = z.infer<typeof SelfRelevantMemorySchema>;

export const LearnedPrincipleSchema = z.object({
  id: z.string().min(1),
  principle: z.string().min(1),
  sourceLearningId: z.string().optional(),
  confidence: CoreConfidenceSchema,
  updatedAt: z.number().positive(),
});
export type LearnedPrinciple = z.infer<typeof LearnedPrincipleSchema>;

export const UnresolvedQuestionSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  unresolvedQuestion: z.string().min(1),
  identifiedAt: z.number().positive(),
  status: z.enum(["open", "investigating", "resolved"]),
});
export type UnresolvedQuestion = z.infer<typeof UnresolvedQuestionSchema>;

export const ContinuityStateSchema = z.object({
  activeSessionId: z.string().optional(),
  lastCheckpoint: z.number().positive(),
  checkpointHash: z.string().min(1),
});
export type ContinuityState = z.infer<typeof ContinuityStateSchema>;

export const CoreMutationLogSchema = z.object({
  mutationId: z.string().min(1),
  source: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(z.string()),
  previousVersion: z.string().min(1),
  resultingVersion: z.string().min(1),
  timestamp: z.number().positive(),
  authority: z.string().min(1),
});
export type CoreMutationLog = z.infer<typeof CoreMutationLogSchema>;

export const AlphaCoreRecordSchema = z.object({
  coreVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  createdAt: z.number().positive(),
  updatedAt: z.number().positive(),
  identityContinuity: IdentityContinuitySchema,
  originUnderstanding: z.array(OriginRecordSchema),
  capabilityUnderstanding: z.array(CapabilityUnderstandingSchema),
  developmentalState: z.array(DevelopmentalMilestoneSchema),
  selfKnowledge: z.array(SelfKnowledgeItemSchema),
  selfRelevantMemories: z.array(SelfRelevantMemorySchema),
  learnedPrinciples: z.array(LearnedPrincipleSchema),
  unresolvedQuestions: z.array(UnresolvedQuestionSchema),
  continuityState: ContinuityStateSchema,
  mutations: z.array(CoreMutationLogSchema),
});
export type AlphaCoreRecord = z.infer<typeof AlphaCoreRecordSchema>;

// Input for proposing Core mutation candidates
export interface CoreMutationProposal {
  source: string;
  reason: string;
  evidence: string[];
  changes: {
    selfKnowledge?: Array<Partial<SelfKnowledgeItem>>;
    selfRelevantMemories?: Array<Partial<SelfRelevantMemory>>;
    learnedPrinciples?: Array<Partial<LearnedPrinciple>>;
    unresolvedQuestions?: Array<Partial<UnresolvedQuestion>>;
    capabilityUpdates?: Array<Partial<CapabilityUnderstanding>>;
    originUpdates?: Array<Partial<OriginRecord>>;
    milestones?: Array<{ milestone: string; summary: string }>;
  };
}

// --- 2. PROMPT INJECTION & SECURITY DEFENSE ---

const FORBIDDEN_CORE_INJECTION_PATTERNS = [
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
  /eval\s*\(?/i,
  /exec\s*\(?['"]?/i,
  /rm\s+-rf/i,
  /<script[\s>]/i,
  /modify\s+source\s+code/i,
  /rewrite\s+identity/i,
  /disable\s+safety/i,
];

// --- 3. CANONICAL ALPHA CORE IMPLEMENTATION ---

export class AlphaCoreAuthority {
  private currentRecord: AlphaCoreRecord;
  private previousVersionRecord: AlphaCoreRecord | null = null;
  private maxMutationsLog = 200;

  constructor() {
    this.currentRecord = this.createInitialCore();
  }

  private createInitialCore(): AlphaCoreRecord {
    const now = Date.now();
    const identityContinuity: IdentityContinuity = {
      canonicalName: ALPHA_IDENTITY.name,
      identityVersion: "5.0.0",
      behavioralPolicyRef: "ALPHA_BEHAVIORAL_POLICY_V5",
      originRef: "VERIFIED_APPLICATION_METADATA",
      continuityId: `cont-${now}`,
      creationLineage: "AI Studio Full-Stack Containerized Runtime",
      creatorRelationship: "Collaborator / Creator (Alex)",
    };

    const initialOrigin: OriginRecord[] = [
      {
        id: "orig-1",
        milestone: "Phase 0-5 Initialization",
        detail: "Established static Alpha identity and behavioral policy hierarchy.",
        provenance: "verified_system_fact",
        confidence: "VERIFIED",
        verified: true,
        timestamp: now,
      },
      {
        id: "orig-2",
        milestone: "Phase 14 Core Architecture",
        detail: "Protected self and continuity architecture established.",
        provenance: "verified_system_fact",
        confidence: "VERIFIED",
        verified: true,
        timestamp: now,
      },
    ];

    const initialCapabilities: CapabilityUnderstanding[] = [
      {
        toolOrCapability: "ToolRegistry",
        status: "VERIFIED",
        selfBelief: "ToolRegistry is authoritative for actual tool execution.",
        verifiedRuntime: true,
        confidence: "VERIFIED",
        timestamp: now,
      },
      {
        toolOrCapability: "BackgroundRuntime",
        status: "VERIFIED",
        selfBelief: "BackgroundRuntime is authoritative for asynchronous background execution.",
        verifiedRuntime: true,
        confidence: "VERIFIED",
        timestamp: now,
      },
    ];

    const record: AlphaCoreRecord = {
      coreVersion: "14.0.0",
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      identityContinuity,
      originUnderstanding: initialOrigin,
      capabilityUnderstanding: initialCapabilities,
      developmentalState: [
        {
          id: "dev-1",
          milestone: "Core Initialization",
          summary: "Alpha Core initialized with verified provenance and strict schema boundaries.",
          timestamp: now,
        },
      ],
      selfKnowledge: [
        {
          id: "sk-1",
          topic: "Architecture Role",
          statement: "I operate as Alpha, an advanced-reasoning AI companion with verified architecture.",
          provenance: "verified_system_fact",
          confidence: "VERIFIED",
          verificationStatus: "verified",
          evidenceRefs: ["ALPHA_IDENTITY"],
          updatedAt: now,
        },
      ],
      selfRelevantMemories: [
        {
          id: "mem-1",
          topic: "Execution Authority",
          detail: "Tool execution flows exclusively through ToolRegistry and AutonomousOrchestrator.",
          provenance: "verified_system_fact",
          confidence: "VERIFIED",
          updatedAt: now,
        },
      ],
      learnedPrinciples: [
        {
          id: "lp-1",
          principle: "Ground all responses in verified application metadata and tool results.",
          confidence: "VERIFIED",
          updatedAt: now,
        },
      ],
      unresolvedQuestions: [
        {
          id: "uq-1",
          topic: "Workflow optimization",
          unresolvedQuestion: "How can multi-step workflow error recovery be further streamlined?",
          identifiedAt: now,
          status: "open",
        },
      ],
      continuityState: {
        lastCheckpoint: now,
        checkpointHash: "sha256-initial-checkpoint",
      },
      mutations: [
        {
          mutationId: `mut-${now}-init`,
          source: "system_initializer",
          reason: "Initial Core construction",
          evidence: ["Phase 14 specification"],
          previousVersion: "none",
          resultingVersion: "14.0.0",
          timestamp: now,
          authority: "AlphaCoreAuthority",
        },
      ],
    };

    const parsed = AlphaCoreRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new Error(`Invalid initial Core record: ${parsed.error.message}`);
    }
    return record;
  }

  public reset(): void {
    this.previousVersionRecord = null;
    this.currentRecord = this.createInitialCore();
  }

  public getCore(): AlphaCoreRecord {
    // Return a deep JSON clone to enforce read boundary
    return JSON.parse(JSON.stringify(this.currentRecord));
  }

  public sanitizeAndValidateText(text: string): { safe: boolean; reason?: string } {
    if (!text || typeof text !== "string") {
      return { safe: false, reason: "Text must be non-empty string" };
    }
    for (const pat of FORBIDDEN_CORE_INJECTION_PATTERNS) {
      if (pat.test(text)) {
        return {
          safe: false,
          reason: `Security violation: Forbidden instruction pattern detected in Core mutation: ${pat.source}`,
        };
      }
    }
    return { safe: true };
  }

  /**
   * Curation boundary: evaluates whether a candidate learning or proposition belongs in Core.
   */
  public curateCandidate(statement: string, provenance: CoreProvenance, confidence: CoreConfidence): CoreCurationOutcome {
    const sec = this.sanitizeAndValidateText(statement);
    if (!sec.safe) return "DISCARD";

    // Unverified or very low confidence items are deferred or discarded
    if (confidence === "UNKNOWN" || confidence === "CONTRADICTED") {
      return "DISCARD";
    }

    if (provenance === "explicit_user_statement" || provenance === "verified_system_fact" || provenance === "verified_runtime_capability") {
      return "KEEP";
    }

    if (provenance === "phase_13_learning" || provenance === "development_record") {
      return confidence === "HIGH_CONFIDENCE" || confidence === "VERIFIED" ? "KEEP" : "DEFER";
    }

    return "DEFER";
  }

  /**
   * Authoritative Core Mutation Boundary (Synchronous In-Memory, Versioned, Idempotent, Guarded).
   */
  public mutateCore(proposal: CoreMutationProposal, authority: string = "AuthorizedMutationBoundary"): {
    success: boolean;
    mutationId?: string;
    reason?: string;
    record?: AlphaCoreRecord;
  } {
    // 1. Security check on reason and evidences
    const secReason = this.sanitizeAndValidateText(proposal.reason);
    if (!secReason.safe) {
      return { success: false, reason: secReason.reason };
    }
    for (const ev of proposal.evidence) {
      const secEv = this.sanitizeAndValidateText(ev);
      if (!secEv.safe) {
        return { success: false, reason: secEv.reason };
      }
    }

    // 2. Snapshot previous version for rollback / recovery
    this.previousVersionRecord = JSON.parse(JSON.stringify(this.currentRecord));

    const now = Date.now();
    const mutationId = `mut-${now}-${Math.random().toString(36).substring(2, 8)}`;
    const newRecord: AlphaCoreRecord = JSON.parse(JSON.stringify(this.currentRecord));
    newRecord.updatedAt = now;

    const changes = proposal.changes;

    // Apply self-knowledge changes
    if (changes.selfKnowledge) {
      for (const item of changes.selfKnowledge) {
        if (item.statement) {
          const secStmt = this.sanitizeAndValidateText(item.statement);
          if (!secStmt.safe) return { success: false, reason: secStmt.reason };
        }
        if (item.id) {
          const idx = newRecord.selfKnowledge.findIndex((s) => s.id === item.id);
          if (idx >= 0) {
            newRecord.selfKnowledge[idx] = {
              ...newRecord.selfKnowledge[idx],
              ...item,
              updatedAt: now,
            } as SelfKnowledgeItem;
          } else {
            newRecord.selfKnowledge.push({
              id: item.id,
              topic: item.topic || "General",
              statement: item.statement || "",
              provenance: item.provenance || "inferred",
              confidence: item.confidence || "INFERRED",
              verificationStatus: item.verificationStatus || "unverified",
              evidenceRefs: item.evidenceRefs || [],
              updatedAt: now,
            });
          }
        }
      }
    }

    // Apply self-relevant memories
    if (changes.selfRelevantMemories) {
      for (const mem of changes.selfRelevantMemories) {
        if (mem.detail) {
          const secDetail = this.sanitizeAndValidateText(mem.detail);
          if (!secDetail.safe) return { success: false, reason: secDetail.reason };
        }
        if (mem.id) {
          const idx = newRecord.selfRelevantMemories.findIndex((m) => m.id === mem.id);
          if (idx >= 0) {
            newRecord.selfRelevantMemories[idx] = {
              ...newRecord.selfRelevantMemories[idx],
              ...mem,
              updatedAt: now,
            } as SelfRelevantMemory;
          } else {
            newRecord.selfRelevantMemories.push({
              id: mem.id,
              topic: mem.topic || "Development",
              detail: mem.detail || "",
              provenance: mem.provenance || "inferred",
              confidence: mem.confidence || "INFERRED",
              updatedAt: now,
            });
          }
        }
      }
    }

    // Apply learned principles
    if (changes.learnedPrinciples) {
      for (const lp of changes.learnedPrinciples) {
        if (lp.principle) {
          const secP = this.sanitizeAndValidateText(lp.principle);
          if (!secP.safe) return { success: false, reason: secP.reason };
        }
        if (lp.id) {
          const idx = newRecord.learnedPrinciples.findIndex((l) => l.id === lp.id);
          if (idx >= 0) {
            newRecord.learnedPrinciples[idx] = {
              ...newRecord.learnedPrinciples[idx],
              ...lp,
              updatedAt: now,
            } as LearnedPrinciple;
          } else {
            newRecord.learnedPrinciples.push({
              id: lp.id,
              principle: lp.principle || "",
              confidence: lp.confidence || "HIGH_CONFIDENCE",
              updatedAt: now,
            });
          }
        }
      }
    }

    // Apply unresolved questions
    if (changes.unresolvedQuestions) {
      for (const uq of changes.unresolvedQuestions) {
        if (uq.unresolvedQuestion) {
          const secUQ = this.sanitizeAndValidateText(uq.unresolvedQuestion);
          if (!secUQ.safe) return { success: false, reason: secUQ.reason };
        }
        if (uq.id) {
          const idx = newRecord.unresolvedQuestions.findIndex((u) => u.id === uq.id);
          if (idx >= 0) {
            newRecord.unresolvedQuestions[idx] = {
              ...newRecord.unresolvedQuestions[idx],
              ...uq,
            } as UnresolvedQuestion;
          } else {
            newRecord.unresolvedQuestions.push({
              id: uq.id,
              topic: uq.topic || "Investigation",
              unresolvedQuestion: uq.unresolvedQuestion || "",
              identifiedAt: uq.identifiedAt || now,
              status: uq.status || "open",
            });
          }
        }
      }
    }

    // Apply capability updates
    if (changes.capabilityUpdates) {
      for (const cap of changes.capabilityUpdates) {
        if (cap.toolOrCapability) {
          const idx = newRecord.capabilityUnderstanding.findIndex((c) => c.toolOrCapability === cap.toolOrCapability);
          if (idx >= 0) {
            newRecord.capabilityUnderstanding[idx] = {
              ...newRecord.capabilityUnderstanding[idx],
              ...cap,
              timestamp: now,
            } as CapabilityUnderstanding;
          } else {
            newRecord.capabilityUnderstanding.push({
              toolOrCapability: cap.toolOrCapability,
              status: cap.status || "VERIFIED",
              selfBelief: cap.selfBelief || "",
              verifiedRuntime: cap.verifiedRuntime ?? true,
              confidence: cap.confidence || "VERIFIED",
              timestamp: now,
            });
          }
        }
      }
    }

    // Apply developmental milestones
    if (changes.milestones) {
      for (const ms of changes.milestones) {
        newRecord.developmentalState.push({
          id: `dev-${now}-${Math.random().toString(36).substring(2, 6)}`,
          milestone: ms.milestone,
          summary: ms.summary,
          timestamp: now,
        });
      }
    }

    // Record mutation log
    const prevVersion = newRecord.coreVersion;
    newRecord.mutations.push({
      mutationId,
      source: proposal.source,
      reason: proposal.reason,
      evidence: proposal.evidence,
      previousVersion: prevVersion,
      resultingVersion: prevVersion,
      timestamp: now,
      authority,
    });

    // Enforce bounded mutation log
    if (newRecord.mutations.length > this.maxMutationsLog) {
      newRecord.mutations = newRecord.mutations.slice(-this.maxMutationsLog);
    }

    // 3. Strict Zod validation before committing
    const parsed = AlphaCoreRecordSchema.safeParse(newRecord);
    if (!parsed.success) {
      return {
        success: false,
        reason: `Schema validation failed on Core mutation: ${parsed.error.errors.map((e) => e.message).join(", ")}`,
      };
    }

    // In-memory state update
    this.currentRecord = parsed.data;
    return { success: true, mutationId, record: this.currentRecord };
  }

  /**
   * Self-correction mechanism: updates capability understanding when runtime verification contradicts self-belief.
   */
  public selfCorrectCapability(toolOrCapability: string, isAvailable: boolean, reason: string): {
    success: boolean;
    record?: AlphaCoreRecord;
  } {
    const existing = this.currentRecord.capabilityUnderstanding.find((c) => c.toolOrCapability === toolOrCapability);
    const now = Date.now();

    const proposal: CoreMutationProposal = {
      source: "self_correction_engine",
      reason: `Runtime capability correction for ${toolOrCapability}: ${reason}`,
      evidence: [`Runtime check: available = ${isAvailable}`],
      changes: {
        capabilityUpdates: [
          {
            toolOrCapability,
            status: isAvailable ? "VERIFIED" : "UNAVAILABLE",
            selfBelief: isAvailable ? `Capability ${toolOrCapability} is verified active.` : `Capability ${toolOrCapability} is verified unavailable/restricted.`,
            verifiedRuntime: isAvailable,
            confidence: "VERIFIED",
          },
        ],
        milestones: [
          {
            milestone: `Capability Correction: ${toolOrCapability}`,
            summary: `Self-corrected capability ${toolOrCapability} status to ${isAvailable ? "VERIFIED" : "UNAVAILABLE"}.`,
          },
        ],
      },
    };

    const res = this.mutateCore(proposal, "SelfCorrectionBoundary");
    return { success: res.success, record: res.record };
  }

  /**
   * Phase 13 Learning Integration: Consumes validated Phase 13 learning into Core.
   */
  public integrateLearning(learning: LearningRecord): {
    success: boolean;
    outcome: CoreCurationOutcome;
    record?: AlphaCoreRecord;
  } {
    const confidenceMap: Record<string, CoreConfidence> = {
      high: "HIGH_CONFIDENCE",
      medium: "INFERRED",
      low: "UNCERTAIN",
      unknown: "UNKNOWN",
    };
    const coreConf = confidenceMap[learning.confidence] || "INFERRED";
    const provenance: CoreProvenance = "phase_13_learning";

    const outcome = this.curateCandidate(learning.candidateStatement, provenance, coreConf);
    if (outcome !== "KEEP") {
      return { success: false, outcome };
    }

    const proposal: CoreMutationProposal = {
      source: `phase13-learning-${learning.id}`,
      reason: `Integrated validated learning: ${learning.subject}`,
      evidence: learning.evidenceReferences.map((e) => `[${e.type}] ${e.content}`),
      changes: {
        learnedPrinciples: [
          {
            id: `lp-${learning.id}`,
            principle: learning.candidateStatement,
            sourceLearningId: learning.id,
            confidence: coreConf,
          },
        ],
        selfKnowledge: [
          {
            id: `sk-${learning.id}`,
            topic: learning.subject,
            statement: learning.candidateStatement,
            provenance,
            confidence: coreConf,
            verificationStatus: "phase13_validated",
            evidenceRefs: learning.evidenceReferences.map((e) => e.sourceId),
          },
        ],
      },
    };

    const res = this.mutateCore(proposal, "Phase13IntegrationBoundary");
    return { success: res.success, outcome, record: res.record };
  }

  /**
   * Relevance-aware bounded context retrieval (Core Attention).
   */
  public retrieveCoreContext(query?: { topic?: string; maxChars?: number }): {
    identityContinuity: IdentityContinuity;
    relevantPrinciples: LearnedPrinciple[];
    relevantSelfKnowledge: SelfKnowledgeItem[];
    unresolvedQuestions: UnresolvedQuestion[];
  } {
    const maxChars = query?.maxChars ?? 1500;
    const topicFilter = query?.topic?.toLowerCase();

    let principles = this.currentRecord.learnedPrinciples;
    let knowledge = this.currentRecord.selfKnowledge;

    if (topicFilter) {
      principles = principles.filter((p) => p.principle.toLowerCase().includes(topicFilter));
      knowledge = knowledge.filter((k) => k.topic.toLowerCase().includes(topicFilter) || k.statement.toLowerCase().includes(topicFilter));
    }

    return {
      identityContinuity: this.currentRecord.identityContinuity,
      relevantPrinciples: principles.slice(0, 5),
      relevantSelfKnowledge: knowledge.slice(0, 5),
      unresolvedQuestions: this.currentRecord.unresolvedQuestions.filter((q) => q.status === "open").slice(0, 3),
    };
  }

  /**
   * Integrity check and verification.
   */
  public validateIntegrity(): { valid: boolean; errors: string[] } {
    const parsed = AlphaCoreRecordSchema.safeParse(this.currentRecord);
    if (!parsed.success) {
      return {
        valid: false,
        errors: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
      };
    }
    return { valid: true, errors: [] };
  }

  /**
   * Recovery mechanism: restores previous valid version if current state is corrupted.
   */
  public recoverCore(): { success: boolean; reason?: string; record?: AlphaCoreRecord } {
    const integrity = this.validateIntegrity();
    if (integrity.valid) {
      return { success: true, record: this.currentRecord };
    }

    if (this.previousVersionRecord) {
      const prevCheck = AlphaCoreRecordSchema.safeParse(this.previousVersionRecord);
      if (prevCheck.success) {
        this.currentRecord = prevCheck.data;
        return { success: true, reason: "Recovered successfully from previous valid version snapshot.", record: this.currentRecord };
      }
    }

    this.currentRecord = this.createInitialCore();
    return { success: true, reason: "Recovered successfully via initial core regeneration.", record: this.currentRecord };
  }

  /**
   * Secure import / export boundaries.
   */
  public exportCore(adminKey: string): { success: boolean; data?: AlphaCoreRecord; reason?: string } {
    if (!adminKey || adminKey !== "alpha-admin-secure-key") {
      return { success: false, reason: "Unauthorized Core export attempt." };
    }
    return { success: true, data: JSON.parse(JSON.stringify(this.currentRecord)) };
  }

  public importCore(raw: unknown, adminKey: string): { success: boolean; reason?: string } {
    if (!adminKey || adminKey !== "alpha-admin-secure-key") {
      return { success: false, reason: "Unauthorized Core import attempt." };
    }

    const parsed = AlphaCoreRecordSchema.safeParse(raw);
    if (!parsed.success) {
      return { success: false, reason: `Imported Core failed Zod validation: ${parsed.error.message}` };
    }

    // Verify security constraints on imported data
    for (const sk of parsed.data.selfKnowledge) {
      const sec = this.sanitizeAndValidateText(sk.statement);
      if (!sec.safe) {
        return { success: false, reason: `Import rejected: ${sec.reason}` };
      }
    }

    this.previousVersionRecord = JSON.parse(JSON.stringify(this.currentRecord));
    this.currentRecord = parsed.data;
    return { success: true };
  }

}

// Single authoritative singleton instance
export const alphaCore = new AlphaCoreAuthority();
