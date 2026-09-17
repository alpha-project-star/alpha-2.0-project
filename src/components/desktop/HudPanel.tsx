import type { ReactNode } from "react";

/**
 * Sci-fi HUD frame with corner tick marks and an "ALPHA" chip in the top-right.
 * Used as the chat panel wrapper on desktop.
 */
export function HudPanel({
  children,
  className = "",
  label = "ALPHA",
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div className={`hud-frame hud-frame-corners ${className}`}>
      <div className="absolute top-2 right-3 text-[10px] wordmark opacity-80 pointer-events-none">
        {label}
      </div>
      {children}
    </div>
  );
}
