/**
 * ============================================================================
 * ARCHITECTURAL AUTHORITY DECLARATION — AL-02 RECONCILIATION
 * ============================================================================
 * ROLE: Canonical Planning & Execution Structures
 * AUTHORITATIVE SYMBOLS: Goal, Task, Step, Run, Observation, Result, Evaluation
 *
 * RESPONSIBILITIES:
 *  - Defines the core relational/decomposition schemas for Phase 9 Goal Planning,
 *    Task decomposition, Step execution, and dependencies.
 *  - Enforces structure, status transitions, and relational validity for execution.
 *  - Manages dependency resolution state and step-level outcomes.
 *
 * NOT RESPONSIBLE FOR:
 *  - Conversational reminder context or focus tracking (owned by `src/lib/reminder-context.ts`).
 *  - Active action execution sequencing or runtime tool coordination (owned by `src/lib/actions.ts`).
 * ============================================================================
 */

import { z } from "zod";

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(["active", "paused", "completed", "cancelled"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deadline: z.number().optional(),
  taskIds: z.array(z.string()).default([]),
});
export type Goal = z.infer<typeof GoalSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  goalId: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(["draft", "ready", "active", "blocked", "completed", "cancelled", "failed"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  dueAt: z.number().optional(),
  dependencies: z.array(z.string()).default([]),
  cancellationState: z.enum(["none", "requested", "cancelled"]).default("none"),
  completionInformation: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const RunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "blocked"]),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const StepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sequence: z.number(),
  description: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  toolReference: z.string().optional(),
  observationReferences: z.array(z.string()).default([]),
  resultReference: z.string().optional(),
  errorInformation: z.string().optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const ObservationSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string().optional(),
  type: z.enum(["model_result", "tool_result", "search_result", "action_result", "provider_failure", "user_response", "external_state_change"]),
  content: z.string(),
  provenance: z.string(),
  timestamp: z.number(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const ResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string().optional(),
  outcome: z.enum(["success", "partial_success", "failure", "cancellation", "blocked", "no_op"]),
  evidence: z.string(),
  timestamp: z.number(),
});
export type Result = z.infer<typeof ResultSchema>;

export const EvaluationSchema = z.object({
  runId: z.string(),
  accomplished: z.boolean(),
  reason: z.string(),
  uncertainty: z.boolean().default(false),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export interface EvaluationResult {
  evaluation: Evaluation;
  result: Result;
}
