import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { recognizer, prepareUtterance, stopSpeaking, speakingState } from "../lib/voice";
import { useActivity } from "../lib/activity";
import { alphaStore, uid } from "../lib/alpha-store";
import { sendChat } from "../lib/alpha.functions";
import { speakWith } from "../lib/voice";
import { parseIntent } from "../lib/voice-router";
import { CyberEye } from "./CyberEye";

/**
 * Tiny beating orb in the chat header. Tap to start/stop voice — keeps the
 * chat in sync (appends to the same chat thread) so voice & text co-exist.
 */
export function MiniOrb({ size = 56 }: { size?: number }) {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const act = useActivity();
  const isBusy = act.kind !== "idle" && act.kind !== "listening";
  const effectiveActive = active || isBusy;
  const busyRef = useRef(false);
  const lastVoiceRef = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });

  useEffect(() => speakingState.sub(setSpeaking), []);

  async function handleFinal(text: string) {
    if (busyRef.current) return;
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
      router.navigate({ to: intent.to });
      return;
    }
    if (intent.kind === "stop") {
      recognizer.stop();
      stopSpeaking();
      setActive(false);
      return;
    }

    busyRef.current = true;
    try {
      await alphaStore.appendChat({ id: uid(), role: "user", text: trimmed, ts: Date.now() });
      const reply = await sendChat(alphaStore.get().chat);
      await alphaStore.appendChat({ id: uid(), role: "model", text: reply, ts: Date.now() });
      speakWith(reply, { auto: true });
    } catch (e: any) {
      await alphaStore.appendChat({
        id: uid(),
        role: "system",
        text: e?.message || "Error",
        ts: Date.now(),
        error: true,
      });
    } finally {
      busyRef.current = false;
    }
  }

  function toggle() {
    prepareUtterance();
    if (active) {
      recognizer.stop();
      stopSpeaking();
      setActive(false);
      return;
    }
    recognizer.setHandlers({
      onFinal: (t) => handleFinal(t),
      onStart: () => setActive(true),
      onStop: () => setActive(false),
      onError: () => setActive(false),
    });
    recognizer.start();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={active ? "Stop voice" : "Talk to Alpha"}
      className="relative rounded-full active:scale-95 transition shrink-0"
      style={{ width: size, height: size }}
    >
      <CyberEye
        analyser={recognizer.analyserNode}
        active={effectiveActive}
        speaking={speaking}
        size={size}
        showMicroText={false}
      />
    </button>
  );
}
