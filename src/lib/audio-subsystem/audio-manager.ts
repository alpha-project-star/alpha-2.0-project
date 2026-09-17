import { ExecutionId } from "./types";

export class AudioManager {
  private static instance: AudioManager;
  private audioCtx: AudioContext | null = null;
  private activeOperations: Map<ExecutionId, {
    ctx: AudioContext;
    cleanup: () => void;
  }> = new Map();

  private constructor() {}

  static getInstance(): AudioManager {
    if (!AudioManager.instance) {
      AudioManager.instance = new AudioManager();
    }
    return AudioManager.instance;
  }

  getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx();
    }
    return this.audioCtx!;
  }

  async resumeContext(): Promise<void> {
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  registerOperation(id: ExecutionId, cleanup: () => void) {
    this.activeOperations.set(id, {
      ctx: this.getAudioContext(),
      cleanup
    });
  }

  cancelOperation(id: ExecutionId) {
    const op = this.activeOperations.get(id);
    if (op) {
      op.cleanup();
      this.activeOperations.delete(id);
    }
  }

  cleanup() {
    this.activeOperations.forEach(op => op.cleanup());
    this.activeOperations.clear();
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
