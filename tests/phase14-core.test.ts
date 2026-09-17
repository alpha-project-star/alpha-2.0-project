import { describe, it, expect, beforeEach } from 'vitest';
import { alphaCore } from '../src/lib/alpha-core';

describe('Phase 14 - Alpha Core Authority & Self-Continuity', () => {
  beforeEach(() => {
    alphaCore.reset();
  });

  it('14.1 Identity & Continuity', () => {
    const core = alphaCore.getCore();
    expect(core.identityContinuity.canonicalName).toBe('Alpha');
  });
});
