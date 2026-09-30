import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ImagePlus,
  Send,
  Sparkles,
  X,
  ArrowDown,
  ArrowUp,
  Zap,
  Menu,
  Paperclip,
  FileText,
  Camera,
  Eye,
  EyeOff,
  Square,
} from "lucide-react";
import { alphaStore, uid, useAlpha } from "../../lib/alpha-store";
import { sendChat, stopAlphaGeneration, type TaskType } from "../../lib/alpha.functions";
import { MessageContent } from "../MessageContent";
import { MessageActions } from "../MessageActions";
import { prepareUtterance, speakWith, stopSpeaking } from "../../lib/voice";
import { fileToShrunkDataUrl } from "../../lib/image-utils";
import { captureLiveFrame, handleEyeCommand, isVisionCommand, shouldCaptureFrame } from "../../lib/vision-command";
import { isActive as eyeIsActive, startEye, stopEye, subscribeActive as subEyeActive } from "../../lib/vision-stream";
import { parseUploadedFile, formatUserBubbleContent, type ParsedDocument } from "../../lib/file-parser";
import { toast } from "sonner";
import { HudPanel } from "./HudPanel";
import { HudBubble } from "./HudBubble";
import { LiveClock } from "../LiveClock";
import { useActivity, activity } from "../../lib/activity";
import { NotificationCard } from "../NotificationCard";
import { OutstandingRemindersAffordance } from "../OutstandingRemindersAffordance";
import { SessionDrawer } from "../SessionDrawer";
import { CHAT_NAV_ITEMS } from "../../lib/navigation";

const NAV = CHAT_NAV_ITEMS;

