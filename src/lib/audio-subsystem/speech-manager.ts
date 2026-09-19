import { ExecutionId } from "./types";
import { ttsManager } from "./tts-manager";

export type SpeechState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'INTERRUPTING' | 'CANCELLED' | 'ERROR';

export interface SpeechManagerListener {
  onStateChange: (state: SpeechState) => void;
}

export class SpeechManager {
  private static instance: SpeechManager;
  private currentState: SpeechState = 'IDLE';
  private currentExecutionId: ExecutionId | null = null;
  private listeners: Set<SpeechManagerListener> = new Set();
  private cleanupCallbacks: Set<() => void> = new Set();
  private activeTimeouts: Set<NodeJS.Timeout | number> = new Set();

  private constructor() {}

  static getInstance(): SpeechManager {
    if (!SpeechManager.instance) {
      SpeechManager.instance = new SpeechManager();
    }
    return SpeechManager.instance;
  }

  setState(state: SpeechState, executionId?: ExecutionId) {
    if (executionId && this.currentExecutionId && this.currentExecutionId !== executionId) {
      return; // Stale state update from preempted or outdated execution
    }
    if (executionId) {
      this.currentExecutionId = executionId;
    }
    this.currentState = state;
    this.listeners.forEach((l) => {
      try {
        l.onStateChange(state);
      } catch (err) {
        console.error("Error in SpeechManagerListener:", err);
      }
    });
  }

  getState(): SpeechState {
    return this.currentState;
  }

  addListener(listener: SpeechManagerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  removeListener(listener: SpeechManagerListener): void {
    this.listeners.delete(listener);
  }

  registerCleanup(callback: () => void): () => void {
    this.cleanupCallbacks.add(callback);
    return () => {
      this.cleanupCallbacks.delete(callback);
    };
  }

  registerTimeout(timeout: NodeJS.Timeout | number): void {
    this.activeTimeouts.add(timeout);
  }

  clearTimeouts(): void {
    this.activeTimeouts.forEach((t) => {
      try {
        clearTimeout(t as any);
      } catch {}
    });
    this.activeTimeouts.clear();
  }

  // Authoritative control
  async interrupt(): Promise<void> {
    this.setState('INTERRUPTING');
    
    // Clear timeouts
    this.clearTimeouts();

    // Deterministically execute and clear all registered teardown callbacks
    this.cleanupCallbacks.forEach((cleanup) => {
      try {
        cleanup();
      } catch (e) {
        console.warn("SpeechManager cleanup error:", e);
      }
    });
    this.cleanupCallbacks.clear();

    // Cancel TTS
    try {
      ttsManager.cancel();
    } catch {}

    this.currentExecutionId = null;
    this.setState('IDLE');
  }

  teardown(): void {
    this.clearTimeouts();
    this.cleanupCallbacks.forEach((cleanup) => {
      try {
        cleanup();
      } catch {}
    });
    this.cleanupCallbacks.clear();
    this.listeners.clear();
    this.currentExecutionId = null;
    this.currentState = 'IDLE';
  }
}

export const speechManager = SpeechManager.getInstance();

