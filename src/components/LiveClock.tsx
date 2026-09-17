import { useEffect, useState } from "react";
import { temporal } from "../lib/temporal";

/**
 * Real-time clock. Ticks every second.
 * Compact by default; pass `full` for weekday + date under time.
 */
export function LiveClock({
  full = false,
  className = "",
}: {
  full?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(() => temporal.now());
  useEffect(() => {
    const id = setInterval(() => setNow(temporal.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const date = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div className={`live-clock select-none tabular-nums leading-tight ${className}`}>
      <div
        className="font-mono tracking-widest"
        style={{
          color: "var(--alpha-neon, #6ea8ff)",
          textShadow: "0 0 6px oklch(0.72 0.22 250 / 0.55)",
        }}
      >
        {time}
      </div>
      {full && <div className="text-[10px] opacity-70 tracking-[0.2em] uppercase">{date}</div>}
    </div>
  );
}
