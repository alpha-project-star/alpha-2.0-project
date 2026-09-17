/**
 * Image helpers for chat uploads.
 *
 * Phones produce 4-12 MP JPEGs. Sending those raw as base64 in a chat payload
 * makes the request many megabytes, which makes vision providers stall or
 * silently drop the turn (the "Alpha keeps thinking" bug). Every uploaded or
 * captured image is downscaled + re-encoded before it ever reaches the model.
 */

const MAX_SIDE = 1024;
const QUALITY = 0.78;

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/** Downscale a data URL to <=MAX_SIDE on its longest edge, re-encoded as JPEG. */
export async function shrinkDataUrl(
  dataUrl: string,
  maxSide = MAX_SIDE,
  quality = QUALITY,
): Promise<string> {
  if (typeof document === "undefined") return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return dataUrl;
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    // Already small AND already reasonably light — keep as-is.
    if (scale === 1 && dataUrl.length < 400_000) return dataUrl;
    const w = Math.max(32, Math.round(w0 * scale));
    const h = Math.max(32, Math.round(h0 * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

/** Read + downscale a picked File in one step. */
export async function fileToShrunkDataUrl(file: File): Promise<string> {
  return shrinkDataUrl(await fileToDataUrl(file));
}
