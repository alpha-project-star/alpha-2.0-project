import { normalizeForSpeech } from "./speech-text";
import { alphaStore } from "./alpha-store";
import { activity } from "./activity";
import { SpeechManager } from "./audio-subsystem/speech-manager";
import { TTSManager } from "./audio-subsystem/tts-manager";
import { ExecutionId } from "./audio-subsystem/types";
import { WhisperRecognizer } from "./whisper";
import { GroqWhisperRecognizer } from "./groq-whisper";

// ============================================================
// Speaking pub-sub (now managed by SpeechManager)
// ============================================================
const speechManager = SpeechManager.getInstance();
const ttsManager = TTSManager.getInstance();

export const speakingState = {
  get: () => speechManager.getState() === 'SPEAKING',
  sub: (fn: (v: boolean) => void): (() => void) => {
    const listener = { onStateChange: (state: string) => fn(state === 'SPEAKING') };
    const unsub = speechManager.addListener(listener);
    fn(speechManager.getState() === 'SPEAKING');
    return unsub;
  },
};

function setSpeaking(v: boolean, id?: ExecutionId) {
  speechManager.setState(v ? 'SPEAKING' : 'IDLE', id);
}

// ... rest of the file ...

// Pause configuration (in milliseconds)
const PAUSES = {
  comma: 200,
  semicolon: 300,
  colon: 300,
  sentence: 500,
  paragraph: 800,
  heading: 1000,
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getPauseForChunk(chunk: string): number {
  if (/[.!?]$/.test(chunk)) return PAUSES.sentence;
  if (/[;:]$/.test(chunk)) return PAUSES.semicolon;
  if (/[,]$/.test(chunk)) return PAUSES.comma;
  return 0; // Default
}

function pickVoice(): SpeechSynthesisVoice | null {
  return ttsManager.pickVoice();
}

/** Call inside a user gesture (tap) to unlock both speech & audio on Android. */
export function prepareUtterance() {
  ttsManager.prepareUtterance();
}

let lastWorkingKokoroUrl: string | null = null;

export interface KokoroCandidate {
  url: string;
  body: Record<string, any>;
}

export interface KokoroDiagnostics {
  ok: boolean;
  workingUrl?: string;
  blobSize?: number;
  audio?: HTMLAudioElement;
  tried: Array<{ url: string; status?: number; error?: string }>;
  suggestedEndpoint?: string;
  error?: string;
  wasFallback?: boolean;
}

export function getKokoroCandidates(
  rawEndpoint: string,
  text: string,
  voice: string,
  speed = 1,
): KokoroCandidate[] {
  const raw = rawEndpoint.trim();
  if (!raw) return [];

  let origin = raw;
  try {
    origin = new URL(raw).origin;
  } catch {}

  // Unified payload containing fields for both FastAPI (/tts) and OpenAI (/v1/audio/speech)
  const body = {
    text,
    input: text,
    model: "kokoro",
    voice,
    response_format: "mp3",
    output_format: "mp3",
    speed,
  };

  const urls: string[] = [];

  // Prioritize the last verified working URL on this origin to eliminate 404 retry latency
  if (lastWorkingKokoroUrl && (lastWorkingKokoroUrl === raw || lastWorkingKokoroUrl.startsWith(origin))) {
    urls.push(lastWorkingKokoroUrl);
  }

  // Add the user-configured endpoint
  urls.push(raw);

  // Add standard alternative endpoints on this origin
  urls.push(`${origin}/tts`);
  urls.push(`${origin}/v1/audio/speech`);
  urls.push(`${origin}/audio/speech`);

  // Deduplicate while maintaining preference order
  const seen = new Set<string>();
  const candidates: KokoroCandidate[] = [];
  for (const u of urls) {
    if (!seen.has(u)) {
      seen.add(u);
      candidates.push({ url: u, body });
    }
  }
  return candidates;
}

export async function testKokoroTTS(
  sampleText = "Mm — hi. This is Alpha. Voice check, one two.",
  opts?: { endpoint?: string; voice?: string; speed?: number },
): Promise<KokoroDiagnostics> {
  const endpoint = (opts?.endpoint ?? alphaStore.get().settings.kokoroEndpoint).trim();
  const voice = opts?.voice ?? alphaStore.get().settings.kokoroVoice ?? "am_michael";
  const speed = opts?.speed ?? alphaStore.get().settings.ttsRate ?? 1;

  if (!endpoint) {
    return { ok: false, tried: [], error: "No endpoint configured." };
  }

  const candidates = getKokoroCandidates(endpoint, sampleText, voice, speed);
  const tried: Array<{ url: string; status?: number; error?: string }> = [];

  for (const c of candidates) {
    try {
      const res = await fetch(c.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c.body),
      });

      if (!res.ok) {
        tried.push({ url: c.url, status: res.status });
        continue;
      }

      const ct = res.headers.get("content-type") || "";
      if (!/audio|octet-stream/i.test(ct)) {
        tried.push({ url: c.url, status: res.status, error: `Non-audio content-type: ${ct}` });
        continue;
      }

      const blob = await res.blob();
      if (!blob.size) {
        tried.push({ url: c.url, status: res.status, error: "Empty audio body" });
        continue;
      }

      lastWorkingKokoroUrl = c.url;
      const audio = new Audio(URL.createObjectURL(blob));

      return {
        ok: true,
        workingUrl: c.url,
        blobSize: blob.size,
        audio,
        tried,
        wasFallback: c.url !== endpoint,
        suggestedEndpoint: c.url !== endpoint ? c.url : undefined,
      };
    } catch (err: any) {
      tried.push({ url: c.url, error: err?.message || String(err) });
    }
  }

  return {
    ok: false,
    tried,
    error: tried.map((t) => `${t.url} → ${t.status ? `HTTP ${t.status}` : t.error}`).join("; "),
  };
}