/** Full HUD chat panel rendered inside the desktop shell right column. */
export function DesktopChatPanel() {
  const chat = useAlpha((s) =>
    s.chat.filter(
      (m) =>
        !m.intermediate &&
        m.role !== "tool" &&
        (m.role !== "system" || m.error)
    )
  );
  const act = useActivity();
  const text = useAlpha((s) => s.composerText);
  const [images, setImages] = useState<string[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<ParsedDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [task, setTask] = useState<TaskType>("auto");
  const [eyeOn, setEyeOn] = useState(false);
  const [eyeError, setEyeError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const lastSubmissionRef = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });

  useEffect(() => subEyeActive(setEyeOn), []);

  async function toggleEye() {
    setEyeError("");
    if (eyeOn) {
      stopEye();
      return;
    }
    try {
      await startEye();
    } catch (e: any) {
      setEyeError(e?.message || "Camera unavailable.");
    }
  }

  async function pickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);
    for (const f of fileList) {
      try {
        const parsed = await parseUploadedFile(f);
        setAttachedFiles((prev) => [...prev, parsed]);
        toast.success(`Attached "${parsed.name}"`);
      } catch (err: any) {
        toast.error(`Could not read "${f.name}": ${err?.message || err}`);
      }
    }
  }

  function stopCurrentProcess() {
    stopAlphaGeneration();
    stopSpeaking();
    busyRef.current = false;
    setBusy(false);
    activity.set("idle");
    toast.info("Process stopped.");
  }

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
    if (busyRef.current || busy) return;
    const r = await alphaStore.prepareRetry(assistantId);
    if (!r) return;
    await send(r.userText);
  }

  async function send(overrideText?: string) {
    if (busyRef.current || busy) return;
    const rawInput = overrideText ?? (taRef.current ? taRef.current.value : text) ?? "";
    const t = rawInput.trim();
    if (!t && images.length === 0 && attachedFiles.length === 0) return;

    // Discard rapid double-clicks (identical text within 1000ms)
    const now = Date.now();
    if (t && t === lastSubmissionRef.current.text && now - lastSubmissionRef.current.ts < 1000) {
      return;
    }
    lastSubmissionRef.current = { text: t, ts: now };

    const userPromptText = t || (attachedFiles.length > 0 ? "Please analyze and explain this attached document." : "");
    const filesToAttach = attachedFiles.map((f) => ({
      name: f.name,
      size: f.size,
      format: f.type || (f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".") + 1) : "file"),
      text: f.text,
    }));

    // Synchronous guard immediately before any async execution
    busyRef.current = true;
    setBusy(true);

    const currentImages = images;
    const hasFiles = filesToAttach.length > 0;
    alphaStore.setComposerText("");
    if (taRef.current) taRef.current.value = "";
    setImages([]);
    setAttachedFiles([]);

    prepareUtterance();
    let outImages = currentImages;
    try {
      if (hasFiles) {
        activity.set("reading_file");
        await new Promise((r) => setTimeout(r, 450));
      }
      if (t && shouldCaptureFrame(t, eyeIsActive(), currentImages.length > 0)) {
        const frame = await captureLiveFrame(eyeIsActive());
        if (frame) outImages = [...outImages, frame].slice(0, 4);
      }
      await alphaStore.appendChat({
        id: uid(),
        role: "user",
        text: userPromptText,
        attachments: filesToAttach.length > 0 ? filesToAttach : undefined,
        images: outImages.length ? outImages : undefined,
        ts: Date.now(),
      });
      const reply = await sendChat(alphaStore.getCompleteHistory(), { task });
      await alphaStore.appendChat({ id: uid(), role: "model", text: reply, ts: Date.now() });
      speakWith(reply, { auto: true });
    } catch (e: any) {
      if (e?.name === "AbortError" || e?.message?.includes("aborted")) {
        return;
      }
      await alphaStore.appendChat({
        id: uid(),
        role: "system",
        text: e?.message || "Error",
        ts: Date.now(),
        error: true,
      });
    } finally {
      busyRef.current = false;
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
      <div className="flex items-center justify-between mb-3 pr-16 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <LiveClock />
          <SessionDrawer />
        </div>
        <button
          onClick={() => alphaStore.clearChat()}
          className="text-[10px] wordmark opacity-70 hover:opacity-100 shrink-0"
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
          if (m.role === "user") {
            const { attachments, displayText } = formatUserBubbleContent(m);
            return (
              <HudBubble
                key={m.id}
                side="user"
                label="YOU"
              >
                {attachments.map((att, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-background/60 border border-primary/40 text-xs text-primary mb-2 shadow-sm font-mono"
                  >
                    <FileText className="w-3.5 h-3.5 shrink-0 text-primary" />
                    <span className="font-semibold text-foreground truncate max-w-[200px]">
                      {att.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      [{att.sizeFormatted}, {att.format}]
                    </span>
                  </div>
                ))}
                {m.images?.map((src, i) => (
                  <img key={i} src={src} className="rounded-lg max-h-40 mb-2 max-w-full" alt="" />
                ))}
                {displayText && (
                  <div className="whitespace-pre-wrap">{displayText}</div>
                )}
                <div className="mt-1">
                  <MessageActions
                    text={displayText || m.text}
                    compact
                    onDelete={() => alphaStore.deleteChatMessage(m.id)}
                  />
                </div>
              </HudBubble>
            );
          }

          return (
            <HudBubble
              key={m.id}
              side="assistant"
              label="ALPHA"
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

      {attachedFiles.length > 0 && (
        <div className="pt-2 flex gap-2 overflow-x-auto">
          {attachedFiles.map((doc, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hud-bubble text-xs text-primary shrink-0"
            >
              <FileText className="w-4 h-4 text-primary" />
              <span className="max-w-[130px] truncate text-foreground font-medium">{doc.name}</span>
              <span className="text-[10px] text-muted-foreground font-mono">
                ({Math.round(doc.size / 1024)} KB)
              </span>
              <button
                onClick={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}
                className="ml-1 p-0.5 hover:text-destructive text-muted-foreground transition-colors"
                aria-label="Remove file"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {toolsOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setToolsOpen(false)} />
          <div className="absolute bottom-20 left-4 right-4 mb-2 z-40 glass neon-border rounded-2xl p-2 grid grid-cols-4 gap-2 bg-background/95 backdrop-blur-md shadow-2xl border border-primary/30">
            {NAV.map(({ to, icon: Icon, label }) => (
              <Link
                key={to}
                to={to as any}
                onClick={() => setToolsOpen(false)}
                className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl bg-background/40 hover:bg-primary/20 transition-colors active:scale-95"
              >
                <Icon className="w-5 h-5 text-primary" />
                <span className="text-[10px] text-foreground/80">{label}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {eyeError && <div className="pt-1 text-xs text-destructive">{eyeError}</div>}
      {eyeOn && (
        <div className="pt-1 text-[10px] text-primary/80">
          Live Eye on — just point and ask
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
      <div className="pt-2 flex flex-col gap-2 relative">
        <textarea
          ref={taRef}
          defaultValue={text}
          onChange={(e) => alphaStore.setComposerText(e.target.value)}
          onInput={autoGrow}
          placeholder="Message Alpha…"
          rows={2}
          className="w-full min-w-0 bg-input/60 rounded-2xl px-4 py-3 border border-primary/40 outline-none focus:border-primary resize-none min-h-[56px] max-h-44 overflow-y-auto text-sm leading-6 break-words [overflow-wrap:anywhere]"
        />
        <div className="flex items-center gap-1.5">
          {/* Item 1: Burger icon for tools menu */}
          <button
            onClick={() => {
              setToolsOpen((v) => !v);
              setAttachmentsOpen(false);
            }}
            className={`p-2 rounded-lg hud-bubble shrink-0 transition-colors ${toolsOpen ? "border-primary text-primary" : "text-primary hover:text-primary/80"}`}
            aria-label="Tools Menu"
            title="Tools Menu"
          >
            <Menu className="w-5 h-5 text-primary" />
          </button>

          {/* Item 2: Paperclip for all attachments */}
          <div className="relative shrink-0">
            <button
              onClick={() => {
                setAttachmentsOpen((v) => !v);
                setToolsOpen(false);
              }}
              className={`p-2 rounded-lg hud-bubble shrink-0 transition-colors ${attachmentsOpen || attachedFiles.length > 0 || images.length > 0 ? "border-primary text-primary" : "text-primary hover:text-primary/80"}`}
              aria-label="Attach File, Image, or Camera"
              title="Attach File, Image, or Camera"
            >
              <Paperclip className="w-5 h-5 text-primary" />
            </button>

            {attachmentsOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setAttachmentsOpen(false)}
                />
                <div className="absolute bottom-full left-0 mb-2 z-40 glass neon-border rounded-2xl p-1.5 flex flex-col gap-1 min-w-[210px] shadow-2xl bg-background/95 border border-primary/30 backdrop-blur-md animate-fade-in">
                  <label className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-primary/15 cursor-pointer text-xs text-foreground transition-colors">
                    <ImagePlus className="w-4 h-4 text-primary" />
                    <span>Upload Image</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        pickImages(e.target.files);
                        setAttachmentsOpen(false);
                      }}
                    />
                  </label>

                  <label className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-primary/15 cursor-pointer text-xs text-foreground transition-colors">
                    <Camera className="w-4 h-4 text-primary" />
                    <span>Take Photo</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      hidden
                      onChange={(e) => {
                        pickImages(e.target.files);
                        setAttachmentsOpen(false);
                      }}
                    />
                  </label>

                  <button
                    onClick={() => {
                      toggleEye();
                      setAttachmentsOpen(false);
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-primary/15 cursor-pointer text-xs text-foreground transition-colors text-left"
                  >
                    {eyeOn ? <EyeOff className="w-4 h-4 text-destructive" /> : <Eye className="w-4 h-4 text-primary" />}
                    <span>{eyeOn ? "Stop Live Eye" : "Live Cyber-Eye"}</span>
                  </button>

                  <label className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-primary/15 cursor-pointer text-xs text-foreground transition-colors">
                    <FileText className="w-4 h-4 text-primary" />
                    <span>Attach Document (.pdf, .docx, .txt...)</span>
                    <input
                      type="file"
                      accept=".pdf,.docx,.doc,.txt,.md,.csv,.json,.py,.ts,.js,.html"
                      multiple
                      hidden
                      onChange={(e) => {
                        void pickFiles(e.target.files);
                        setAttachmentsOpen(false);
                      }}
                    />
                  </label>
                </div>
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {busy ? (
              <button
                onClick={stopCurrentProcess}
                className="p-2.5 rounded-xl bg-black border border-black hover:bg-black/90 transition-all active:scale-95 shadow-none"
                aria-label="Stop Generation"
                title="Stop process"
              >
                <Square className="w-5 h-5 fill-[var(--hud-cyan)] text-[var(--hud-cyan)]" />
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={busy || busyRef.current || (!(text || "").trim() && images.length === 0 && attachedFiles.length === 0)}
                className="p-2.5 rounded-xl bg-primary text-primary-foreground neon-border disabled:opacity-50 shrink-0"
                aria-label="Send"
              >
                <Send className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </HudPanel>
  );
}
