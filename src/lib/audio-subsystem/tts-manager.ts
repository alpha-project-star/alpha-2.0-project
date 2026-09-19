import { ExecutionId } from "./types";
import { alphaStore } from "../alpha-store";

export interface TTSBrowserOptions {
  rate?: number;
  pitch?: number;
  volume?: number;
  voice?: SpeechSynthesisVoice | null;
}

export class TTSManager {
  private static instance: TTSManager;
  private currentExecutionId: ExecutionId | null = null;
  private abortController: AbortController | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentUtter: SpeechSynthesisUtterance | null = null;
  private unlockUtter: SpeechSynthesisUtterance | null = null;
  private cachedVoice: SpeechSynthesisVoice | null = null;
  private audioUnlocked = false;

  private constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        this.cachedVoice = this.pickVoice();
      };
    }
  }

  static getInstance(): TTSManager {
    if (!TTSManager.instance) {
      TTSManager.instance = new TTSManager();
    }
    return TTSManager.instance;
  }

  /**
   * Browser voice query
   */
  public listVoices(): SpeechSynthesisVoice[] {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices();
  }

  /**
   * Pick best voice matching user preference or persona
   */
  public pickVoice(): SpeechSynthesisVoice | null {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const pref = alphaStore.get().settings.preferredVoice;
    if (pref) {
      const v = voices.find((v) => v.name === pref);
      if (v) return v;
    }
    // Prefer a smooth male / UK voice to match Alpha persona
    const enMale = voices.find(
      (v) =>
        /^en/i.test(v.lang) &&
        /(male|daniel|alex|fred|tom|guy|james|michael|david|ryan|aaron|arthur|google uk english male)/i.test(
          v.name,
        ),
    );
    if (enMale) return enMale;
    const gb = voices.find((v) => /en[-_]GB/i.test(v.lang));
    if (gb) return gb;
    return voices.find((v) => /^en/i.test(v.lang)) ?? voices[0];
  }

  /**
   * Unlock speech and audio on mobile/Android inside a user gesture
   */
  public prepareUtterance(): void {
    if (typeof window === "undefined") return;
    if ("speechSynthesis" in window) {
      if (!this.cachedVoice) this.cachedVoice = this.pickVoice();
      this.unlockUtter = new SpeechSynthesisUtterance("");
      if (this.cachedVoice) {
        this.unlockUtter.voice = this.cachedVoice;
        this.unlockUtter.lang = this.cachedVoice.lang;
      }
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    if (!this.audioUnlocked) {
      try {
        const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
        const a = new Audio(SILENT_WAV);
        a.volume = 0;
        const p = a.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            this.audioUnlocked = true;
          }).catch(() => {});
        }
      } catch {}
    }
  }

  /**
   * Browser SpeechSynthesis execution
   */
  public speakBrowser(text: string, options: TTSBrowserOptions = {}): Promise<void> {
    return new Promise((resolve) => {
      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window) ||
        !window.speechSynthesis
      ) {
        resolve();
        return;
      }

      if (!this.cachedVoice) this.cachedVoice = this.pickVoice();
      const u = new SpeechSynthesisUtterance(text);
      const chosenVoice = options.voice || this.cachedVoice;
      if (chosenVoice) {
        u.voice = chosenVoice;
        u.lang = chosenVoice.lang;
      }
      u.rate = options.rate ?? alphaStore.get().settings.ttsRate ?? 1;
      u.pitch = options.pitch ?? 0.95;
      u.volume = options.volume ?? 1;
      this.currentUtter = u;

      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          if (this.currentUtter === u) {
            this.currentUtter = null;
          }
          resolve();
        }
      };

      u.onend = finish;
      u.onerror = finish;

      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(u);
      } catch {
        finish();
      }
    });
  }

  /**
   * Speak an audio stream or blob (Kokoro / network TTS)
   */
  async speak(blobOrUrl: Blob | string, id?: ExecutionId): Promise<void> {
    this.cancel(); // Interrupt any existing speech
    
    if (typeof window === "undefined" || typeof Audio === "undefined") {
      return;
    }

    if (id) this.currentExecutionId = id;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    const audio = new Audio(url);
    audio.crossOrigin = "anonymous";
    audio.playbackRate = alphaStore.get().settings.ttsRate || 1;
    this.currentAudio = audio;

    try {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          audio.pause();
          if (typeof blobOrUrl !== "string") URL.revokeObjectURL(url);
          reject(new Error('AbortError'));
        });
        audio.onended = () => resolve();
        audio.onerror = (e) => reject(e);
        audio.play().catch(reject);
      });
    } finally {
      if (typeof blobOrUrl !== "string") {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }
      if (!id || this.currentExecutionId === id) {
        this.currentExecutionId = null;
        this.currentAudio = null;
      }
    }
  }

  /**
   * Cancel and preempt any active browser speech or audio playback
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    this.currentUtter = null;

    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
      } catch {}
      this.currentAudio = null;
    }
    this.currentExecutionId = null;
  }
}

export const ttsManager = TTSManager.getInstance();

