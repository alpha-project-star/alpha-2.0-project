export function LiveTranscript({ interim, status }: { interim: string; status: string }) {
  return (
    <div className="w-full max-w-md mx-auto mt-6 min-h-[64px]">
      <div className="text-center text-xs uppercase tracking-[0.3em] text-muted-foreground mb-2">
        {status}
      </div>
      <div className="glass rounded-xl px-4 py-3 text-center text-base text-foreground/90 min-h-[48px]">
        {interim || <span className="text-muted-foreground/70 italic">…</span>}
      </div>
    </div>
  );
}
