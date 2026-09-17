import { Mic, MicOff } from "lucide-react";
import { HorizontalSpectrum } from "./HorizontalSpectrum";
import { recognizer, speakingState } from "../../lib/voice";
import { useEffect, useState } from "react";

/** Bottom-center mic + waveform strip. Desktop only. */
export function MicDock({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => speakingState.sub(setSpeaking), []);
  const hot = active || speaking;
  return (
    <div className="hidden lg:flex fixed bottom-4 left-1/2 -translate-x-1/2 z-30 items-center gap-3 hud-frame hud-frame-corners px-4 py-2 w-[min(720px,60vw)]">
      <HorizontalSpectrum
        analyser={hot ? recognizer.analyserNode : null}
        speaking={speaking}
        mirror
        className="flex-1 h-10"
      />
      <button
        onClick={onToggle}
        aria-label={active ? "Stop listening" : "Start listening"}
        className="shrink-0 w-12 h-12 rounded-full border-2 flex items-center justify-center transition active:scale-95"
        style={{
          borderColor: "var(--hud-cyan)",
          background: hot ? "oklch(0.7 0.22 235 / 0.25)" : "oklch(0.1 0.06 260 / 0.6)",
          boxShadow: hot
            ? "0 0 18px oklch(0.7 0.22 235 / 0.75)"
            : "0 0 8px oklch(0.7 0.22 235 / 0.35)",
        }}
      >
        {active ? (
          <MicOff className="w-5 h-5 text-destructive" />
        ) : (
          <Mic className="w-5 h-5" style={{ color: "var(--hud-cyan)" }} />
        )}
      </button>
      <HorizontalSpectrum
        analyser={hot ? recognizer.analyserNode : null}
        speaking={speaking}
        className="flex-1 h-10"
      />
    </div>
  );
}
