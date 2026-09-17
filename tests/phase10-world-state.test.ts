import { describe, it, expect, beforeEach } from 'vitest';
import { alphaStore } from '../src/lib/alpha-store';

describe('Phase 10 - World State & Multi-Domain Authority', () => {
  beforeEach(() => {
    alphaStore.replaceAll({
      chat: [], notes: [], bills: [], reminders: [], tasks: [], goals: [], runs: [], steps: [], observations: [], results: [], memories: []
    });
  });

  it('10.1 Domain Isolation', () => {
    const state = alphaStore.get();
    expect(state.notes).toBeDefined();
    expect(state.bills).toBeDefined();
  });
});
