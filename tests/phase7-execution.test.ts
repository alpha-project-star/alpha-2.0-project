import { describe, it, expect } from 'vitest';
import { GoalSchema, TaskSchema, RunSchema, StepSchema, ObservationSchema, ResultSchema, EvaluationSchema } from '../src/lib/execution';

describe('Phase 7 - Execution State', () => {
  it('7.1 GoalSchema - Minimal', () => {
    const goal = { id: 'g-1', title: 'T', status: 'active', createdAt: 1, updatedAt: 1, taskIds: [] };
    expect(GoalSchema.parse(goal)).toEqual({ ...goal, taskIds: [] });
  });
  it('7.2 GoalSchema - Description', () => {
    const goal = { id: 'g-1', title: 'T', status: 'active', createdAt: 1, updatedAt: 1, taskIds: [], description: 'D' };
    expect(GoalSchema.parse(goal).description).toBe('D');
  });
  it('7.3 GoalSchema - Rejects Status', () => {
    expect(() => GoalSchema.parse({ id: 'g-1', title: 'T', status: 'invalid', createdAt: 1, updatedAt: 1 })).toThrow();
  });
  it('7.4 TaskSchema - Minimal', () => {
    const task = { id: 't-1', title: 'T', status: 'ready', createdAt: 1, updatedAt: 1, dependencies: [], cancellationState: 'none' };
    expect(TaskSchema.parse(task)).toEqual({ ...task, dependencies: [], cancellationState: 'none' });
  });
  it('7.5 TaskSchema - GoalId', () => {
    const task = { id: 't-1', title: 'T', status: 'ready', createdAt: 1, updatedAt: 1, dependencies: [], cancellationState: 'none', goalId: 'g1' };
    expect(TaskSchema.parse(task).goalId).toBe('g1');
  });
  it('7.6 TaskSchema - All Statuses', () => {
    ["draft", "ready", "active", "blocked", "completed", "cancelled", "failed"].forEach(status => {
       expect(TaskSchema.parse({ id: 't-1', title: 'T', status, createdAt: 1, updatedAt: 1, dependencies: [], cancellationState: 'none' }).status).toBe(status);
    });
  });
  it('7.7 RunSchema - Minimal', () => {
    const run = { id: 'r-1', taskId: 't-1', status: 'queued' };
    expect(RunSchema.parse(run)).toEqual(run);
  });
  it('7.8 RunSchema - All Statuses', () => {
    ["queued", "running", "waiting", "completed", "failed", "cancelled", "blocked"].forEach(status => {
       expect(RunSchema.parse({ id: 'r-1', taskId: 't-1', status }).status).toBe(status);
    });
  });
  it('7.9 StepSchema - Minimal', () => {
    const step = { id: 's-1', runId: 'r-1', sequence: 1, description: 'D', status: 'pending', observationReferences: [] };
    expect(StepSchema.parse(step)).toEqual({ ...step, observationReferences: [] });
  });
  it('7.10 ObservationSchema - Types', () => {
    ["model_result", "tool_result", "search_result", "action_result"].forEach(type => {
       expect(ObservationSchema.parse({ id: 'o-1', runId: 'r-1', type, content: 'C', provenance: 'system', timestamp: 1 }).type).toBe(type);
    });
  });
  it('7.11 ResultSchema - Outcomes', () => {
    ["success", "partial_success", "failure", "cancellation", "blocked", "no_op"].forEach(outcome => {
       expect(ResultSchema.parse({ id: 'res-1', runId: 'r-1', outcome, evidence: 'E', timestamp: 1 }).outcome).toBe(outcome);
    });
  });
  it('7.12 EvaluationSchema - Minimal', () => {
    const evalResult = { runId: 'r-1', accomplished: true, reason: 'R', uncertainty: false };
    expect(EvaluationSchema.parse(evalResult)).toEqual(evalResult);
  });
  it('7.13 StepSchema - Statuses', () => {
    ["pending", "running", "completed", "failed", "cancelled"].forEach(status => {
       expect(StepSchema.parse({ id: 's-1', runId: 'r-1', sequence: 1, description: 'D', status, observationReferences: [] }).status).toBe(status);
    });
  });
  it('7.14 TaskSchema - Dependencies', () => {
    const task = { id: 't-1', title: 'T', status: 'ready', createdAt: 1, updatedAt: 1, dependencies: ['t0'], cancellationState: 'none' };
    expect(TaskSchema.parse(task).dependencies).toContain('t0');
  });
  it('7.15 GoalSchema - Multiple TaskIds', () => {
    const goal = { id: 'g-1', title: 'T', status: 'active', createdAt: 1, updatedAt: 1, taskIds: ['t1', 't2'] };
    expect(GoalSchema.parse(goal).taskIds).toHaveLength(2);
  });
  it('7.16 EvaluationSchema - Uncertainty', () => {
    expect(EvaluationSchema.parse({ runId: 'r-1', accomplished: false, reason: 'U', uncertainty: true }).uncertainty).toBe(true);
  });
  it('7.17 TaskSchema - Cancellation States', () => {
    ["none", "requested", "cancelled"].forEach(c => {
       expect(TaskSchema.parse({ id: 't-1', title: 'T', status: 'cancelled', createdAt: 1, updatedAt: 1, dependencies: [], cancellationState: c as any }).cancellationState).toBe(c);
    });
  });
  it('7.18 GoalSchema - Priority', () => {
     const goal = { id: 'g-1', title: 'T', status: 'active', createdAt: 1, updatedAt: 1, taskIds: [], priority: 'high' };
     expect(GoalSchema.parse(goal).priority).toBe('high');
  });
  it('7.19 TaskSchema - Priority', () => {
     const task = { id: 't-1', title: 'T', status: 'ready', createdAt: 1, updatedAt: 1, dependencies: [], cancellationState: 'none', priority: 'medium' };
     expect(TaskSchema.parse(task).priority).toBe('medium');
  });
  it('7.20 ObservationSchema - Additional Types', () => {
    ["provider_failure", "user_response", "external_state_change"].forEach(type => {
       expect(ObservationSchema.parse({ id: 'o-1', runId: 'r-1', type, content: 'C', provenance: 'system', timestamp: 1 }).type).toBe(type);
    });
  });
});
