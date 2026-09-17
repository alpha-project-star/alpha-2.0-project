import { useEffect, useRef } from "react";

export function AudioSpectrum({
  analyser,
  bars = 48,
  className = "",
  speaking = false,
}: {
  analyser: AnalyserNode | null;
  bars?: number;
  className?: string;
  speaking?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rotRef = useRef(0);
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
      const w = (canvas.width = canvas.offsetWidth * devicePixelRatio);
      const h = (canvas.height = canvas.offsetHeight * devicePixelRatio);
      ctx.clearRect(0, 0, w, h);
      if (analyser) analyser.getByteFrequencyData(data);
      const cx = w / 2,
        cy = h / 2,
        r = Math.min(w, h) * 0.35;
      rotRef.current += spkRef.current ? 0.012 : 0.003;
      const phase = rotRef.current;
      for (let i = 0; i < bars; i++) {
        const seed = spkRef.current
          ? 0.4 + 0.6 * Math.abs(Math.sin(phase * 2 + i * 0.4))
          : analyser
            ? data[i % data.length] / 255
            : 0.05 + 0.05 * Math.sin(phase + i);
        const a = (i / bars) * Math.PI * 2 - Math.PI / 2 + phase;
        const len = r * 0.15 + seed * r * 0.45;
        const x1 = cx + Math.cos(a) * r;
        const y1 = cy + Math.sin(a) * r;
        const x2 = cx + Math.cos(a) * (r + len);
        const y2 = cy + Math.sin(a) * (r + len);
        const g = ctx.createLinearGradient(x1, y1, x2, y2);
        g.addColorStop(0, "rgba(120,180,255,0.9)");
        g.addColorStop(1, "rgba(80,120,255,0.1)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [analyser, bars]);
  return <canvas ref={ref} className={className} />;
}
