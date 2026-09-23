import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AlphaOrb } from "../components/AlphaOrb";
import { LiveTranscript } from "../components/LiveTranscript";
import { recognizer, prepareUtterance, speakWith, stopSpeaking, speakingState } from "../lib/voice";
import { parseIntent } from "../lib/voice-router";
import { sendChat } from "../lib/alpha.functions";
import { alphaStore, uid, useAlpha } from "../lib/alpha-store";
import {
  Settings as SettingsIcon,
  MessageSquare,
  ChevronDown,
  NotebookPen,
  Wallet,
  ImageIcon,
  Bell,
  Map,
  Brain,
  Eye,
  EyeOff,
} from "lucide-react";
import { startEye, stopEye, subscribeActive as subEyeActive } from "../lib/vision-stream";
import { captureLiveFrame, handleEyeCommand, isVisionCommand } from "../lib/vision-command";
import { startVisionAmbient, stopVisionAmbient } from "../lib/vision-ambient";
import { DesktopShell } from "../components/desktop/DesktopShell";
import { DesktopHomePanel } from "../components/desktop/DesktopHomePanel";
import { KittScanner } from "../components/KittScanner";
import { useActivity, activity } from "../lib/activity";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Alpha — Cosmic AI Companion" },
      { name: "description", content: "A voice-first AI companion. Listen, ask, navigate." },
      { property: "og:title", content: "Alpha — Cosmic AI Companion" },
      { property: "og:description", content: "A voice-first AI companion." },
    ],
  }),
  component: OrbHome,
});

