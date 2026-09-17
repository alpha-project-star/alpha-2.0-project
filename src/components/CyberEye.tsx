import { useEffect, useState } from "react";
import {
  subscribeActive as subEyeActive,
  subscribeBrightness as subEyeBright,
} from "../lib/vision-stream";

/**
 * Live "cyber-lens" eye — heavy brushed-silver camera bezel, black inner
 * groove, layered holographic retina, turbine-like neon-blue aperture arcs,
 * a luminous crosshair, and a dark spiral shutter pupil.
 *
 * All CSS + SVG. Reacts to the audio analyser + speaking state.
 */
export function CyberEye({
  analyser,
  active,
  speaking,
  size,
  showMicroText = true,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  speaking: boolean;
  size: number | string;
  showMicroText?: boolean;
}) {
  const [level, setLevel] = useState(0);
  const [beat, setBeat] = useState(0);
  const [blink, setBlink] = useState(0);
  const [eyeOn, setEyeOn] = useState(false);
  const [gaze, setGaze] = useState({ x: 0, y: 0, luma: 0, motion: 0 });

  useEffect(() => subEyeActive(setEyeOn), []);
  useEffect(() => {
    if (!eyeOn) {
      setGaze({ x: 0, y: 0, luma: 0, motion: 0 });
      return;
    }
    return subEyeBright((s) => setGaze({ x: -s.cx, y: s.cy, luma: s.luma, motion: s.motion }));
  }, [eyeOn]);

  useEffect(() => {
    if (!analyser || !active) {
      setLevel(0);
      return;
    }
    let raf = 0;
    const data = new Uint8Array(64);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) s += data[i];
      setLevel(s / data.length / 255);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [analyser, active]);

  useEffect(() => {
    if (!speaking && !active) {
      setBeat(0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      setBeat(0.5 + 0.5 * Math.sin(t * (speaking ? 4 : 2.2)));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [speaking, active]);

  // Occasional blink — closes for ~150ms every 5–9s.
  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      const wait = 5000 + Math.random() * 4000;
      setTimeout(() => {
        if (cancelled) return;
        setBlink(1);
        setTimeout(() => {
          if (!cancelled) setBlink(0);
          schedule();
        }, 150);
      }, wait);
    };
    schedule();
    return () => {
      cancelled = true;
    };
  }, []);

  const hot = active || speaking;
  const bezelDur = hot ? "24s" : "60s";
  const pupilGlow =
    0.32 +
    (active ? level * 0.5 : 0) +
    (speaking ? beat * 0.28 : 0) +
    (eyeOn ? gaze.luma * 0.28 + gaze.motion * 0.35 : 0);
  const liveOpacity = hot ? 0.34 + level * 0.24 + beat * 0.12 : 0.18;

  const rPupil = 9.4;

  // Dark overlapping mechanical shutters under the blue light traces. These
  // sit in the outer retina like the reference's camera-aperture fins.
  const APERTURE_PANELS = 16;
  const aperturePanels = Array.from({ length: APERTURE_PANELS }, (_, i) => {
    const step = (Math.PI * 2) / APERTURE_PANELS;
    const a0 = i * step - Math.PI / 2 + 0.04;
    const a1 = a0 + step * 1.42;
    const p = (r: number, a: number) =>
      `${(50 + Math.cos(a) * r).toFixed(2)},${(50 + Math.sin(a) * r).toFixed(2)}`;
    return `M ${p(47.5, a0)} A 47.5 47.5 0 0 1 ${p(47.5, a1)} Q ${p(36.5, a1 + 0.22)} ${p(38.6, a0 + 0.18)} Z`;
  });

  // Long cyan crescents: many slim arcs sweep counter-clockwise around the rim,
  // stopping before the pupil so the centre remains a true eye/shutter rather
  // than a starburst.
  const LIGHT_ARCS = 16;
  const bladeStreaks = Array.from({ length: LIGHT_ARCS }, (_, i) => {
    const a0 = (i / LIGHT_ARCS) * Math.PI * 2 - Math.PI / 2 - 0.02;
    const a1 = a0 + 0.66;
    const x1 = 50 + Math.cos(a0) * 46.2;
    const y1 = 50 + Math.sin(a0) * 46.2;
    const x2 = 50 + Math.cos(a1) * 35.8;
    const y2 = 50 + Math.sin(a1) * 35.8;
    const cx = 50 + Math.cos(a0 + 0.36) * 48.2;
    const cy = 50 + Math.sin(a0 + 0.36) * 48.2;
    return `M ${x1.toFixed(2)},${y1.toFixed(2)} Q ${cx.toFixed(2)},${cy.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
  });

  const innerLightArcs = Array.from({ length: 8 }, (_, i) => {
    const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2 + 0.08;
    const a1 = a0 + 0.46;
    const x1 = 50 + Math.cos(a0) * 29.5;
    const y1 = 50 + Math.sin(a0) * 29.5;
    const x2 = 50 + Math.cos(a1) * 18.8;
    const y2 = 50 + Math.sin(a1) * 18.8;
    const cx = 50 + Math.cos(a0 + 0.25) * 30.2;
    const cy = 50 + Math.sin(a0 + 0.25) * 30.2;
    return `M ${x1.toFixed(2)},${y1.toFixed(2)} Q ${cx.toFixed(2)},${cy.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
  });

  // 8-segment spiral shutter pupil — smooth overlapping petals with a
  // subtle swirl. Rather than pointed tips, the petals wrap around each
  // other so the interior reads as a soft rotating aperture.
  const PUPIL_BLADES = 8;
  const rP = rPupil; // pupil outer
  const shutterPetals = Array.from({ length: PUPIL_BLADES }, (_, i) => {
    const a0 = (i / PUPIL_BLADES) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / PUPIL_BLADES;
    const p = (r: number, ang: number) =>
      `${(50 + Math.cos(ang) * r).toFixed(2)},${(50 + Math.sin(ang) * r).toFixed(2)}`;
    // Classic camera-aperture blade: outer arc from a0 → a1, then a curved
    // chord back through an inner point biased toward a1 for the swirl.
    const innerA = a0 + (a1 - a0) * 0.72;
    const innerR = rP * 0.2;
    const cA = a0 + (a1 - a0) * 0.35;
    const cR = rP * 0.6;
    return `M ${p(rP, a0)} A ${rP} ${rP} 0 0 1 ${p(rP, a1)} Q ${p(cR, cA)} ${p(innerR, innerA)} Z`;
  });

  // Radial "light burst" rays emanating from the pupil.
  const RAYS = 72;
  const rays = Array.from({ length: RAYS }, (_, i) => {
    const a = (i / RAYS) * Math.PI * 2;
    const rIn = rPupil + 1;
    const rOut = i % 2 === 0 ? 44 : 36;
    return {
      x1: 50 + Math.cos(a) * rIn,
      y1: 50 + Math.sin(a) * rIn,
      x2: 50 + Math.cos(a) * rOut,
      y2: 50 + Math.sin(a) * rOut,
      strong: i % 3 === 0,
    };
  });

  return (
    <div className="relative select-none" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0"
        style={{
          animation: "cyber-breath 5.2s ease-in-out infinite",
        }}
      >
        {/* Reference-accurate cyber lens base. */}
        <img
          src="/cyber-eye-reference.png"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 z-0 h-full w-full rounded-full object-cover pointer-events-none"
          style={{
            filter: "saturate(1.12) contrast(1.12) brightness(0.98)",
            opacity: 1,
          }}
        />

        {/* Outer neon halo */}
        <div
          className="absolute inset-[-20%] z-10 rounded-full pointer-events-none"
          style={{
            background: "radial-gradient(circle, oklch(0.72 0.25 240 / 0.5), transparent 66%)",
            filter: "blur(34px)",
            opacity: 0.18 + (hot ? level * 0.38 + beat * 0.18 : 0.03),
            transition: "opacity .15s",
          }}
        />

        {/* Rotating brushed silver bezel */}
        <div
          className="absolute inset-0 z-10 rounded-full cyber-bezel pointer-events-none"
          style={{
            animation: `cyber-spin ${bezelDur} linear infinite`,
            opacity: hot ? 0.09 : 0.035,
            mixBlendMode: "screen",
          }}
        />
        {/* Static bezel overlay: faint tick clusters by default; optional text
          only where the smaller UI explicitly asks for it. */}
        {showMicroText && <BezelOverlay showText={showMicroText} />}
        {/* Fine inner silver lip */}
        <div
          className="absolute inset-[9.5%] z-10 rounded-full cyber-bezel-lip pointer-events-none"
          style={{ opacity: hot ? 0.05 : 0.02, mixBlendMode: "screen" }}
        />

        {/* Dark metallic groove holding the aperture */}
        <div
          className="absolute inset-[11.5%] z-10 rounded-full cyber-groove pointer-events-none"
          style={{ opacity: hot ? 0.04 : 0.015, mixBlendMode: "screen" }}
        />

        {/* SVG stack: HUD retina + light-streak iris + radial burst + shutter pupil.
          NOTE: no overflow-visible — crosshair/rays must clip at the lens edge. */}
        <svg
          viewBox="0 0 100 100"
          className="absolute inset-[14%] z-20 w-[72%] h-[72%] pointer-events-none"
          style={{
            opacity: Math.max(0.55, Math.min(1, liveOpacity + 0.4)),
            mixBlendMode: "screen",
          }}
        >
          <defs>
            <clipPath id="lensClip">
              <circle cx="50" cy="50" r="49" />
            </clipPath>
            <radialGradient id="pupilCore" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="oklch(0.99 0.06 232)" stopOpacity="1" />
              <stop offset="28%" stopColor="oklch(0.82 0.28 240)" stopOpacity="0.95" />
              <stop offset="70%" stopColor="oklch(0.42 0.22 250)" stopOpacity="0.6" />
              <stop offset="100%" stopColor="oklch(0 0 0)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="lensBg" cx="50%" cy="50%" r="65%">
              <stop offset="0%" stopColor="oklch(0.2 0.18 248)" />
              <stop offset="42%" stopColor="oklch(0.08 0.11 257)" />
              <stop offset="72%" stopColor="oklch(0.035 0.07 260)" />
              <stop offset="100%" stopColor="oklch(0.01 0.025 260)" />
            </radialGradient>
            <radialGradient id="burstGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="oklch(0.99 0.2 232)" stopOpacity="0.98" />
              <stop offset="28%" stopColor="oklch(0.72 0.28 238)" stopOpacity="0.76" />
              <stop offset="68%" stopColor="oklch(0.44 0.24 248)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="oklch(0.25 0.16 250)" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="glassSheen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(1 0 0 / 0.35)" />
              <stop offset="50%" stopColor="oklch(1 0 0 / 0.05)" />
              <stop offset="100%" stopColor="oklch(1 0 0 / 0)" />
            </linearGradient>
            <filter id="neonBlur" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="0.35" />
            </filter>
            <filter id="neonGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.2" />
            </filter>
            <linearGradient id="bladeMetal" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="oklch(0.06 0.04 258 / 0.9)" />
              <stop offset="45%" stopColor="oklch(0.18 0.08 248 / 0.8)" />
              <stop offset="100%" stopColor="oklch(0.015 0.02 260 / 0.95)" />
            </linearGradient>
          </defs>

          <g clipPath="url(#lensClip)">
            {/* Lens background */}
            <circle cx="50" cy="50" r="49" fill="url(#lensBg)" />

            {/* Outer dark aperture fins beneath the cyan traces */}
            <g opacity="0.2">
              {aperturePanels.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="url(#bladeMetal)"
                  stroke="oklch(0.48 0.16 238 / 0.55)"
                  strokeWidth="0.25"
                />
              ))}
            </g>

            {/* Dense HUD retina — concentric data rings, ticks, and faint grid rays */}
            <g fill="none" filter="url(#neonBlur)" opacity="0.6">
              {[
                47, 45.5, 44, 42.5, 41, 39.4, 37.8, 36.2, 34.6, 33, 31, 29, 27, 25, 23, 21, 19,
                16.8, 14.8, 12.8,
              ].map((r, i) => (
                <circle
                  key={r}
                  cx="50"
                  cy="50"
                  r={r}
                  stroke="oklch(0.75 0.22 240)"
                  strokeWidth={i % 4 === 0 ? 0.28 : 0.13}
                  strokeDasharray={
                    i % 4 === 0
                      ? `${1.2 + i * 0.12} ${0.55 + i * 0.08}`
                      : i % 2 === 0
                        ? `0.4 1.2`
                        : `2.4 1.0 0.4 1.0`
                  }
                  opacity={0.28 + (i % 4 === 0 ? 0.3 : 0.12)}
                  style={{
                    transformOrigin: "50% 50%",
                    animation: `cyber-spin ${34 - i * 2}s linear ${i % 2 ? "reverse" : "normal"} infinite`,
                  }}
                />
              ))}
            </g>

            <g
              stroke="oklch(0.5 0.2 240 / 0.28)"
              strokeWidth="0.1"
              filter="url(#neonBlur)"
              opacity="0.5"
            >
              {Array.from({ length: 48 }).map((_, i) => {
                const a = (i / 48) * Math.PI * 2;
                const major = i % 6 === 0;
                const r1 = major ? 11 : 18;
                const r2 = major ? 46 : 42;
                return (
                  <line
                    key={i}
                    x1={50 + Math.cos(a) * r1}
                    y1={50 + Math.sin(a) * r1}
                    x2={50 + Math.cos(a) * r2}
                    y2={50 + Math.sin(a) * r2}
                    opacity={major ? 0.55 : 0.2}
                  />
                );
              })}
            </g>

            {/* Circuit-like rectangular glyphs concentrated around the retina */}
            <g
              fill="none"
              stroke="oklch(0.7 0.22 238 / 0.43)"
              strokeWidth="0.18"
              filter="url(#neonBlur)"
              opacity="0.48"
            >
              {Array.from({ length: 28 }).map((_, i) => {
                const a = (i * 137.508 * Math.PI) / 180;
                const r = 18 + ((i * 11) % 26);
                const x = 50 + Math.cos(a) * r;
                const y = 50 + Math.sin(a) * r;
                const rot = (a * 180) / Math.PI + 90;
                const w = 2.4 + (i % 4) * 0.9;
                const h = 1.2 + (i % 3) * 0.55;
                return (
                  <rect
                    key={i}
                    x={x - w / 2}
                    y={y - h / 2}
                    width={w}
                    height={h}
                    rx="0.12"
                    transform={`rotate(${rot} ${x} ${y})`}
                    opacity={0.3 + (i % 3) * 0.12}
                  />
                );
              })}
            </g>

            {/* Scattered rectangular data glyphs (mimics the small readouts in ref) */}
            <g fill="oklch(0.8 0.22 238)" opacity="0.28">
              {Array.from({ length: 22 }).map((_, i) => {
                const a = (i * 137.5 * Math.PI) / 180; // golden-angle scatter
                const r = 22 + ((i * 7) % 20);
                const x = 50 + Math.cos(a) * r;
                const y = 50 + Math.sin(a) * r;
                const w = 0.7 + (i % 3) * 0.4;
                const h = 0.35;
                return <rect key={i} x={x} y={y} width={w} height={h} rx="0.1" />;
              })}
            </g>

            {/* Radial light burst — fine rays emanating from the pupil */}
            <g filter="url(#neonBlur)" opacity="0.55">
              {rays.map((r, i) => (
                <line
                  key={i}
                  x1={r.x1}
                  y1={r.y1}
                  x2={r.x2}
                  y2={r.y2}
                  stroke={r.strong ? "oklch(0.95 0.25 235)" : "oklch(0.78 0.22 240)"}
                  strokeWidth={r.strong ? 0.28 : 0.12}
                  opacity={r.strong ? 0.5 : 0.24}
                />
              ))}
            </g>

            {/* Bright cyan crosshair spanning full lens */}
            <g
              stroke="oklch(0.96 0.22 232)"
              strokeWidth="0.5"
              opacity="0.55"
              filter="url(#neonBlur)"
            >
              <line x1="2" y1="50" x2="98" y2="50" />
              <line x1="50" y1="2" x2="50" y2="98" />
            </g>
            {/* Crosshair glow underlay */}
            <g
              stroke="oklch(0.8 0.28 240)"
              strokeWidth="1.45"
              opacity="0.24"
              filter="url(#neonGlow)"
            >
              <line x1="2" y1="50" x2="98" y2="50" />
              <line x1="50" y1="2" x2="50" y2="98" />
            </g>

            {/* Iris — layered neon-blue light crescents spiraling around the aperture */}
            <g fill="none" strokeLinecap="round" filter="url(#neonBlur)" opacity="0.72">
              {bladeStreaks.map((d, i) => (
                <g key={i}>
                  {/* soft outer glow */}
                  <path d={d} stroke="oklch(0.75 0.28 240)" strokeWidth="1.0" opacity="0.28" />
                  {/* bright inner streak */}
                  <path
                    d={d}
                    stroke="oklch(0.96 0.22 235)"
                    strokeWidth="0.24"
                    opacity={i % 4 === 0 ? 0.82 : 0.58}
                  />
                </g>
              ))}
              {innerLightArcs.map((d, i) => (
                <g key={`inner-${i}`}>
                  <path d={d} stroke="oklch(0.72 0.28 240)" strokeWidth="0.8" opacity="0.22" />
                  <path d={d} stroke="oklch(0.96 0.22 235)" strokeWidth="0.22" opacity="0.64" />
                </g>
              ))}
            </g>

            {/* Radial burst gradient disc (soft ambient aperture bloom) */}
            <circle
              cx="50"
              cy="50"
              r={rPupil + 10 + pupilGlow * 2.4}
              fill="url(#burstGrad)"
              opacity={0.3 + pupilGlow * 0.12}
            />

            {/* Glossy top-half dome highlight */}
            <ellipse cx="50" cy="28" rx="36" ry="14" fill="url(#glassSheen)" opacity="0.5" />
          </g>
        </svg>

        {eyeOn && (
          <div
            aria-hidden="true"
            className="absolute z-40 pointer-events-none flex items-center gap-1 rounded-full px-1.5 py-0.5"
            style={{
              top: "6%",
              left: "50%",
              transform: "translateX(-50%)",
              background: "oklch(0.15 0.08 20 / 0.55)",
              border: "1px solid oklch(0.65 0.28 25 / 0.7)",
              boxShadow: "0 0 8px oklch(0.7 0.3 25 / 0.6)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 9999,
                background: "oklch(0.7 0.32 25)",
                boxShadow: "0 0 6px oklch(0.8 0.3 25)",
                animation: "cyber-pupil-pulse 1s ease-in-out infinite",
              }}
            />
            <span
              style={{
                fontFamily: "Orbitron, sans-serif",
                fontSize: 8,
                letterSpacing: 1,
                color: "oklch(0.92 0.15 25)",
              }}
            >
              LIVE
            </span>
          </div>
        )}

        {/* Blink shutter — thin band closes across the lens. */}
        <div
          className="absolute inset-[10%] z-30 rounded-full overflow-hidden pointer-events-none"
          aria-hidden="true"
          style={{ opacity: blink ? 1 : 0 }}
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(180deg, oklch(0 0 0) 0%, oklch(0.04 0.02 258) 50%, oklch(0 0 0) 100%)",
              transformOrigin: "50% 50%",
              transform: blink ? "scaleY(1)" : "scaleY(0.02)",
              transition: "transform .12s ease-out",
              boxShadow: "inset 0 0 24px oklch(0 0 0 / 0.9)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Static overlay drawn on top of the rotating brushed-silver bezel:
 *   • bright neon-blue "CYBER-LENS 0.1nm RES" at 4 cardinal points
 *   • LCD-strip tick clusters between the text
 *   • fine tick ring on the inner edge of the bezel
 */
function BezelOverlay({ showText }: { showText: boolean }) {
  // Bezel text is placed by rotation transform, not textPath — the string is
  // short enough to read as a straight chord, and this approach guarantees
  // upright glyphs on every browser.
  //   • R_TEXT is the radius of the text baseline in viewBox units (0..100)
  //   • Bezel visible ring runs ~33..50 in viewBox radius
  // Bezel visible ring in viewBox coords: ~42..50 (groove ends at 42, bezel
  // outer edge at 50). Text sits at R=46 — the middle of the silver rim.
  const R_TEXT = 46;
  const LABEL = "CYBER-LENS 0.1nm RES";
  // Four cardinal positions and the rotation each label needs so it reads
  // upright when viewed from outside the ring.
  const labels = [
    { tx: 50, ty: 50 - R_TEXT + 1.0, rotate: 0 }, // TOP
    { tx: 50 + R_TEXT - 1.0, ty: 50, rotate: 90 }, // RIGHT
    { tx: 50, ty: 50 + R_TEXT - 0.2, rotate: 180 }, // BOTTOM (label rotates 180 so it reads upright when viewed from outside the ring)
    { tx: 50 - R_TEXT + 1.0, ty: 50, rotate: 270 }, // LEFT
  ];
  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none">
      {showText &&
        labels.map((l, i) => (
          <text
            key={i}
            x={l.tx}
            y={l.ty}
            transform={`rotate(${l.rotate} ${l.tx} ${l.ty})`}
            textAnchor="middle"
            fill="oklch(0.9 0.24 235)"
            fontFamily="Orbitron, sans-serif"
            fontSize="2.6"
            letterSpacing="0.35"
            style={{
              textTransform: "uppercase",
              filter: "drop-shadow(0 0 0.5px oklch(0.95 0.28 235))",
            }}
          >
            {LABEL}
          </text>
        ))}

      {/* LCD-strip tick clusters at 4 inter-cardinal positions (~45°) */}
      <g
        stroke="oklch(0.85 0.24 235)"
        strokeWidth="0.28"
        opacity={showText ? 0.74 : 0.42}
        style={{ filter: "drop-shadow(0 0 0.6px oklch(0.9 0.28 235))" }}
      >
        {[20, 70, 118, 162, 205, 250, 300, 338].map((deg) => {
          const a = ((deg - 90) * Math.PI) / 180;
          const cx = 50 + Math.cos(a) * 46;
          const cy = 50 + Math.sin(a) * 46;
          // Tangent direction for the tick strip
          const tx = -Math.sin(a),
            ty = Math.cos(a);
          // Radial direction (for tick length)
          const rx = Math.cos(a),
            ry = Math.sin(a);
          return (
            <g key={deg}>
              {Array.from({ length: 12 }).map((_, i) => {
                const off = (i - 5.5) * 0.42;
                const bx = cx + tx * off;
                const by = cy + ty * off;
                const len = i % 3 === 0 ? 1.15 : 0.62;
                return (
                  <line
                    key={i}
                    x1={bx - (rx * len) / 2}
                    y1={by - (ry * len) / 2}
                    x2={bx + (rx * len) / 2}
                    y2={by + (ry * len) / 2}
                  />
                );
              })}
            </g>
          );
        })}
      </g>

      {/* Fine tick ring on the inner edge of the bezel */}
      <g stroke="oklch(0.72 0.08 238 / 0.65)" strokeWidth="0.12">
        {Array.from({ length: 180 }).map((_, i) => {
          const a = (i / 180) * Math.PI * 2;
          const r1 = 41.8;
          const r2 = i % 9 === 0 ? 39.8 : i % 3 === 0 ? 40.6 : 41.1;
          return (
            <line
              key={i}
              x1={50 + Math.cos(a) * r1}
              y1={50 + Math.sin(a) * r1}
              x2={50 + Math.cos(a) * r2}
              y2={50 + Math.sin(a) * r2}
            />
          );
        })}
      </g>
    </svg>
  );
}
