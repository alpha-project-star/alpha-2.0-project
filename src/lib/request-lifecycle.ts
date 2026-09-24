/**
 * Canonical Request & Action Lifecycle Management
 *
 * Provides a single authoritative in-memory lifecycle per user request:
 *  - State: pending | needs_clarification | executing | completed | failed
 *  - Tracks all operations (native tools, action tags, local intents)
 *  - Records canonical execution and logical mutation keys
 *  - Distinguishes completed vs pending vs failed actions
 *  - Enforces completion boundary: completed mutations cannot be re-executed or reopened
 *  - Distinguishes already-completed mutations from legitimate multi-step operations (e.g. read -> mutate)
 */

export type RequestLifecycleState =
  | "pending"
  | "needs_clarification"
  | "executing"
  | "completed"
  | "failed";

export type OperationStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "needs_clarification";

export interface CanonicalActionRecord {
  id: string;
  name: string;
  isMutation: boolean;
  status: OperationStatus;
  logicalKey?: string;
  executionKey?: string;
  args?: any;
  result?: any;
  error?: any;
  timestamp: number;
}

export interface ClarificationState {
  isPending: boolean;
  question?: string;
  targetOperation?: string;
  suppliedInTurn?: boolean;
}

export class RequestActionLifecycle {
  readonly requestId: string;
  private state: RequestLifecycleState = "pending";
  private operations: CanonicalActionRecord[] = [];
  private completedLogicalMutations = new Map<string, any>();
  private completedExecutionKeys = new Map<string, any>();
  private activeOperation: CanonicalActionRecord | null = null;
  private clarification: ClarificationState = { isPending: false };
  private needsAnotherStep = false;

  constructor(requestId: string = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) {
    this.requestId = requestId;
  }

  getState(): RequestLifecycleState {
    return this.state;
  }

  getActiveOperation(): CanonicalActionRecord | null {
    return this.activeOperation;
  }

  getAllOperations(): readonly CanonicalActionRecord[] {
    return this.operations;
  }

  getCompletedMutations(): ReadonlyMap<string, any> {
    return this.completedLogicalMutations;
  }

  hasCompletedMutation(logicalKey?: string | null): boolean {
    if (!logicalKey) return false;
    const normalized = logicalKey.toLowerCase().trim();
    return this.completedLogicalMutations.has(normalized);
  }

  getCompletedMutationResult(logicalKey?: string | null): any {
    if (!logicalKey) return undefined;
    const normalized = logicalKey.toLowerCase().trim();
    return this.completedLogicalMutations.get(normalized);
  }

  hasCompletedExecutionKey(executionKey?: string | null): boolean {
    if (!executionKey) return false;
    return this.completedExecutionKeys.has(executionKey);
  }

  getCompletedExecutionResult(executionKey?: string | null): any {
    if (!executionKey) return undefined;
    return this.completedExecutionKeys.get(executionKey);
  }

  startOperation(params: {
    name: string;
    isMutation: boolean;
    logicalKey?: string | null;
    executionKey?: string | null;
    args?: any;
  }): CanonicalActionRecord {
    const id = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const op: CanonicalActionRecord = {
      id,
      name: params.name,
      isMutation: params.isMutation,
      status: "executing",
      logicalKey: params.logicalKey ? params.logicalKey.toLowerCase().trim() : undefined,
      executionKey: params.executionKey || undefined,
      args: params.args,
      timestamp: Date.now(),
    };
    this.activeOperation = op;
    this.operations.push(op);
    this.state = "executing";
    return op;
  }

  recordSuccess(params: {
    opId?: string;
    name: string;
    isMutation: boolean;
    result: any;
    logicalKeys?: string[];
    executionKey?: string | null;
  }): void {
    let op = params.opId ? this.operations.find((o) => o.id === params.opId) : null;
    if (!op) {
      op = {
        id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: params.name,
        isMutation: params.isMutation,
        status: "completed",
        executionKey: params.executionKey || undefined,
        result: params.result,
        timestamp: Date.now(),
      };
      this.operations.push(op);
    } else {
      op.status = "completed";
      op.result = params.result;
    }

    if (params.executionKey) {
      this.completedExecutionKeys.set(params.executionKey, params.result);
    }

    if (params.isMutation) {
      if (params.logicalKeys && params.logicalKeys.length > 0) {
        for (const k of params.logicalKeys) {
          if (k) {
            const norm = k.toLowerCase().trim();
            this.completedLogicalMutations.set(norm, params.result);
          }
        }
      } else if (op.logicalKey) {
        this.completedLogicalMutations.set(op.logicalKey, params.result);
      }
    }

    if (this.activeOperation?.id === op.id) {
      this.activeOperation = null;
    }

    this.recomputeState();
  }

  recordFailure(params: {
    opId?: string;
    name: string;
    isMutation: boolean;
    error: any;
    logicalKey?: string | null;
    executionKey?: string | null;
  }): void {
    let op = params.opId ? this.operations.find((o) => o.id === params.opId) : null;
    if (!op) {
      op = {
        id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: params.name,
        isMutation: params.isMutation,
        status: "failed",
        logicalKey: params.logicalKey ? params.logicalKey.toLowerCase().trim() : undefined,
        executionKey: params.executionKey || undefined,
        error: params.error,
        timestamp: Date.now(),
      };
      this.operations.push(op);
    } else {
      op.status = "failed";
      op.error = params.error;
    }

    if (this.activeOperation?.id === op.id) {
      this.activeOperation = null;
    }

    this.recomputeState();
  }

  recordClarification(question: string, targetOperation?: string): void {
    this.clarification = {
      isPending: true,
      question,
      targetOperation,
    };
    this.state = "needs_clarification";
  }

  setClarificationSupplied(supplied: boolean): void {
    this.clarification.suppliedInTurn = supplied;
    if (supplied && this.clarification.isPending) {
      this.clarification.isPending = false;
      this.state = "pending";
    }
  }

  getClarificationState(): Readonly<ClarificationState> {
    return this.clarification;
  }

  setNeedsAnotherStep(needs: boolean): void {
    this.needsAnotherStep = needs;
  }

  getNeedsAnotherStep(): boolean {
    return this.needsAnotherStep;
  }

  hasCompletedMutations(): boolean {
    return this.completedLogicalMutations.size > 0;
  }

  hasFailedMutations(): boolean {
    return this.operations.some((o) => o.isMutation && o.status === "failed");
  }

  hasUnresolvedWork(): boolean {
    if (this.clarification.isPending || this.state === "needs_clarification") return true;
    if (this.activeOperation) return true;
    if (this.needsAnotherStep) return true;
    if (this.hasFailedMutations()) return true;

    const mutations = this.operations.filter((o) => o.isMutation);
    if (mutations.length > 0) {
      return !mutations.every((m) => m.status === "completed");
    }

    return this.operations.some((o) => o.status === "pending" || o.status === "executing");
  }

  isRequestFulfilled(): boolean {
    return !this.hasUnresolvedWork() && this.operations.length > 0;
  }

  private recomputeState(): void {
    if (this.clarification.isPending) {
      this.state = "needs_clarification";
      return;
    }
    const failedMutations = this.operations.filter((o) => o.isMutation && o.status === "failed");
    const completedMutations = this.operations.filter((o) => o.isMutation && o.status === "completed");

    if (failedMutations.length > 0 && completedMutations.length === 0) {
      this.state = "failed";
    } else if (completedMutations.length > 0 && !this.activeOperation && !this.needsAnotherStep) {
      this.state = "completed";
    } else if (this.activeOperation) {
      this.state = "executing";
    }
  }
}
