import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Wand2 } from "lucide-react";
import { generateImage } from "../lib/alpha.functions";
import { ToolHeader } from "../components/ToolHeader";

export const Route = createFileRoute("/image")({
  head: () => ({ meta: [{ title: "Alpha — Image" }, { name: "description", content: "Generate images with Alpha." }] }),
  component: ImageRoute,
});

function ImageRoute() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState<string | null>(null);
  const [via, setVia] = useState<string>("");
  const [err, setErr] = useState("");

  async function go() {
    if (!prompt.trim()) return;
    setBusy(true); setErr(""); setImg(null);
    try {
      const { dataUrl, via } = await generateImage(prompt);
      setImg(dataUrl); setVia(via);
    } catch (e: any) { setErr(e?.message || "Failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="starfield min-h-screen">
      <ToolHeader
        title="Image Studio"
        scannerState={busy ? "processing" : "idle"}
        right={
          busy ? (
            <span className="text-[10px] text-primary animate-pulse font-medium">Working…</span>
          ) : null
        }
      />
      <div className="p-4 max-w-xl mx-auto space-y-4">
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe what to create…"
          className="w-full bg-input rounded-xl px-3 py-2 border border-border outline-none focus:border-primary min-h-[100px]" />
        <button onClick={go} disabled={busy}
          className="w-full rounded-xl bg-primary text-primary-foreground py-3 font-semibold neon-border disabled:opacity-50 flex items-center justify-center gap-2">
          <Wand2 className="w-4 h-4" /> {busy ? "Generating…" : "Generate"}
        </button>
        {err && <div className="text-destructive text-sm">{err}</div>}
        {img && (
          <div className="glass rounded-xl p-2">
            <img src={img} alt="" className="w-full rounded-lg" />
            <div className="text-xs text-muted-foreground text-center mt-2">via {via}</div>
          </div>
        )}
      </div>
    </div>
  );
}