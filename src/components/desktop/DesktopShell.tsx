import type { ReactNode } from "react";
import { MicDock } from "./MicDock";
import { ToolRail } from "./ToolRail";
import { OrbStage } from "./OrbStage";
import { KittScanner } from "../KittScanner";
import { useAlpha } from "../../lib/alpha-store";

/**
 * Two-column desktop layout: giant orb on the left, HUD panel (right children).
 * Rendered only at lg+ via `hidden lg:block`.
 */
export function DesktopShell({
  right,
  active,
  onMicToggle,
  showClock = false,
}: {
  right: ReactNode;
  active: boolean;
  onMicToggle: () => void;
  showClock?: boolean;
}) {
  const bgEnabled = useAlpha((s) => s.settings.backgroundEnabled);
  const scanState = bgEnabled ? (active ? "scanning" : "idle") : "off";
  return (
    <div className="hidden lg:block starfield fixed inset-0 overflow-hidden">
      <div className="absolute top-6 left-1/2 -translate-x-1/2 z-20 wordmark text-2xl select-none pointer-events-none">
        ALPHA
      </div>

      {/* Thin KITT scanner strip under the wordmark */}
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-20 w-[320px]">
        <KittScanner state={scanState} bars={28} height={10} />
      </div>

      <ToolRail />

      <div className="grid grid-cols-[1fr_minmax(380px,460px)] gap-6 h-full pt-28 pb-32 pr-6 pl-24">
        <div className="relative min-w-0">
          <OrbStage active={active} />
        </div>
        <div className="relative min-w-0 min-h-0 flex flex-col pr-2">
          <div className="mb-3">
            <KittScanner state={scanState} bars={24} height={16} />
          </div>
          {right}
        </div>
      </div>

      <MicDock active={active} onToggle={onMicToggle} />
    </div>
  );
}
