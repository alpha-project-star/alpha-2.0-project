/**
 * Detects "look at me / what do you see / read this" style commands and
 * captures a live camera frame to attach to the chat turn.
 */
import { captureFrame, isActive, startEye, stopEye } from "./vision-stream";

/** Explicit "look now" phrasing. */
const RE = /\b(what\s+(?:do\s+)?you\s+see|what\s+(?:can\s+)?you\s+see|look\s+at\s+(?:me|this|that|my)|see\s+me|are\s+you\s+seeing|describe\s+(?:what|the|this|that)|who\s+is\s+(?:this|in\s+front)|read\s+(?:this|that|the\s+screen)|check\s+(?:my|this|that)|scan\s+(?:me|this|the\s+room)|take\s+a\s+look)\b/i;

/** Deictic / self-referential phrasing. */
const DEICTIC = /(\bthis\b|\bthese\b|\bthat\b|\bhere\b|\bmy\b|\bme\b|\bi\s+look\b|\bi'm\s+wearing\b|\bam\s+i\b|\bhow\s+do\s+i\b|\bwhat'?s?\s+on\b|\bwhat\s+is\s+on\b|\bwhat\s+colou?r\b|\bdoes\s+it\b|\bdo\s+they\b|\bwearing\b|\bholding\b|\bpointing\b)/i;

/** Questions/requests only — don't hijack plain statements. */
const ASKING = /(\?|^\s*(what|who|which|where|how|does|do|is|are|can|could|should|read|describe|tell|check|look|scan|rate|compare|find)\b)/i;

const ORDINARY_EYE_WORDS = /\b(hurt|pain|icon|storm|symbol|meaning|like\s+your|brown\s+eyes|blue\s+eyes|green\s+eyes|eye\s+of)\b/i;

export function isVisionCommand(text: string): boolean {
  return !!text && RE.test(text);
}

/**
 * Should this turn attach a live camera frame?
 * - If uploaded images exist -> false
 * - If eye is inactive and NOT a combined open-eye command -> false (vision request alone must not activate Eye)
 * - If eye is active or combined -> yes when RE or ASKING+DEICTIC matches
 */
export function shouldCaptureFrame(text: string, eyeLive: boolean, hasUploadedImages: boolean = false): boolean {
  if (!text) return false;
  if (hasUploadedImages) return false;
  
  const isCombinedOpen = /(?:open|turn\s+on)\s+(?:your\s+)?eyes?\b/i.test(text) && RE.test(text);
  if (isCombinedOpen) return true;

  if (!eyeLive) return false;
  if (RE.test(text)) return true;
  return ASKING.test(text) && DEICTIC.test(text);
}

const OPEN_EYE_PATTERNS = /^(?:alpha,?\s*)?(?:open|turn\s+on|start|activate|enable)\s+(?:your\s+|the\s+)?(?:eyes?|camera)\b/i;
const CLOSE_EYE_PATTERNS = /^(?:alpha,?\s*)?(?:close|shut|turn\s+off|stop|deactivate|disable)\s+(?:your\s+|the\s+)?(?:eyes?|camera)\b/i;

/** Explicit Eye state control handler with idempotency and safety. */
export async function handleEyeCommand(text: string): Promise<string | null> {
  const t = (text || "").trim();
  if (ORDINARY_EYE_WORDS.test(t)) return null;

  const isOpenCmd = OPEN_EYE_PATTERNS.test(t);
  const isCloseCmd = CLOSE_EYE_PATTERNS.test(t);
  const isCombined = (isOpenCmd || isCloseCmd) && isVisionCommand(t);

  if (isCombined) {
    if (isOpenCmd && !isActive()) {
      try { await startEye(); await new Promise((r) => setTimeout(r, 350)); } catch {}
    }
    if (isCloseCmd && isActive()) {
      stopEye();
    }
    return null;
  }

  if (isOpenCmd) {
    if (isActive()) {
      return "My eyes are already open.";
    }
    try {
      await startEye();
      return "Opening my eyes.";
    } catch (e: any) {
      return `I couldn't open my eyes — ${e?.message || "camera permission was denied or camera is unavailable."}`;
    }
  }

  if (isCloseCmd) {
    if (!isActive()) {
      return "My eyes are already closed.";
    }
    try {
      stopEye();
      return "Closing my eyes.";
    } catch (e: any) {
      return `I couldn't close my eyes properly: ${e?.message || "unknown error."}`;
    }
  }

  return null;
}

/** Ensure the eye is on (if forced) and capture a frame. Returns base64 data URL. */
export async function captureLiveFrame(forceStart = false): Promise<string | null> {
  let startedLocally = false;
  if (!isActive()) {
    if (!forceStart) return null;
    try {
      await startEye();
      startedLocally = true;
      await new Promise((r) => setTimeout(r, 350));
    } catch {
      return null;
    }
  }
  const frame = captureFrame(640, 0.72);
  if (startedLocally) {
    stopEye();
  }
  return frame;
}
