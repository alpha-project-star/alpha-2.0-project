import { describe, it, expect, beforeEach } from 'vitest';
import { tryLocalIntent } from '../src/lib/local-intents';
import { alphaStore } from '../src/lib/alpha-store';

describe('Phase 9 - Advanced Planning & Intent Resolution', () => {
  beforeEach(() => {
    alphaStore.replaceAll({
      chat: [], notes: [], bills: [], reminders: [], tasks: [], goals: [], runs: [], steps: [], observations: [], results: [], memories: []
    });
  });

  it('9.1 tryLocalIntent - Music Stop', async () => {
    expect(await tryLocalIntent('Stop the music')).toBe('Music stopped.');
  });
  it('9.2 tryLocalIntent - Add Note', async () => {
    const res = await tryLocalIntent('Note that I need milk');
    expect(res).toMatch(/note|saved|stored/i);
    expect(alphaStore.get().notes.some(n => n.body.includes('milk'))).toBe(true);
  });
});
