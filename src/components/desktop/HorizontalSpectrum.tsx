import { useEffect, useRef } from "react";

/** Horizontal frequency waveform used as the mic-dock wings and orb wings. */
export function HorizontalSpectrum({
  analyser,
  bars = 64,
  className = "",
  mirror = false,
  speaking = false,
}: {
  analyser: AnalyserNode | null;
  bars?: number;
  className?: string;
  mirror?: boolean;
  speaking?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(0);
  const spkRef = useRef(speaking);
  useEffect(() => {
    spkRef.current = speaking;
  }, [speaking]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const data = new Uint8Array(128);
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = (canvas.width = canvas.offsetWidth * dpr);
      const h = (canvas.height = canvas.offsetHeight * dpr);
      ctx.clearRect(0, 0, w, h);
      if (analyser) analyser.getByteFrequencyData(data);
      phaseRef.current += spkRef.current ? 0.05 : 0.02;
      const gap = 2 * dpr;
      const barW = Math.max(1, w / bars - gap);
      const midY = h / 2;
      for (let i = 0; i < bars; i++) {
        const idx = mirror ? bars - 1 - i : i;
        const seed = spkRef.current
          ? 0.35 + 0.55 * Math.abs(Math.sin(phaseRef.current * 2 + idx * 0.35))
          : analyser
            ? data[idx % data.length] / 255
            : 0.05 + 0.03 * Math.sin(phaseRef.current + idx);
        const bh = Math.max(2 * dpr, seed * h * 0.9);
        const x = i * (barW + gap);
        const grad = ctx.createLinearGradient(x, midY - bh / 2, x, midY + bh / 2);
        grad.addColorStop(0, "rgba(140, 200, 255, 0.9)");
        grad.addColorStop(0.5, "rgba(120, 180, 255, 1)");
        grad.addColorStop(1, "rgba(140, 200, 255, 0.9)");
        ctx.fillStyle = grad;
        ctx.fillRect(x, midY - bh / 2, barW, bh);
      }
      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [analyser, bars, mirror]);
  return <canvas ref={ref} className={className} />;
}
