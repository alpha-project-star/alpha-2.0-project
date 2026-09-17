import { useEffect, useState } from "react";
import { speakingState } from "../lib/voice";
import { useActivity } from "../lib/activity";
import { CyberEye } from "./CyberEye";

export function AlphaOrb({
  analyser,
  active,
  size = 280,
  sizeCss,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  size?: number;
  sizeCss?: string;
}) {
  const [speaking, setSpeaking] = useState(false);
  const act = useActivity();
  const isBusy = act.kind !== "idle" && act.kind !== "listening";
  const effectiveActive = active || isBusy;

  useEffect(() => speakingState.sub(setSpeaking), []);

  return (
    <div className="relative" style={{ width: sizeCss ?? size, height: sizeCss ?? size }}>
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="absolute inset-0 rounded-full alpha-ripple"
            style={{
              animationDelay: `${i * 1.1}s`,
              animationDuration: effectiveActive || speaking ? "3.2s" : "4.8s",
            }}
          />
        ))}
      </div>
      <CyberEye
        analyser={analyser}
        active={effectiveActive}
        speaking={speaking}
        size="100%"
        showMicroText={false}
      />
    </div>
  );
}