function OrbHome() {
  const router = useRouter();
  const act = useActivity();
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState("Tap the orb to begin");
  const [active, setActive] = useState(false);
  const [micError, setMicError] = useState("");
  const hasUsableBrain = useAlpha(
    (s) => !!(s.settings.groqApiKey || s.settings.openaiCompatKey || s.settings.openRouterKey),
  );
  const bgEnabled = useAlpha((s) => s.settings.backgroundEnabled);
  const thinkingRef = useRef(false);
  const lastVoiceRef = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });
  const [speaking, setSpeaking] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [eyeOn, setEyeOn] = useState(false);
  const [eyeError, setEyeError] = useState("");
  const ambient = useAlpha((s) => s.settings.visionAmbientEnabled);

  useEffect(() => speakingState.sub(setSpeaking), []);
  useEffect(
    () => () => {
      recognizer.dispose();
      stopSpeaking();
      stopEye();
    },
    [],
  );
  useEffect(() => subEyeActive(setEyeOn), []);
  useEffect(() => {
    if (eyeOn && ambient) startVisionAmbient();
    else stopVisionAmbient();
    return () => stopVisionAmbient();
  }, [eyeOn, ambient]);

  async function toggleEye() {
    setEyeError("");
    if (eyeOn) {
      stopEye();
      return;
    }
    try {
      await startEye();
    } catch (e: any) {
      setEyeError(e?.message || "Camera unavailable.");
    }
  }

  async function handleFinal(text: string) {
    if (thinkingRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Discard rapid double voice submissions
    const now = Date.now();
    if (trimmed === lastVoiceRef.current.text && now - lastVoiceRef.current.ts < 1000) {
      return;
    }
    lastVoiceRef.current = { text: trimmed, ts: now };

    const intent = parseIntent(trimmed);
    if (intent.kind === "navigate") {
      setStatus(`Opening ${intent.to.slice(1) || "home"}…`);
      router.navigate({ to: intent.to });
      return;
    }
    if (intent.kind === "stop") {
      recognizer.stop();
      setActive(false);
      setStatus("Paused");
      return;
    }

    thinkingRef.current = true;
    const wasListening = recognizer.isWanted;
    if (wasListening) recognizer.suspend();

    try {
      setStatus("Thinking…");
      let outImages: string[] | undefined;
      if (isVisionCommand(trimmed)) {
        const frame = await captureLiveFrame();
        if (frame) outImages = [frame];
      }
      await alphaStore.appendChat({ id: uid(), role: "user", text: trimmed, images: outImages, ts: Date.now() });

      if (!hasUsableBrain && outImages) {
        setStatus("No model key — opening settings");
        router.navigate({ to: "/settings" });
        return;
      }

      const reply = await sendChat(alphaStore.get().chat, { task: outImages ? "auto" : "fast" });
      await alphaStore.appendChat({ id: uid(), role: "model", text: reply, ts: Date.now() });
      setStatus("Speaking…");
      await speakWith(reply);
      setStatus(recognizer.isWanted ? "Listening…" : "Tap the orb to begin");
    } catch (e: any) {
      const msg = e?.message || "Error";
      await alphaStore.appendChat({ id: uid(), role: "system", text: msg, ts: Date.now(), error: true });
      setStatus(msg.slice(0, 80));
    } finally {
      thinkingRef.current = false;
      // Give a small grace window then resume listening
      if (wasListening)
        setTimeout(() => {
          if (recognizer.isWanted) recognizer.resume();
        }, 500);
    }
  }

  async function toggleMic() {
    prepareUtterance();
    if (active) {
      recognizer.stop();
      setActive(false);
      setStatus("Paused");
      stopSpeaking();
      return;
    }
    setMicError("");
    recognizer.setHandlers({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => {
        setInterim("");
        handleFinal(t);
      },
      onStart: () => {
        setActive(true);
        setStatus("Listening…");
      },
      onStop: () => setActive(false),
      onError: (e) => {
        setMicError(e);
        setStatus(e);
      },
    });
    recognizer.start();
  }

  const effectiveStatus = speaking
    ? "Speaking…"
    : act.kind !== "idle" && act.kind !== "listening"
      ? activity.label(act) || status
      : status;

  return (
    <>
      {/* Desktop layout — blueprint HUD */}
      <DesktopShell
        active={active}
        onMicToggle={toggleMic}
        right={<DesktopHomePanel status={effectiveStatus} interim={interim} />}
      />
      {/* Mobile layout */}
      <div className="lg:hidden starfield min-h-screen flex flex-col items-center px-4 pt-10 pb-12 relative overflow-hidden">
        <h1 className="text-xs tracking-[0.5em] text-muted-foreground mb-8">ALPHA</h1>

        <div onClick={toggleMic} className="cursor-pointer select-none">
          <AlphaOrb analyser={recognizer.analyserNode} active={active || speaking} size={300} />
        </div>

        {/* Curved K.I.T.T. equalizer arc beneath the orb */}
        <div className="mt-1 w-[22rem] max-w-[92vw] -translate-y-7 pointer-events-none">
          <KittScanner
            curved
            state={!bgEnabled ? "off" : active ? "scanning" : "idle"}
            bars={34}
            height={58}
          />
        </div>

        <LiveTranscript interim={interim} status={effectiveStatus} />
        {micError && <div className="mt-2 text-xs text-destructive">{micError}</div>}
        {eyeError && <div className="mt-2 text-xs text-destructive">{eyeError}</div>}
        {eyeOn && (
          <div className="mt-1 text-[10px] text-primary/70">
            Eye online — try "Alpha, what do you see?"
          </div>
        )}

        {/* Voice-first two-sided bottom dock arrangement */}
        <div className="flex items-center justify-center gap-6 mt-6 relative z-20">
          {/* Left down-arrow dock: Tools navigation */}
          <div className="relative">
            <button
              onClick={() => {
                setToolsOpen((v) => !v);
                setSettingsOpen(false);
              }}
              aria-label="Alpha tools"
              aria-expanded={toolsOpen}
              className="glass rounded-full p-3.5 neon-border inline-flex items-center justify-center active:scale-95 transition"
            >
              <ChevronDown className={`w-5 h-5 text-primary transition-transform duration-200 ${toolsOpen ? "rotate-180" : ""}`} />
            </button>
            {toolsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setToolsOpen(false)} />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 sm:left-0 sm:translate-x-0 mb-3 z-20 glass neon-border rounded-2xl p-2.5 grid grid-cols-3 gap-2 w-72 backdrop-blur-xl shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                  {[
                    { to: "/chat", icon: MessageSquare, label: "Chat" },
                    { to: "/notes", icon: NotebookPen, label: "Notes" },
                    { to: "/bills", icon: Wallet, label: "Bills" },
                    { to: "/image", icon: ImageIcon, label: "Image" },
                    { to: "/reminders", icon: Bell, label: "Reminders" },
                    { to: "/plans", icon: Map, label: "Plans" },
                    { to: "/memories", icon: Brain, label: "Memories" },
                  ].map(({ to, icon: Icon, label }) => (
                    <Link
                      key={to}
                      to={to as any}
                      onClick={() => setToolsOpen(false)}
                      className="flex flex-col items-center gap-1.5 px-2 py-2.5 rounded-xl bg-background/40 hover:bg-background/60 active:scale-95 transition"
                    >
                      <Icon className="w-5 h-5 text-primary" />
                      <span className="text-[10px] text-foreground/85">{label}</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Center: Chat button */}
          <Link
            to="/chat"
            aria-label="Open chat"
            className="glass rounded-full p-4 neon-border inline-flex active:scale-95 transition shadow-lg"
          >
            <MessageSquare className="w-6 h-6 text-primary" />
          </Link>

          {/* Right down-arrow dock: Settings & Eye */}
          <div className="relative">
            <button
              onClick={() => {
                setSettingsOpen((v) => !v);
                setToolsOpen(false);
              }}
              aria-label="Alpha settings & controls"
              aria-expanded={settingsOpen}
              className="glass rounded-full p-3.5 neon-border inline-flex items-center justify-center active:scale-95 transition"
            >
              <ChevronDown className={`w-5 h-5 text-primary transition-transform duration-200 ${settingsOpen ? "rotate-180" : ""}`} />
            </button>
            {settingsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSettingsOpen(false)} />
                <div className="absolute bottom-full right-0 mb-3 z-20 glass neon-border rounded-2xl p-2.5 flex flex-col gap-2 min-w-[130px] backdrop-blur-xl shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                  <Link
                    to="/settings"
                    onClick={() => setSettingsOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-background/40 hover:bg-background/60 active:scale-95 transition"
                  >
                    <SettingsIcon className="w-4 h-4 text-primary" />
                    <span className="text-xs text-foreground/85">Settings</span>
                  </Link>

                  {/* Manual Live Eye activation control inside the right dock */}
                  <button
                    onClick={() => toggleEye()}
                    aria-label={eyeOn ? "Stop Live Eye" : "Enable Live Eye"}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-xl transition active:scale-95 ${
                      eyeOn
                        ? "bg-destructive/25 border border-destructive/60 text-destructive-foreground font-medium"
                        : "bg-background/40 hover:bg-background/60 text-foreground/85"
                    }`}
                  >
                    {eyeOn ? (
                      <EyeOff className="w-4 h-4 text-destructive" />
                    ) : (
                      <Eye className="w-4 h-4 text-primary" />
                    )}
                    <span className="text-xs">{eyeOn ? "Stop Eye" : "Live Eye"}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
