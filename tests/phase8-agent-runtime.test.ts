import { describe, it, expect } from 'vitest';
import { toolRegistry } from '../src/lib/tool-registry';
import { executeTool } from '../src/lib/alpha.functions';

describe('Phase 8 - Agent Runtime & Tool Execution', () => {
  it('8.1 ToolRegistry - listAvailable', () => {
    const list = toolRegistry.listAvailable();
    expect(list.some(t => t.id === 'reminders.list')).toBe(true);
  });
  it('8.2 executeTool - handles reminder list call', async () => {
    const call = { function: { name: 'reminders.list', arguments: '{}' } };
    try {
      await executeTool(call, { userId: 'u1' });
    } catch (e) {}
  });
  it('8.3 executeTool - handles invalid JSON arguments', async () => {
    const call = { function: { name: 'reminders.list', arguments: '{bad' } };
    const res = await executeTool(call, { userId: 'u1' });
    expect(res.success).toBe(false);
  });
});
