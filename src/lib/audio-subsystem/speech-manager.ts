import { ExecutionId, CancellableOperation } from "./types";

export type SpeechState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'INTERRUPTING' | 'CANCELLED' | 'ERROR';

export interface SpeechManagerListener {
  onStateChange: (state: SpeechState) => void;
}

export class SpeechManager {
  private static instance: SpeechManager;
  private currentState: SpeechState = 'IDLE';
  private currentExecutionId: ExecutionId | null = null;
  private listeners: SpeechManagerListener[] = [];

  private constructor() {}

  static getInstance(): SpeechManager {
    if (!SpeechManager.instance) {
      SpeechManager.instance = new SpeechManager();
    }
    return SpeechManager.instance;
  }

  setState(state: SpeechState, executionId?: ExecutionId) {
    if (executionId && this.currentExecutionId !== executionId) {
      return; // Stale state update
    }
    this.currentState = state;
    this.listeners.forEach(l => l.onStateChange(state));
  }

  getState(): SpeechState {
    return this.currentState;
  }

  addListener(listener: SpeechManagerListener) {
    this.listeners.push(listener);
  }

  // Authoritative control
  async interrupt(): Promise<void> {
    this.setState('INTERRUPTING');
    // Actual interruption logic (cancel recognizer, TTS)
    this.setState('IDLE');
  }
}
