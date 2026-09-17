import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, Sparkles, X, ArrowDown, ArrowUp, Zap } from "lucide-react";
import { alphaStore, uid, useAlpha } from "../../lib/alpha-store";
import { sendChat, type TaskType } from "../../lib/alpha.functions";
import { MessageContent } from "../MessageContent";
import { MessageActions } from "../MessageActions";
import { prepareUtterance, speakWith } from "../../lib/voice";
import { tryLocalIntent } from "../../lib/local-intents";
import { fileToShrunkDataUrl } from "../../lib/image-utils";
import { captureLiveFrame, handleEyeCommand, isVisionCommand, shouldCaptureFrame } from "../../lib/vision-command";
import { isActive as eyeIsActive } from "../../lib/vision-stream";
import { HudPanel } from "./HudPanel";
import { HudBubble } from "./HudBubble";
import { LiveClock } from "../LiveClock";
import { useActivity, activity } from "../../lib/activity";
import { NotificationCard } from "../NotificationCard";
import { OutstandingRemindersAffordance } from "../OutstandingRemindersAffordance";

/** Full HUD chat panel rendered inside the desktop shell right column. */
export function DesktopChatPanel() {
  const chat = useAlpha((s) => s.chat);
  const act = useActivity();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [task, setTask] = useState<TaskType>("auto");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 176) + "px";
  }
  useEffect(() => {
    autoGrow();
  }, [text]);

  function scrollToBottom(smooth = true) {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }
  useEffect(() => {
    scrollToBottom(true);
  }, [chat.length]);
  useEffect(() => {
    setTimeout(() => scrollToBottom(false), 0);
  }, []);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  }

  async function retry(assistantId: string) {
    if (busy) return;
    const r = alphaStore.prepareRetry(assistantId);
    if (!r) return;
    await send(r.userText);
  }

  async function send(overrideText?: string) {
    if (busy) return;
    const t = (overrideText ?? text).trim();
    if (!t && images.length === 0) return;
    prepareUtterance();
    let outImages = images;
    if (t && shouldCaptureFrame(t, eyeIsActive(), images.length > 0)) {
      const frame = await captureLiveFrame(eyeIsActive());
      if (frame) outImages = [...outImages, frame].slice(0, 4);
    }
    alphaStore.appendChat({
      id: uid(),
      role: "user",
      text: t,
      images: outImages.length ? outImages : undefined,
      ts: Date.now(),
    });
    setText("");
    setImages([]);
    setBusy(true);
    try {
      const eyeRes = t ? await handleEyeCommand(t) : null;
      const local = eyeRes ?? (t && !isVisionCommand(t) ? await tryLocalIntent(t) : null);
      const reply = local ?? (await sendChat(alphaStore.get().chat, { task }));
      alphaStore.appendChat({ id: uid(), role: "model", text: reply, ts: Date.now() });
      speakWith(reply, { auto: true });
    } catch (e: any) {
      alphaStore.appendChat({
        id: uid(),
        role: "system",
        text: e?.message || "Error",
        ts: Date.now(),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function pickImages(files: FileList | null) {
    if (!files) return;
    const arr = Array.from(files).slice(0, 4 - images.length);
    const datas = await Promise.all(arr.map((f) => fileToShrunkDataUrl(f)));
    setImages((prev) => [...prev, ...datas].slice(0, 4));
  }

  return (
    <HudPanel className="flex-1 min-h-0 flex flex-col p-4">
      <div className="flex items-center justify-between mb-3 pr-16">
        <div className="flex items-center gap-3">
          <LiveClock />
          <div className="text-[10px] wordmark opacity-70">Conversation</div>
        </div>
        <button
          onClick={() => alphaStore.clearChat()}
          className="text-[10px] wordmark opacity-70 hover:opacity-100"
        >
          Clear
        </button>
      </div>

      <OutstandingRemindersAffordance />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative flex-1 min-h-0 overflow-y-auto space-y-3 pr-1"
      >
        {chat.length === 0 && (
          <div className="text-center text-muted-foreground text-sm mt-16">
            <Sparkles className="w-6 h-6 mx-auto mb-2 text-primary" /> Say something or type to
            begin.
          </div>
        )}
        {chat.map((m) => {
          if (m.error) {
            return (
              <div
                key={m.id}
                className="rounded-xl px-3 py-2 bg-destructive/15 border border-destructive/40 text-destructive-foreground text-sm"
              >
                {m.text}
                <div className="mt-1">
                  <MessageActions
                    text={m.text}
                    compact
                    onDelete={() => alphaStore.deleteChatMessage(m.id)}
                    onRetry={() => retry(m.id)}
                  />
                </div>
              </div>
            );
          }
          if (m.origin === "proactive" || m.proactiveEventId) {
            return (
              <NotificationCard
                key={m.id}
                messageId={m.id}
                proactiveEventId={m.proactiveEventId || m.id}
                text={m.text}
                ts={m.ts}
              >
                <div className="mt-1">
                  <MessageActions
                    text={m.text}
                    compact
                    onDelete={() => alphaStore.deleteChatMessage(m.id)}
                    onRetry={() => retry(m.id)}
                  />
                </div>
              </NotificationCard>
            );
          }
          return (
            <HudBubble
              key={m.id}
              side={m.role === "user" ? "user" : "assistant"}
              label={m.role === "user" ? "YOU" : "ALPHA"}
            >
              {m.images?.map((src, i) => (
                <img key={i} src={src} className="rounded-lg max-h-40 mb-2 max-w-full" alt="" />
              ))}
              {m.role === "model" ? (
                <MessageContent text={m.text} />
              ) : (
                <div className="whitespace-pre-wrap">{m.text}</div>
              )}
              <div className="mt-1">
                <MessageActions
                  text={m.text}
                  compact
                  onDelete={() => alphaStore.deleteChatMessage(m.id)}
                  onRetry={() => retry(m.id)}
                />
              </div>
            </HudBubble>
          );
        })}
        {(busy || (act.kind !== "idle" && act.kind !== "listening")) && (
          <div className="flex items-center justify-center gap-2 py-2 select-none">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            <span className="text-xs text-primary/80 font-mono tracking-wide animate-pulse">
              {activity.label(act) || "Thinking…"}
            </span>
          </div>
        )}
      </div>

      {showJump && (
        <div className="absolute right-4 top-14 z-20 flex flex-col gap-2">
          <button
            onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="Top"
            className="hud-bubble p-2 active:scale-95 shadow-md"
          >
            <ArrowUp className="w-4 h-4 text-primary" />
          </button>
          <button
            onClick={() => scrollToBottom(true)}
            aria-label="Bottom"
            className="hud-bubble p-2 active:scale-95 shadow-md"
          >
            <ArrowDown className="w-4 h-4 text-primary" />
          </button>
        </div>
      )}

      {images.length > 0 && (
        <div className="pt-2 flex gap-2 overflow-x-auto">
          {images.map((src, i) => (
            <div key={i} className="relative shrink-0">
              <img src={src} className="w-14 h-14 rounded-lg object-cover" alt="" />
              <button
                onClick={() => setImages(images.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 bg-destructive rounded-full p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="pt-2 flex items-center gap-1.5 overflow-x-auto">
        <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
        {(["auto", "fast", "thinking", "coding"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTask(t)}
            className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${task === t ? "bg-primary text-primary-foreground border-primary" : "hud-bubble text-muted-foreground"}`}
          >
            {t === "auto"
              ? "Auto"
              : t === "fast"
                ? "⚡ Fast"
                : t === "thinking"
                  ? "🧠 Deep"
                  : "🛠 Code"}
          </button>
        ))}
      </div>
      <div className="pt-2 flex flex-col gap-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onInput={autoGrow}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message Alpha…"
          rows={2}
          className="w-full min-w-0 bg-input/60 rounded-2xl px-4 py-3 border border-primary/40 outline-none focus:border-primary resize-none min-h-[56px] max-h-44 overflow-y-auto text-sm leading-6 break-words [overflow-wrap:anywhere]"
        />
        <div className="flex items-center gap-1.5">
          <label
            className="cursor-pointer p-2 rounded-lg hud-bubble shrink-0"
            aria-label="Upload image"
          >
            <ImagePlus className="w-5 h-5 text-primary" />
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => pickImages(e.target.files)}
            />
          </label>
          <button
            onClick={() => send()}
            disabled={busy}
            className="ml-auto p-2.5 rounded-xl bg-primary text-primary-foreground neon-border disabled:opacity-50 shrink-0"
            aria-label="Send"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </HudPanel>
  );
}
