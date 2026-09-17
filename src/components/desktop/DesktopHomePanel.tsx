import { useAlpha } from "../../lib/alpha-store";
import { HudPanel } from "./HudPanel";
import { HudBubble } from "./HudBubble";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { MessageContent } from "../MessageContent";
import { useEffect, useRef } from "react";

/** Home HUD panel: shows the most recent voice exchanges as HUD bubbles. */
export function DesktopHomePanel({ status, interim }: { status: string; interim: string }) {
  const chat = useAlpha((s) => s.chat);
  const recent = chat.slice(-8);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length, interim]);

  return (
    <HudPanel className="flex-1 min-h-0 flex flex-col p-4">
      <div className="flex items-center justify-between mb-3 pr-16">
        <div className="text-[10px] wordmark opacity-70">Live Feed</div>
        <Link
          to="/chat"
          className="hud-bubble text-[10px] wordmark px-2 py-1 inline-flex items-center gap-1"
        >
          <MessageSquare className="w-3 h-3" /> Full Chat
        </Link>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
        {recent.length === 0 && (
          <div className="text-xs text-muted-foreground italic">No exchanges yet.</div>
        )}
        {recent.map((m) => (
          <HudBubble
            key={m.id}
            side={m.role === "user" ? "user" : "assistant"}
            label={m.role === "user" ? "YOU" : "ALPHA"}
          >
            {m.role === "model" ? (
              <MessageContent text={m.text} />
            ) : (
              <div className="whitespace-pre-wrap">{m.text}</div>
            )}
          </HudBubble>
        ))}
        {interim && (
          <HudBubble side="user" label="YOU">
            <div className="opacity-70 italic">{interim}</div>
          </HudBubble>
        )}
      </div>
      <div className="mt-3 text-center text-[10px] wordmark opacity-80">{status}</div>
    </HudPanel>
  );
}
