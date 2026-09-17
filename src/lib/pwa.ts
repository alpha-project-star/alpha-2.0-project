/**
 * Guarded service-worker registration for Alpha.
 * Follows the built-in Lovable PWA skill:
 *   - never registers in dev / iframe / Lovable preview
 *   - honours `?sw=off` as a kill switch
 *   - single call site (invoked from src/routes/__root.tsx after hydration)
 */
export function registerAlphaPWA() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const host = window.location.hostname;
  const looksLikePreview =
    host.startsWith("id-preview--") ||
    host.startsWith("preview--") ||
    host === "lovableproject.com" || host.endsWith(".lovableproject.com") ||
    host === "lovableproject-dev.com" || host.endsWith(".lovableproject-dev.com") ||
    host === "beta.lovable.dev" || host.endsWith(".beta.lovable.dev");
  const killSwitch = new URL(window.location.href).searchParams.get("sw") === "off";

  const shouldRefuse = !import.meta.env.PROD || inIframe || looksLikePreview || killSwitch;

  if (shouldRefuse) {
    // Actively evict any previously-registered SW so preview doesn't get stuck.
    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const r of regs) {
        const url = r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL || "";
        if (url.endsWith("/sw.js")) { try { r.unregister(); } catch {} }
      }
    }).catch(() => {});
    return;
  }

  // Real production origin — register.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(err => {
      console.warn("[Alpha PWA] SW registration failed:", err);
    });
  });
}