async function tryKokoro(text: string): Promise<HTMLAudioElement | null> {
  const { kokoroEndpoint } = alphaStore.get().settings;
  if (!kokoroEndpoint || !kokoroEndpoint.trim()) return null;

  try {
    const diag = await testKokoroTTS(text);
    if (diag.ok && diag.audio) {
      return diag.audio;
    }
    throw new Error(diag.error || "All Kokoro attempts failed");
  } catch (e) {
    console.warn("[voice] Kokoro failed, falling back to browser TTS:", e);
    try {
      window.dispatchEvent(
        new CustomEvent("kokoro-fail", { detail: String((e as any)?.message || e) }),
      );
    } catch {}
    return null;
  }
}

/**
 * Chunk for low-latency streaming TTS. The FIRST chunk is deliberately tiny
 * (~60 chars, cut at the earliest sentence/clause boundary) so the user
 * hears audio within a few hundred ms. Subsequent chunks are larger to
 * minimise gaps.
 */
function chunkForTTS(text: string, firstMax = 80, restMax = 220): string[] {
  const out: string[] = [];
  const sentences = text.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) ?? [text];
  // First: earliest natural stop under firstMax.
  const head = sentences[0]?.trim() ?? "";
  let rest = "";
  if (head.length <= firstMax) {
    out.push(head);
    rest = sentences.slice(1).join(" ").trim();
  } else {
    const cut =
      head
        .slice(0, firstMax)
        .match(/^.*[,;:—-]\s/)?.[0]
        ?.trim() ||
      head.slice(0, firstMax).match(/^.*\s/)?.[0]?.trim() ||
      head.slice(0, firstMax);
    out.push(cut);
    rest = (head.slice(cut.length) + " " + sentences.slice(1).join(" ")).trim();
  }
  // Remaining: pack into restMax chunks.
  const restSentences = rest.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) ?? (rest ? [rest] : []);
  let buf = "";
  for (const s of restSentences) {
    const t = s.trim();
    if (!t) continue;
    if (t.length > restMax) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      const parts = t.match(new RegExp(`.{1,${restMax}}(\\s|,|;|:|$)`, "g")) ?? [t];
      for (const p of parts) out.push(p.trim());
      continue;
    }
    if ((buf + " " + t).trim().length > restMax) {
      out.push(buf);
      buf = t;
    } else {
      buf = buf ? buf + " " + t : t;
    }
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

async function browserSpeak(text: string): Promise<void> {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    !window.speechSynthesis
  ) {
    // WebView (e.g. LovableApp on Android) has no speechSynthesis — use network fallback.
    await networkSpeak(text);
    return;
  }
  await ttsManager.speakBrowser(text);
}

/**
 * Network TTS fallback for environments without window.speechSynthesis
 * (Android WebView / LovableApp). Uses StreamElements' free CORS-enabled
 * endpoint with a British male voice.
 */
