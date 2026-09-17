import { speakWith, prepareUtterance, stopSpeaking } from "./voice";
import { alertBus } from "./alerts";
import { alphaStore } from "./alpha-store";

/**
 * Background alarm audio, notification, and alert presentation engine.
 * Receives firing signals from the authoritative ReminderScheduler.
 * When a reminder fires:
 *   - plays a chime (WebAudio oscillator, no asset)
 *   - shows a system Notification (if permission granted)
 *   - speaks it via existing TTS
 *   - pulses the alert bus
 */

let started = false;
let audioCtx: AudioContext | null = null;

function ensureAudioContext() {
  if (typeof window === "undefined") return null;
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

function unlockAlarmAudio() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    void ctx.resume?.();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.02);
  } catch {}
}

function playChime() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    void ctx.resume?.();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(ctx.destination);
    const tones = [880, 1320, 990];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      og.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.03);
      og.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.28);
      o.connect(og).connect(g);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.3);
    });
    g.gain.setValueAtTime(1, ctx.currentTime);
  } catch {}
}

function notify(title: string, body: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      new Notification(`⏰ ${title}`, { body, tag: `alpha-${title}` });
    }
  } catch {}
}

export async function requestAlarmPermission(): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const p = await Notification.requestPermission();
    return p === "granted";
  } catch {
    return false;
  }
}

export function fireAlarm(title: string, notes = "") {
  if (typeof window === "undefined") return;
  const s = alphaStore.get().settings;
  const isMuted = !s.voiceEnabled;

  notify(title, notes || "Reminder from Alpha");
  try {
    alertBus.pulse();
  } catch {}

  if (isMuted) {
    return;
  }

  // Preempt any current speech so assistant speech and alarm audio do not overlap
  stopSpeaking();
  prepareUtterance();
  playChime();
  const line = notes
    ? `Excuse me — reminder: ${title}. ${notes}`
    : `Excuse me — reminder: ${title}.`;
  void speakWith(line);
}

export function isAlarmEngineStarted(): boolean {
  return started;
}

export function startAlarmEngine() {
  if (started) return;
  if (typeof window === "undefined") return;
  started = true;
  window.addEventListener("pointerdown", unlockAlarmAudio, { passive: true });
  window.addEventListener("keydown", unlockAlarmAudio);
}

export function stopAlarmEngine() {
  started = false;
  if (typeof window !== "undefined") {
    window.removeEventListener("pointerdown", unlockAlarmAudio);
    window.removeEventListener("keydown", unlockAlarmAudio);
  }
}

/** Fire a demo alarm right now — used by the Settings test button. */
export function testAlarmNow() {
  fireAlarm("Alpha alarm test", "If you're hearing this, the alarm engine is live.");
}

