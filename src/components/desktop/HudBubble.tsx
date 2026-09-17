import type { ReactNode } from "react";

/** Chat bubble in HUD style — assistant on left, user on right. */
export function HudBubble({
  side,
  children,
  label,
}: {
  side: "user" | "assistant";
  children: ReactNode;
  label?: string;
}) {
  const isUser = side === "user";
  return (
    <div className={`flex w-full gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="relative max-w-[85%] min-w-0">
        {label && (
          <div
            className={`text-[10px] wordmark opacity-80 mb-1 ${isUser ? "text-right" : "text-left"}`}
          >
            {label}
          </div>
        )}
        <div className="hud-bubble px-4 py-2 text-sm break-words [overflow-wrap:anywhere]">
          {children}
        </div>
      </div>
    </div>
  );
}