async function networkSpeak(text: string): Promise<void> {
  try {
    const voice = "Brian"; // British male; matches Alpha's persona
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text.slice(0, 500))}`;
    await ttsManager.speak(url);
  } catch (e) {
    console.warn("[voice] network TTS failed:", e);
  }
}

/**
 * Speak text. Suspends STT for the duration so Alpha doesn't hear itself.
 * Falls back to browser male voice if Kokoro endpoint isn't set / fails.
 */
let speakToken = 0;
let currentAudio: HTMLAudioElement | null = null;

function playAudio(audio: HTMLAudioElement): Promise<boolean> {
  return new Promise((resolve) => {
    let played = false;
    audio.onended = () => resolve(played);
    audio.onerror = () => resolve(played);
    const p = audio.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        played = true;
      }).catch(() => resolve(false));
    } else {
      played = true;
    }
  });
}

/**
 * Speak text aloud. Pass `{ auto: true }` for automatic reply narration — that
 * path is additionally gated by the `autoSpeak` setting. Manual Speak buttons
 * call this without options and always work while voice output is enabled.
 */
export async function speakWith(text: string, opts?: { auto?: boolean }): Promise<void> {
  const s = alphaStore.get().settings;
  if (!s.voiceEnabled) return;
  if (opts?.auto && s.autoSpeak === false) return;
  const clean = normalizeForSpeech(text);
  if (!clean) return;
  stopSpeaking();
  const myToken = ++speakToken;
  setSpeaking(true);
  activity.set("preparing_voice");
  const wasListening = recognizer.isWanted;
  if (wasListening) recognizer.suspend();

  try {
    const { kokoroEndpoint } = alphaStore.get().settings;
    // Fast path: no Kokoro configured → speak the head chunk immediately,
    // then feed the tail. This starts audio in <300ms instead of waiting
    // for the whole reply to be synthesised at once.
    if (!kokoroEndpoint || !kokoroEndpoint.trim()) {
      const chunks = chunkForTTS(clean);
      for (const c of chunks) {
        if (myToken !== speakToken) return;
        activity.set("speaking");
        await browserSpeak(c);
      }
      return;
    }

    // Pipeline: split into chunks, fetch next while playing current.
    const chunks = chunkForTTS(clean);
    let nextFetch: Promise<HTMLAudioElement | null> = tryKokoro(chunks[0]);
    let kokoroBroken = false;

    for (let i = 0; i < chunks.length; i++) {
      if (myToken !== speakToken) return; // cancelled by a newer speakWith / stopSpeaking
      const audioP = nextFetch;
      // pre-fetch the next chunk in parallel
      nextFetch =
        i + 1 < chunks.length && !kokoroBroken ? tryKokoro(chunks[i + 1]) : Promise.resolve(null);

      const audio = await audioP;
      if (myToken !== speakToken) return;
      if (!audio) {
        kokoroBroken = true;
        activity.set("speaking");
        await browserSpeak(chunks[i]);
        continue;
      }
      currentAudio = audio;
      activity.set("speaking");
      const played = await playAudio(audio);
      currentAudio = null;
      if (myToken !== speakToken) return;
      if (!played) {
        // autoplay blocked — fall back for remaining chunks
        kokoroBroken = true;
        activity.set("speaking");
        await browserSpeak(chunks[i]);
      }
      // Prosody: Inject pause after chunk
      const pause = getPauseForChunk(chunks[i]);
      if (pause > 0) {
        activity.set("speaking"); // Or maybe "paused"
        await delay(pause);
      }
    }
  } finally {
    if (myToken === speakToken) {
      setSpeaking(false);
      activity.clear();
      if (wasListening) {
        setTimeout(() => {
          if (recognizer.isWanted) recognizer.resume();
        }, 350);
      }
    }
  }
}

export function stopSpeaking() {
  speakToken++;
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {}
    currentAudio = null;
  }
  ttsManager.cancel();
  setSpeaking(false);
  activity.set("stopping_speech");
  setTimeout(() => {
    if (activity.get().kind === "stopping_speech") activity.clear();
  }, 300);
}

export function listVoices(): SpeechSynthesisVoice[] {
  return ttsManager.listVoices();
}

// ============================================================
// STT — half-duplex aware
// ============================================================
export class ContinuousRecognizer {
  private rec: any = null;
  private active = false;
  private wantOn = false;
  private paused = false; // suspended while Alpha speaks
  private restartTimer: number | null = null;
  private silenceTimer: number | null = null;
  private interimBuf = "";
  private handlers: RecHandlers = {};
  private sessionId = 0;

  get isActive() {
    return this.active;
  }
  get isWanted() {
    return this.wantOn;
  }
  get analyserNode(): AnalyserNode | null {
    return null;
  }

  setHandlers(h: RecHandlers) {
    this.handlers = h;
  }

  private lang() {
    if (typeof navigator === "undefined") return "en-US";
    return navigator.language?.trim() || "en-US";
  }

  private build() {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return null;
    const isAndroid = /android/i.test(navigator.userAgent);
    const rec = new SR();
    rec.continuous = !isAndroid;
    rec.interimResults = true;
    rec.lang = this.lang();
    const mySessionId = ++this.sessionId;

    rec.onstart = () => {
      if (mySessionId !== this.sessionId) return;
      this.active = true;
      speechManager.setState('LISTENING');
      activity.set("listening");
      this.handlers.onStart?.();
    };
    rec.onend = () => {
      if (mySessionId !== this.sessionId) return;
      this.active = false;
      if (speechManager.getState() === 'LISTENING') speechManager.setState('IDLE');
      if (activity.get().kind === "listening") activity.clear();
      if (!this.wantOn || this.paused) {
        if (!this.wantOn) this.handlers.onStop?.();
        return;
      }
      this.restartTimer = window.setTimeout(
        () => {
          this.restartTimer = null;
          if (mySessionId !== this.sessionId) return;
          if (!this.wantOn || this.paused) return;
          try {
            rec.start();
          } catch (err: any) {
            // try with a fresh instance
            this.rec = this.build();
            try {
              this.rec?.start();
            } catch (e: any) {
              this.wantOn = false;
              this.handlers.onError?.(
                e?.message || err?.message || "Could not restart recognition",
              );
              this.handlers.onStop?.();
            }
          }
        },
        isAndroid ? 250 : 50,
      );
    };
    rec.onerror = (e: any) => {
      if (mySessionId !== this.sessionId) return;
      const err = String(e?.error || "speech error");
      if (err === "no-speech" || err === "aborted") return;
      if (err === "not-allowed" || err === "service-not-allowed") {
        this.wantOn = false;
        this.handlers.onError?.("Microphone permission denied or blocked");
        return;
      }
      if (err === "audio-capture") {
        this.wantOn = false;
        this.handlers.onError?.("No microphone audio captured");
        return;
      }
      this.handlers.onError?.(err);
    };
    rec.onresult = (e: any) => {
      if (mySessionId !== this.sessionId) return;
      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) {
        this.interimBuf = interim;
        this.handlers.onInterim?.(interim);
        this.armSilence(mySessionId);
      }
      if (finalText.trim()) {
        const t = finalText.trim();
        this.interimBuf = "";
        if (this.silenceTimer) {
          window.clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
        this.handlers.onFinal?.(t);
      }
    };
    return rec;
  }

  start() {
    if (typeof window === "undefined") return;
    this.wantOn = true;
    this.paused = false;
    if (this.active) return;
    this.sessionId++;
    this.rec = this.build();
    if (!this.rec) {
      this.handlers.onError?.("Speech recognition not supported");
      return;
    }
    try {
      this.rec.start();
    } catch (err: any) {
      this.handlers.onError?.(err?.message || "Could not start recognition");
    }
  }

  /** Pause without forgetting we want to be on — used while Alpha speaks. */
  suspend() {
    this.paused = true;
    this.sessionId++;
    if (this.restartTimer) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.silenceTimer) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.interimBuf = "";
    try {
      this.rec?.abort?.();
    } catch {}
    this.active = false;
    if (activity.get().kind === "listening") activity.clear();
  }

  resume() {
    if (!this.wantOn) return;
    this.paused = false;
    if (this.active) return;
    this.sessionId++;
    this.rec = this.build();
    if (!this.rec) return;
    try {
      this.rec.start();
    } catch (e: any) {
      this.handlers.onError?.(e?.message || "Could not resume");
    }
  }

  private armSilence(session: number) {
    if (this.silenceTimer) window.clearTimeout(this.silenceTimer);
    this.silenceTimer = window.setTimeout(() => {
      if (session !== this.sessionId) return;
      const t = this.interimBuf.trim();
      this.interimBuf = "";
      if (t) this.handlers.onFinal?.(t);
    }, 1300);
  }

  stop() {
    this.wantOn = false;
    this.paused = false;
    this.sessionId++;
    if (this.restartTimer) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.silenceTimer) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.interimBuf = "";
    try {
      this.rec?.abort?.();
    } catch {}
    try {
      this.rec?.stop?.();
    } catch {}
    this.active = false;
    if (speechManager.getState() === 'LISTENING') speechManager.setState('IDLE');
    if (activity.get().kind === "listening") activity.clear();
  }

  dispose() {
    this.stop();
    this.rec = null;
  }
}

// The single browser-based recognizer instance (Web Speech API).
const browserRec = new ContinuousRecognizer();

// ============================================================
// Backend-aware recognizer facade
// ============================================================
// All UI code imports `recognizer` from here. Under the hood we route to
// either the browser recognizer (Web Speech API — online-only on
// Chrome/Android) or the local WhisperRecognizer based on user settings.
// ============================================================
export type RecHandlers = {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onStart?: () => void;
  onStop?: () => void;
  onError?: (err: string) => void;
};

type AnyRec = {
  setHandlers: (h: RecHandlers) => void;
  start: () => void | Promise<void>;
  stop: () => void;
  suspend: () => void;
  resume: () => void;
  readonly isWanted: boolean;
  readonly isActive: boolean;
  readonly analyserNode: AnalyserNode | null;
};

let _whisper: WhisperRecognizer | null = null;
let _groq: GroqWhisperRecognizer | null = null;
let _handlers: RecHandlers = {};
let _current: AnyRec | null = null;

function browserSttSupported(): boolean {
  if (typeof window === "undefined") return false;
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

function pickBackend(): "browser" | "whisper" | "groq" {
  const pref = alphaStore.get().settings.sttBackend;
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  const hasGroq = !!(alphaStore.get().settings.groqApiKey || "").trim();
  const hasWhisper = !!(alphaStore.get().settings.whisperEndpoint || "").trim();
  if (pref === "whisper") return hasWhisper ? "whisper" : hasGroq && online ? "groq" : "whisper";
  if (pref === "browser")
    return browserSttSupported() ? "browser" : hasGroq && online ? "groq" : "whisper";
  // auto: Web Speech → Groq Whisper (cloud, uses existing key) → local Whisper server
  if (online && browserSttSupported()) return "browser";
  if (online && hasGroq) return "groq";
  return "whisper";
}

function pickInstance(kind: "browser" | "whisper" | "groq"): AnyRec {
  if (kind === "groq") {
    if (!_groq) _groq = new GroqWhisperRecognizer();
    _groq.setHandlers(_handlers);
    return _groq as unknown as AnyRec;
  }
  if (kind === "whisper") {
    if (!_whisper) _whisper = new WhisperRecognizer();
    _whisper.setHandlers(_handlers);
    return _whisper as unknown as AnyRec;
  }
  browserRec.setHandlers(_handlers);
  return browserRec as unknown as AnyRec;
}

export const recognizer = {
  setHandlers(h: RecHandlers) {
    _handlers = h;
    if (_current) _current.setHandlers(h);
  },
  start() {
    const kind = pickBackend();
    if (kind === "whisper") {
      const ep = (alphaStore.get().settings.whisperEndpoint || "").trim();
      const isDefaultLocal =
        !ep || /^https?:\/\/localhost/i.test(ep) || /^https?:\/\/127\./.test(ep);
      const hasGroq = !!(alphaStore.get().settings.groqApiKey || "").trim();
      if (!browserSttSupported() && isDefaultLocal && !hasGroq) {
        _handlers.onError?.(
          "Voice input isn't available yet — add your Groq API key in Settings → Online (free STT via Groq Whisper), or point Settings → Offline at a Whisper server.",
        );
        return;
      }
    }
    const currentKind: string =
      _current === (browserRec as any)
        ? "browser"
        : _current === (_whisper as any)
          ? "whisper"
          : _current === (_groq as any)
            ? "groq"
            : "";
    const needSwap = _current && currentKind !== kind;
    if (needSwap) {
      try {
        _current!.stop();
      } catch {}
      _current = null;
    }
    if (!_current) _current = pickInstance(kind);
    void _current.start();
  },
  stop() {
    try {
      _current?.stop();
    } catch {}
  },
  dispose() {
    try {
      _current?.stop();
    } catch {}
    _current = null;
  },
  suspend() {
    try {
      _current?.suspend();
    } catch {}
  },
  resume() {
    try {
      _current?.resume();
    } catch {}
  },
  get isWanted() {
    return !!_current?.isWanted;
  },
  get isActive() {
    return !!_current?.isActive;
  },
  get analyserNode() {
    return _current?.analyserNode ?? null;
  },
};
