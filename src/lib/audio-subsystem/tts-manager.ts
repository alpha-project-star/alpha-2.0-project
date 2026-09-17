import { ExecutionId } from "./types";

export class TTSManager {
  private static instance: TTSManager;
  private currentExecutionId: ExecutionId | null = null;
  private abortController: AbortController | null = null;
  private currentAudio: HTMLAudioElement | null = null;

  private constructor() {}

  static getInstance(): TTSManager {
    if (!TTSManager.instance) {
      TTSManager.instance = new TTSManager();
    }
    return TTSManager.instance;
  }

  async speak(blob: Blob, id: ExecutionId): Promise<void> {
    this.cancel(); // Interrupt any existing speech
    
    this.currentExecutionId = id;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.currentAudio = audio;

    try {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          audio.pause();
          URL.revokeObjectURL(url);
          reject(new Error('AbortError'));
        });
        audio.onended = () => resolve();
        audio.onerror = (e) => reject(e);
        audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
      if (this.currentExecutionId === id) {
        this.currentExecutionId = null;
        this.currentAudio = null;
      }
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentAudio) {
      this.currentAudio.pause();
      try {
        URL.revokeObjectURL(this.currentAudio.src);
      } catch {}
      this.currentAudio = null;
    }
    this.currentExecutionId = null;
  }
}
