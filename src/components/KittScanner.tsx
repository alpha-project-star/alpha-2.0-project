import { useEffect, useState } from "react";
import { speakingState } from "../lib/voice";
import { alertBus } from "../lib/alerts";
import { useActivity } from "../lib/activity";

export type KittState = "idle" | "scanning" | "speaking" | "processing" | "alert" | "off";

/**
 * Knight Rider (K.I.T.T.) style "anamorphic equalizer" scanner.
 * Two halves split by a central divider; each half sweeps outward with
 * softly trailing bars. States:
 *   idle       — slow heartbeat sweep
 *   scanning   — brisk sweep while the mic is listening
 *   speaking   — fast bright sweep while Alpha talks
 *   processing — bars fire from the center gap outward simultaneously
 *   alert      — fast amber urgent sweep (auto-triggered from alertBus)
 *   off        — fully faded (background-processing disabled in settings)
 *
 * `curved` renders the bar as a subtle arc — used under the voice-first orb.
 */
export function KittScanner({
  state = "idle",
  bars = 24,
  className = "",
  height = 18,
  curved = false,
}: {
  state?: KittState;
  bars?: number;
  className?: string;
  height?: number;
  curved?: boolean;
}) {
  const [talking, setTalking] = useState(false);
  const [alerting, setAlerting] = useState(false);
  const act = useActivity();
  const isBusy = act.kind !== "idle" && act.kind !== "listening";

  useEffect(() => speakingState.sub(setTalking), []);
  useEffect(
    () =>
      alertBus.sub((on) => {
        setAlerting(on);
        if (on) setTimeout(() => setAlerting(false), 6000);
      }),
    [],
  );

  const effective: KittState =
    state === "off"
      ? "off"
      : alerting
        ? "alert"
        : talking
          ? "speaking"
          : state !== "idle"
            ? state
            : act.kind === "listening"
              ? "scanning"
              : isBusy
                ? "processing"
                : "idle";

  if (curved) {
    const perHalf = Math.max(8, Math.floor(bars / 2));
    const dur =
      effective === "alert"
        ? 500
        : effective === "speaking"
          ? 900
          : effective === "processing"
            ? 700
            : effective === "scanning"
              ? 1400
              : 2600;
    // Geometry: circular arc hugging the bottom of the orb. Circle centre is
    // placed above the viewBox so only the lower smile sits inside.
    const cx = 150,
      cy = 10,
      r = 130;
    // Left half sweeps 32°→86°, right half 94°→148°, leaving a centred gap.
    const startL = 32,
      endL = 86,
      startR = 94,
      endR = 148;
    const rad = (d: number) => (d * Math.PI) / 180;
    const pt = (deg: number) => ({
      x: cx + r * Math.cos(rad(deg)),
      y: cy + r * Math.sin(rad(deg)),
    });

    const makeBars = (a0: number, a1: number, side: "L" | "R") =>
      Array.from({ length: perHalf }).map((_, i) => {
        const t = i / (perHalf - 1);
        const deg = a0 + (a1 - a0) * t;
        const { x, y } = pt(deg);
        // Bar sits ON the arc; long axis tangent to circle.
        const tangent = deg + 90;
        // Distance from centre gap → sweep timing. side L: i=perHalf-1 is at gap.
        const gapT = side === "L" ? 1 - t : t; // 0 at gap, 1 at outer end
        const outerT = 1 - gapT; // 0 at outer end, 1 at gap
        const delay = effective === "processing" ? gapT * dur : outerT * dur;
        return { x, y, angle: tangent, delay };
      });

    const barsL = makeBars(startL, endL, "L");
    const barsR = makeBars(startR, endR, "R");

    // Rail paths (framed background per half — mirrors chat's kitt-half look)
    const l0 = pt(startL),
      l1 = pt(endL);
    const r0 = pt(startR),
      r1 = pt(endR);
    const railL = `M ${l0.x} ${l0.y} A ${r} ${r} 0 0 1 ${l1.x} ${l1.y}`;
    const railR = `M ${r0.x} ${r0.y} A ${r} ${r} 0 0 1 ${r1.x} ${r1.y}`;
    // Central gap divider at the very bottom of the orb.
    const gap = pt(90);

    const renderBar = (b: { x: number; y: number; angle: number; delay: number }, key: string) => (
      <rect
        key={key}
        className="kitt-arc-segment"
        x={b.x - 5}
        y={b.y - 7}
        width="10"
        height="14"
        rx="2"
        style={{
          animationDelay: `${b.delay}ms`,
          transformOrigin: `${b.x}px ${b.y}px`,
          transform: `rotate(${b.angle}deg)`,
        }}
      />
    );

    return (
      <svg
        role="presentation"
        viewBox="0 0 300 160"
        className={`kitt-arc ${effective === "alert" ? "kitt-alert" : ""} ${effective === "off" ? "kitt-off" : ""} ${className}`}
        style={{ height, "--kitt-dur": `${dur}ms` } as unknown as React.CSSProperties}
        preserveAspectRatio="none"
      >
        <path className="kitt-arc-frame" d={railL} />
        <path className="kitt-arc-frame" d={railR} />
        <path className="kitt-arc-rail" d={railL} />
        <path className="kitt-arc-rail" d={railR} />
        {barsL.map((b, i) => renderBar(b, `l${i}`))}
        {barsR.map((b, i) => renderBar(b, `r${i}`))}
        <rect className="kitt-arc-gap" x={gap.x - 2} y={gap.y - 12} width="4" height="22" rx="2" />
      </svg>
    );
  }

  if (effective === "off") {
    return (
      <div
        className={`kitt-split kitt-off ${curved ? "kitt-curved" : ""} ${className}`}
        style={{ height }}
      />
    );
  }

  const dur =
    effective === "alert"
      ? 500
      : effective === "speaking"
        ? 900
        : effective === "processing"
          ? 700
          : effective === "scanning"
            ? 1400
            : 2600;
  const opacityMin =
    effective === "alert"
      ? 0.4
      : effective === "speaking"
        ? 0.35
        : effective === "scanning"
          ? 0.25
          : 0.15;
  const opacityMax =
    effective === "alert"
      ? 1
      : effective === "speaking"
        ? 1
        : effective === "scanning"
          ? 0.95
          : 0.6;

  const half = Math.max(4, Math.floor(bars / 2));
  // For "processing", bars fire outward from the center gap — index 0 (nearest
  // gap) starts first. For everything else, sweep from outer edge inward.
  const delayFor = (i: number) =>
    effective === "processing"
      ? (i / half) * dur // 0 = center → outward
      : ((half - i) / half) * dur; // 0 = outer edge → toward center

  const halfStyle = {
    "--kitt-dur": `${dur}ms`,
    "--kitt-min": opacityMin,
    "--kitt-max": opacityMax,
  } as unknown as React.CSSProperties;

  return (
    <div
      role="presentation"
      className={`kitt-split ${effective === "alert" ? "kitt-alert" : ""} ${curved ? "kitt-curved" : ""} ${className}`}
      style={{ height }}
    >
      <div className="kitt-half left" style={halfStyle}>
        {Array.from({ length: half }).map((_, i) => (
          <span key={i} className="kitt-bar" style={{ animationDelay: `${delayFor(i)}ms` }} />
        ))}
      </div>
      <div className="kitt-gap" />
      <div className="kitt-half right" style={halfStyle}>
        {Array.from({ length: half }).map((_, i) => (
          <span key={i} className="kitt-bar" style={{ animationDelay: `${delayFor(i)}ms` }} />
        ))}
      </div>
    </div>
  );
}
