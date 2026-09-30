import type { ActionResult } from "../actions";
import type { RequestActionLifecycle } from "../request-lifecycle";

export type AlphaGateOrigin =
  | "model"
  | "local_intent"
  | "settings"
  | "proactive"
  | "ambient"
  | "notification"
  | "system_error";

export interface NativeToolExecutionSummary {
  executedCount: number;
  hasMutation: boolean;
  allMutationsSucceeded: boolean;
  hasFailedMutation: boolean;
  results: Array<{
    name: string;
    success: boolean;
    isMutation: boolean;
    error?: any;
    executionKey?: string;
    logicalKeys?: string[];
  }>;
  executedLogicalKeys?: string[];
}

export interface AlphaGateCandidate {
  rawText: string;
  deferredProse?: string[];
  origin: AlphaGateOrigin;
  modelIdentity?: string;
  webContext?: string;
  toolSummary?: NativeToolExecutionSummary;
  actionResults?: ActionResult[];
  lifecycle?: RequestActionLifecycle;
  signal?: AbortSignal;
}

export interface AlphaGateDiagnostics {
  thinkingStripped?: boolean;
  providerLeakStripped?: boolean;
  fencesRepaired?: boolean;
  mathRepaired?: boolean;
  actionRepaired?: boolean;
  sourcesFiltered?: boolean;
}

export type AlphaGateActionStatus =
  | "none"
  | "success"
  | "partial_failure"
  | "all_failed"
  | "unverified_claim";

export interface AlphaGateResult {
  approvedText: string;
  status: "approved" | "repaired" | "fallback";
  diagnostics?: AlphaGateDiagnostics;
  actionStatus?: AlphaGateActionStatus;
}
