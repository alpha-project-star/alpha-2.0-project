import { alphaStore } from "./alpha-store";

/**
 * Groq Whisper STT — records mic audio via MediaRecorder in
 * self-contained segments and posts each to Groq's OpenAI-compatible
 * transcription endpoint. Uses the same `groqApiKey` the chat models
 * already use, so it works in the LovableApp / Android WebView where
 * `window.speechSynthesis`/`SpeechRecognition` are missing.
 *
 * Public surface matches ContinuousRecognizer / WhisperRecognizer so
 * voice.ts can route to it transparently.
 */

type Handlers = {
  onInterim?: (t: string) => void;
  onFinal?: (t: string) => void;
  onStart?: () => void;
  onStop?: () => void;
  onError?: (msg: string) => void;
};

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

function keyOk(): string {
  return (alphaStore.get().settings.groqApiKey || "").trim();
}

export class GroqWhisperRecognizer {
  private handlers: Handlers = {};
  private wantOn = false;
  private active = false;
  private paused = false;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private silenceFrames = 0;
  private speechFrames = 0;
  private hasSpeech = false;
  private rafId: number | null = null;
  private mime = "audio/webm";

  get isActive() {
    return this.active;
  }
  get isWanted() {
    return this.wantOn;
  }
  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  setHandlers(h: Handlers) {
    this.handlers = h;
  }

  private pickMime(): string {
    const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const t of opts) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return "audio/webm";
  }

  async start() {
    if (typeof window === "undefined") return;
    if (!keyOk()) {
      this.handlers.onError?.("Add your Groq API key in Settings → Online to enable voice input.");
      this.handlers.onStop?.();
      return;
    }
    this.wantOn = true;
    this.paused = false;
    if (this.active) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e: any) {
      this.wantOn = false;
      this.handlers.onError?.(e?.message || "Microphone permission denied");
      this.handlers.onStop?.();
      return;
    }
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    this.mime = this.pickMime();
    this.active = true;
    this.handlers.onStart?.();
    this.beginSegment();
    this.loop();
  }

  private beginSegment() {
    if (!this.stream || !this.wantOn || this.paused) return;
    this.chunks = [];
    this.hasSpeech = false;
    this.silenceFrames = 0;
    this.speechFrames = 0;
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType: this.mime });
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.flushSegment();
    this.recorder.start();
  }

  private async flushSegment() {
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    const shouldSend = this.hasSpeech && blob.size > 4000;
    if (this.wantOn && !this.paused) this.beginSegment();
    if (!shouldSend) return;
    const key = keyOk();
    if (!key) return;
    try {
      const ext = /mp4/i.test(this.mime) ? "mp4" : /ogg/i.test(this.mime) ? "ogg" : "webm";
      const form = new FormData();
      form.append("file", blob, `clip.${ext}`);
      form.append("model", GROQ_MODEL);
      form.append("response_format", "json");
      form.append("temperature", "0");
      const lang = (typeof navigator !== "undefined" ? navigator.language || "en" : "en").slice(
        0,
        2,
      );
      if (lang) form.append("language", lang);
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        this.handlers.onError?.(`Groq STT ${res.status}: ${t.slice(0, 160)}`);
        return;
      }
      const j: any = await res.json();
      const text: string = (j?.text || "").trim();
      if (text) this.handlers.onFinal?.(text);
    } catch (e: any) {
      this.handlers.onError?.(`Groq STT unreachable: ${e?.message || e}`);
    }
  }

  private loop = () => {
    if (!this.active || !this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const SPEECH = 0.035;
    const SILENCE = 0.02;
    if (rms > SPEECH) {
      this.speechFrames++;
      this.silenceFrames = 0;
      if (this.speechFrames > 3) this.hasSpeech = true;
    } else if (rms < SILENCE) {
      this.silenceFrames++;
      this.speechFrames = 0;
    }
    if (this.hasSpeech && this.silenceFrames > 55) {
      try {
        this.recorder?.state === "recording" && this.recorder.stop();
      } catch {}
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  suspend() {
    this.paused = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.recorder?.state === "recording" && this.recorder.stop();
    } catch {}
  }

  resume() {
    if (!this.wantOn) return;
    this.paused = false;
    if (!this.stream) {
      void this.start();
      return;
    }
    this.beginSegment();
    this.loop();
  }

  stop() {
    this.wantOn = false;
    this.paused = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.recorder?.state === "recording" && this.recorder.stop();
    } catch {}
    this.recorder = null;
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.analyser?.disconnect();
    } catch {}
    try {
      this.ctx?.close();
    } catch {}
    this.source = null;
    this.analyser = null;
    this.ctx = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.active = false;
    this.handlers.onStop?.();
  }

  dispose() {
    this.stop();
  }
}
