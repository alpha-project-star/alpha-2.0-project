import { useEffect, useState, type ReactNode } from "react";

const PASS_KEY = "alpha.lock.passhash.v1";
const UNLOCKED_KEY = "alpha.lock.session.v1";

async function sha256(text: string) {
  const buf = new TextEncoder().encode(text);
  const out = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(out))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true
  );
}

export function AlphaLock({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [hasPass, setHasPass] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Skip lock in non-PWA contexts (dev/preview/desktop browser)
    if (!isStandalone()) {
      setUnlocked(true);
      setReady(true);
      return;
    }
    const sess = window.sessionStorage.getItem(UNLOCKED_KEY) === "1";
    setHasPass(!!window.localStorage.getItem(PASS_KEY));
    setUnlocked(sess);
    setReady(true);
  }, []);

  if (!ready) return null;
  if (unlocked) return <>{children}</>;

  async function tryBiometric() {
    if (!("credentials" in navigator) || !window.PublicKeyCredential) return;
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await (navigator.credentials as any).get({
        publicKey: { challenge, timeout: 30000, userVerification: "required" },
      });
      window.sessionStorage.setItem(UNLOCKED_KEY, "1");
      setUnlocked(true);
    } catch {
      /* user can still type password */
    }
  }

  async function setPassword() {
    if (pw.length < 6) return setErr("Use at least 6 characters.");
    if (pw !== confirm) return setErr("Passwords don't match.");
    window.localStorage.setItem(PASS_KEY, await sha256(pw));
    window.sessionStorage.setItem(UNLOCKED_KEY, "1");
    setUnlocked(true);
  }
  async function checkPassword() {
    const stored = window.localStorage.getItem(PASS_KEY);
    if (stored && (await sha256(pw)) === stored) {
      window.sessionStorage.setItem(UNLOCKED_KEY, "1");
      setUnlocked(true);
    } else setErr("Incorrect password.");
  }

  return (
    <div className="starfield min-h-screen flex items-center justify-center p-6">
      <div className="glass rounded-2xl p-8 max-w-sm w-full text-center">
        <h1 className="text-3xl font-bold neon-text mb-2">ALPHA</h1>
        <p className="text-muted-foreground text-sm mb-6">
          {hasPass ? "Unlock to continue" : "Create a passcode"}
        </p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setErr("");
          }}
          placeholder="Passcode"
          className="w-full bg-input rounded-lg px-4 py-3 mb-3 border border-border outline-none focus:border-primary"
        />
        {!hasPass && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm"
            className="w-full bg-input rounded-lg px-4 py-3 mb-3 border border-border outline-none focus:border-primary"
          />
        )}
        {err && <div className="text-destructive text-sm mb-2">{err}</div>}
        <button
          onClick={hasPass ? checkPassword : setPassword}
          className="w-full rounded-lg bg-primary text-primary-foreground py-3 font-semibold neon-border"
        >
          {hasPass ? "Unlock" : "Set passcode"}
        </button>
        {hasPass && (
          <button
            onClick={tryBiometric}
            className="w-full mt-3 text-sm text-accent-foreground/80 underline"
          >
            Use biometric
          </button>
        )}
      </div>
    </div>
  );
}
