import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { recognizer, prepareUtterance, stopSpeaking, speakingState } from "../lib/voice";
import { useActivity } from "../lib/activity";
import { alphaStore, uid } from "../lib/alpha-store";
import { sendChat } from "../lib/alpha.functions";
import { speakWith } from "../lib/voice";
import { parseIntent } from "../lib/voice-router";
import { tryLocalIntent } from "../lib/local-intents";
import { handleEyeCommand } from "../lib/vision-command";
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

  useEffect(() => speakingState.sub(setSpeaking), []);

  async function handleFinal(text: string) {
    if (!text.trim()) return;
    const intent = parseIntent(text);
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
    const eyeRes = await handleEyeCommand(text);
    const local = eyeRes ?? (await tryLocalIntent(text));
    if (local) {
      alphaStore.appendChat({ id: uid(), role: "user", text, ts: Date.now() });
      alphaStore.appendChat({ id: uid(), role: "model", text: local, ts: Date.now() });
      speakWith(local, { auto: true });
      return;
    }
    alphaStore.appendChat({ id: uid(), role: "user", text, ts: Date.now() });
    try {
      const reply = await sendChat(alphaStore.get().chat);
      alphaStore.appendChat({ id: uid(), role: "model", text: reply, ts: Date.now() });
      speakWith(reply, { auto: true });
    } catch (e: any) {
      alphaStore.appendChat({
        id: uid(),
        role: "system",
        text: e?.message || "Error",
        ts: Date.now(),
        error: true,
      });
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
