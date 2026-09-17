/**
 * Vision Stream — singleton front-camera pipeline for the Cyber-Eye.
 *
 * Owns one hidden <video> + one <canvas> for the whole app. Exposes:
 *   • startEye() / stopEye() / isActive() / subscribe()
 *   • captureFrame(): base64 JPEG of the current video frame
 *   • subscribeBrightness(cb): ~5Hz sampled { luma, cx, cy, motion }
 *
 * All sampling is local; nothing leaves the device unless the caller
 * passes the captured frame to a network model.
 */

type FrameStats = {
  /** Mean luma 0..1 */ luma: number;
  /** Centroid x of bright pixels, -1..1 (0 = centered) */ cx: number;
  /** Centroid y of bright pixels, -1..1 (0 = centered) */ cy: number;
  /** Instantaneous motion 0..1 */ motion: number;
};

let video: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;
let sampleCanvas: HTMLCanvasElement | null = null;
let sampleCtx: CanvasRenderingContext2D | null = null;
let capCanvas: HTMLCanvasElement | null = null;
let sampleTimer: number | null = null;
let lastLuma: Uint8ClampedArray | null = null;

let currentStartId = 0;

const activeSubs = new Set<(active: boolean) => void>();
const statSubs = new Set<(s: FrameStats) => void>();
let currentStats: FrameStats = { luma: 0, cx: 0, cy: 0, motion: 0 };

function notifyActive(v: boolean) { for (const cb of activeSubs) { try { cb(v); } catch {} } }
function notifyStats(s: FrameStats) { for (const cb of statSubs) { try { cb(s); } catch {} } }

export function subscribeActive(cb: (active: boolean) => void): () => void {
  activeSubs.add(cb); cb(isActive()); return () => { activeSubs.delete(cb); };
}
export function subscribeBrightness(cb: (s: FrameStats) => void): () => void {
  statSubs.add(cb); cb(currentStats); return () => { statSubs.delete(cb); };
}
export function isActive(): boolean { return !!stream && !!video && !video.paused; }

export async function startEye(): Promise<void> {
  if (typeof window === "undefined") throw new Error("No window");
  if (isActive()) return;
  
  const startId = ++currentStartId;
  
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera not supported in this browser.");
  }
  
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });

  // Verify that we haven't been superseded or unmounted
  if (startId !== currentStartId) {
    for (const t of s.getTracks()) t.stop();
    throw new Error("Camera startup was superseded.");
  }

  stream = s;
  
  if (!video) {
    video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.muted = true;
    video.autoplay = true;
    video.style.position = "fixed";
    video.style.width = "1px"; video.style.height = "1px";
    video.style.opacity = "0"; video.style.pointerEvents = "none";
    video.style.left = "-10px"; video.style.top = "-10px";
    document.body.appendChild(video);
  }
  
  video.srcObject = stream;
  
  try {
    await video.play();
  } catch (err: any) {
    // Playback failed. Release everything cleanly and throw
    for (const t of s.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
    notifyActive(false);
    throw new Error(`Camera playback failed: ${err?.message || "unsupported browser background context"}`);
  }

  // Double check if we were cancelled during the async playback step
  if (startId !== currentStartId) {
    for (const t of s.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
    notifyActive(false);
    throw new Error("Camera startup cancelled.");
  }

  startSampling();
  notifyActive(true);
}

export function stopEye(): void {
  currentStartId = 0; // Invalidate any pending startEye
  if (sampleTimer != null) { clearInterval(sampleTimer); sampleTimer = null; }
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
  if (video) {
    try { video.pause(); } catch {}
    video.srcObject = null;
  }
  lastLuma = null;
  currentStats = { luma: 0, cx: 0, cy: 0, motion: 0 };
  notifyStats(currentStats);
  notifyActive(false);
}

function ensureSampleCanvas(): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!sampleCanvas) {
    sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 32; sampleCanvas.height = 24;
    sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  }
  return { c: sampleCanvas!, ctx: sampleCtx! };
}

function startSampling() {
  if (sampleTimer != null) return;
  sampleTimer = window.setInterval(() => {
    if (!video || video.readyState < 2) return;
    const { c, ctx } = ensureSampleCanvas();
    if (!ctx) return;
    try {
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      const luma = new Uint8ClampedArray(c.width * c.height);
      let sum = 0, weightSum = 0, wx = 0, wy = 0, motion = 0;
      for (let y = 0, i = 0, p = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++, p++, i += 4) {
          // Rec.709 luma
          const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) | 0;
          luma[p] = l;
          sum += l;
          if (lastLuma) motion += Math.abs(l - lastLuma[p]);
          // Weight bright regions for centroid (proxy for face highlight)
          const w = l > 110 ? (l - 110) : 0;
          if (w) { weightSum += w; wx += x * w; wy += y * w; }
        }
      }
      const n = c.width * c.height;
      const meanLuma = sum / n / 255;
      const cx = weightSum > 0 ? ((wx / weightSum) / (c.width - 1)) * 2 - 1 : 0;
      const cy = weightSum > 0 ? ((wy / weightSum) / (c.height - 1)) * 2 - 1 : 0;
      const mot = lastLuma ? Math.min(1, motion / (n * 40)) : 0;
      lastLuma = luma;
      currentStats = { luma: meanLuma, cx, cy, motion: mot };
      notifyStats(currentStats);
    } catch {
      /* ignore transient frame errors */
    }
  }, 200) as unknown as number;
}

/** Grab the current frame as a base64 data URL (JPEG). */
export function captureFrame(maxSide = 640, quality = 0.72): string | null {
  if (!video || video.readyState < 2) return null;
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(64, Math.round(vw * scale));
  const h = Math.max(64, Math.round(vh * scale));
  if (!capCanvas) capCanvas = document.createElement("canvas");
  capCanvas.width = w; capCanvas.height = h;
  const ctx = capCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  try { return capCanvas.toDataURL("image/jpeg", quality); } catch { return null; }
}

// Auto-stop on tab hidden / page unload for privacy.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isActive()) stopEye();
  });
  window.addEventListener("pagehide", () => { if (isActive()) stopEye(); });
}
