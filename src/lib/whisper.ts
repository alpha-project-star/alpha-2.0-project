import { alphaStore } from "./alpha-store";

/**
 * Offline STT recognizer backed by an OpenAI-compatible Whisper server
 * (e.g. faster-whisper-server, whisper.cpp server).
 *
 * Public shape matches ContinuousRecognizer in voice.ts so it can be swapped
 * in transparently.
 */

type Handlers = {
  onInterim?: (t: string) => void;
  onFinal?: (t: string) => void;
  onStart?: () => void;
  onStop?: () => void;
  onError?: (msg: string) => void;
};

function endpoint(): string {
  return (alphaStore.get().settings.whisperEndpoint || "").trim().replace(/\/+$/, "") || "http://localhost:8001";
}
function model(): string {
  return alphaStore.get().settings.whisperModel || "Systran/faster-whisper-small";
}

export class WhisperRecognizer {
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

  get isActive() { return this.active; }
  get isWanted() { return this.wantOn; }
  get analyserNode(): AnalyserNode | null { return this.analyser; }

  setHandlers(h: Handlers) { this.handlers = h; }

  private pickMime(): string {
    const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const t of opts) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return "audio/webm";
  }

  async start() {
    if (typeof window === "undefined") return;
    this.wantOn = true;
    this.paused = false;
    if (this.active) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
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
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this.flushSegment();
    this.recorder.start(250);
  }

  private async flushSegment() {
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    // Only transcribe if there was actual speech AND enough audio (avoid tiny clicks).
    const shouldSend = this.hasSpeech && blob.size > 4000;
    // Immediately start recording the next window so we never miss speech.
    if (this.wantOn && !this.paused) this.beginSegment();
    if (!shouldSend) return;
    try {
      const form = new FormData();
      form.append("file", blob, "clip.webm");
      form.append("model", model());
      form.append("response_format", "json");
      form.append("language", (navigator.language || "en").slice(0, 2));
      const res = await fetch(`${endpoint()}/v1/audio/transcriptions`, { method: "POST", body: form });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        this.handlers.onError?.(`Whisper ${res.status}: ${t.slice(0, 160)}`);
        return;
      }
      const j: any = await res.json();
      const text: string = (j?.text || "").trim();
      if (text) this.handlers.onFinal?.(text);
    } catch (e: any) {
      this.handlers.onError?.(`Whisper unreachable: ${e?.message || e}`);
    }
  }

  /** Voice-activity loop: watches RMS to decide when to close a segment. */
  private loop = () => {
    if (!this.active || !this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    const SPEECH = 0.035;   // start-of-speech threshold
    const SILENCE = 0.02;   // end-of-speech threshold
    if (rms > SPEECH) {
      this.speechFrames++;
      this.silenceFrames = 0;
      if (this.speechFrames > 3) this.hasSpeech = true;
    } else if (rms < SILENCE) {
      this.silenceFrames++;
      this.speechFrames = 0;
    }
    // ~60 frames of silence ≈ 1s at 60fps. Close segment on trailing silence
    // after speech was detected.
    if (this.hasSpeech && this.silenceFrames > 55) {
      try { this.recorder?.state === "recording" && this.recorder.stop(); } catch {}
    }
    // Safety cap: force flush after ~15s
    if (this.recorder && this.recorder.state === "recording" && (this.chunks.length > 60)) {
      try { this.recorder.stop(); } catch {}
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  suspend() {
    this.paused = true;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    try { this.recorder?.state === "recording" && this.recorder.stop(); } catch {}
    // keep mic stream open so resume is instant
  }

  resume() {
    if (!this.wantOn) return;
    this.paused = false;
    if (!this.stream) { void this.start(); return; }
    this.beginSegment();
    this.loop();
  }

  stop() {
    this.wantOn = false;
    this.paused = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    try { this.recorder?.state === "recording" && this.recorder.stop(); } catch {}
    this.recorder = null;
    try { this.source?.disconnect(); } catch {}
    try { this.analyser?.disconnect(); } catch {}
    try { this.ctx?.close(); } catch {}
    this.source = null; this.analyser = null; this.ctx = null;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.active = false;
    this.handlers.onStop?.();
  }

  dispose() { this.stop(); }
}