import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ImagePlus,
  Mic,
  MicOff,
  Send,
  Sparkles,
  X,
  ArrowDown,
  ArrowUp,
  NotebookPen,
  Wallet,
  Image as ImageIcon,
  Bell,
  Map,
  Brain,
  Settings as SettingsIcon,
  Menu,
  Paperclip,
  FileText,
  Square,
  Volume2,
  Copy,
  Check,
  ArrowLeft,
  Zap,
  Camera,
  Eye,
  EyeOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { alphaStore, uid, useAlpha } from "../lib/alpha-store";
import { sendChat, stopAlphaGeneration, type TaskType } from "../lib/alpha.functions";
import { parseUploadedFile, formatUserBubbleContent, type ParsedDocument } from "../lib/file-parser";
import { toast } from "sonner";
import { MessageContent } from "../components/MessageContent";
import { recognizer, prepareUtterance, speakWith, stopSpeaking } from "../lib/voice";
import { MiniOrb } from "../components/MiniOrb";
import { DesktopShell } from "../components/desktop/DesktopShell";
import { DesktopChatPanel } from "../components/desktop/DesktopChatPanel";
import { KittScanner } from "../components/KittScanner";
import { LiveClock } from "../components/LiveClock";
import { startEye, stopEye, subscribeActive as subEyeActive } from "../lib/vision-stream";
import { captureLiveFrame, handleEyeCommand, isVisionCommand, shouldCaptureFrame } from "../lib/vision-command";
import { fileToShrunkDataUrl } from "../lib/image-utils";
import { useActivity, activity } from "../lib/activity";
import { NotificationCard } from "../components/NotificationCard";
import { OutstandingRemindersAffordance } from "../components/OutstandingRemindersAffordance";
import { MessageActions } from "../components/MessageActions";
import { SessionDrawer } from "../components/SessionDrawer";
import { CHAT_NAV_ITEMS } from "../lib/navigation";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [{ title: "Alpha — Chat" }, { name: "description", content: "Talk with Alpha." }],
  }),
  component: ChatRoute,
});

const NAV = CHAT_NAV_ITEMS;

function ChatRoute() {
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
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [micError, setMicError] = useState("");
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<ParsedDocument[]>([]);
  const [task, setTask] = useState<TaskType>("auto");
  const [eyeOn, setEyeOn] = useState(false);
  const [eyeError, setEyeError] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastFinalRef = useRef("");
  const lastFinalAtRef = useRef(0);
  const busyRef = useRef(false);
  const baseTextRef = useRef("");
  const lastSubmissionRef = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });

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

  useEffect(() => subEyeActive(setEyeOn), []);
  useEffect(
    () => () => {
      stopEye();
    },
    [],
  );

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

  function scrollToBottom(smooth = true) {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  useEffect(() => {
    scrollToBottom(true);
  }, [chat.length]);
  // jump on mount
  useEffect(() => {
    setTimeout(() => scrollToBottom(false), 0);
  }, []);
  useEffect(
    () => () => {
      recognizer.stop();
      stopSpeaking();
    },
    [],
  );

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  }

  /** Regenerate an assistant reply: drop it, then re-send the user turn. */
  async function retry(assistantId: string) {
    if (busyRef.current || busy) return;
    const r = await alphaStore.prepareRetry(assistantId);
    if (!r) return;
    await send(r.userText, { skipAppend: true });
  }

  async function send(overrideText?: string, opts?: { skipAppend?: boolean }) {
    if (busyRef.current || busy) return;
    const t = (overrideText ?? text ?? "").trim();
    if (!t && images.length === 0 && attachedFiles.length === 0) return;

    // Discard rapid double-clicks (identical text within 1000ms)
    const now = Date.now();
    if (!opts?.skipAppend && t && t === lastSubmissionRef.current.text && now - lastSubmissionRef.current.ts < 1000) {
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
    setImages([]);
    setAttachedFiles([]);

    prepareUtterance();
    let outImages = currentImages;
    try {
      if (hasFiles) {
        activity.set("reading_file");
        await new Promise((r) => setTimeout(r, 450));
      }
      if (t && shouldCaptureFrame(t, eyeOn, currentImages.length > 0)) {
        const frame = await captureLiveFrame(eyeOn);
        if (frame) outImages = [...outImages, frame].slice(0, 4);
      }
      if (!opts?.skipAppend) {
        await alphaStore.appendChat({
          id: uid(),
          role: "user",
          text: userPromptText,
          attachments: filesToAttach.length > 0 ? filesToAttach : undefined,
          images: outImages.length ? outImages : undefined,
          ts: Date.now(),
        });
      }
      const reply = await sendChat(alphaStore.get().chat, { task });
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

  async function toggleMic() {
    prepareUtterance();
    if (listening) {
      recognizer.stop();
      setListening(false);
      setMicError("");
      return;
    }
    setMicError("");
    baseTextRef.current = alphaStore.get().composerText;

    recognizer.setHandlers({
      onInterim: (t) => {
        const combined = baseTextRef.current + (baseTextRef.current ? " " : "") + t;
        alphaStore.setComposerText(combined);
      },
      onFinal: (t) => {
        const trimmed = (t || "").trim();
        if (!trimmed) return;
        // Guard against the recogniser emitting the same final twice.
        if (trimmed === lastFinalRef.current && Date.now() - lastFinalAtRef.current < 4000) return;
        lastFinalRef.current = trimmed;
        lastFinalAtRef.current = Date.now();

        const combined = baseTextRef.current + (baseTextRef.current ? " " : "") + trimmed;
        alphaStore.setComposerText(combined);
        baseTextRef.current = combined;

        // CRITICAL: Explicitly ensure NO auto-send in the chat transcriber.
        // We do NOT call recognizer.stop() here so it stays listening (continuous).
        console.log("[chat] Transcription segment committed:", trimmed);
      },
      onStart: () => {
        setListening(true);
        // Refresh base text on every start to handle seamless Android restarts
        baseTextRef.current = alphaStore.get().composerText;
      },
      onStop: () => {
        if (!recognizer.isWanted) {
          setListening(false);
        }
      },
      onError: (e) => {
        setListening(false);
        setMicError(e);
      },
    });
    recognizer.start();
  }

  return (
    <>
      {/* Desktop layout — blueprint HUD */}
      <DesktopShell active={listening} onMicToggle={toggleMic} right={<DesktopChatPanel />} />
      {/* Mobile layout */}
      <div className="lg:hidden starfield h-[100dvh] flex flex-col overflow-hidden w-full max-w-full">
        <header className="glass border-b border-primary/20 shrink-0 z-30">
          <div className="grid grid-cols-[88px_1fr_88px] items-center gap-2 px-3 py-3 relative">
            <div className="flex items-center gap-1.5 min-w-0 justify-start">
              <Link to="/" aria-label="Back" className="p-1.5 rounded-full glass neon-border">
                <ArrowLeft className="w-4 h-4 text-primary" />
              </Link>
              <LiveClock className="text-left text-[10px] [&_.font-mono]:tracking-wide" />
            </div>
            <div className="flex items-center justify-center">
              <MiniOrb size={56} />
            </div>
            <div className="flex items-center gap-1.5 min-w-0 justify-end">
              <button
                onClick={() => alphaStore.clearChat()}
                className="text-[10px] text-muted-foreground px-1.5 hover:text-foreground"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="px-3 pb-2">
            <KittScanner state={listening ? "scanning" : "idle"} bars={22} height={10} />
          </div>
        </header>

        {/* Floating Session / History Drawer at the spot marked in red */}
        <div className="fixed left-3 top-28 z-40 pointer-events-auto">
          <SessionDrawer />
        </div>

        <div className="px-3 pt-2">
          <OutstandingRemindersAffordance />
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-4 space-y-4 relative w-full max-w-full"
        >
          {chat.length === 0 && (
            <div className="text-center text-muted-foreground text-sm mt-20">
              <Sparkles className="w-6 h-6 mx-auto mb-2 text-primary" /> Say something or type to
              begin.
            </div>
          )}
          {chat.map((m) => {
            if (m.role === "tool") return null;
            if (m.role === "model" && !m.text && m.tool_calls?.length) return null;
            
            if (m.role === "user") {
              const { attachments, displayText } = formatUserBubbleContent(m);
              return (
                <div key={m.id} className="flex w-full min-w-0 justify-end">
                  <div className="max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2 bg-primary/20 border border-primary/40 break-words [overflow-wrap:anywhere] [word-break:break-word]">
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
                      <img
                        key={i}
                        src={src}
                        className="rounded-lg max-h-48 mb-2 max-w-full"
                        alt=""
                      />
                    ))}
                    {displayText && (
                      <div className="whitespace-pre-wrap text-sm break-words [overflow-wrap:anywhere]">
                        {displayText}
                      </div>
                    )}
                    <MessageActions
                      text={displayText || m.text}
                      compact
                      onDelete={() => alphaStore.deleteChatMessage(m.id)}
                    />
                  </div>
                </div>
              );
            }
            if (m.error) {
              return (
                <div
                  key={m.id}
                  className="w-full min-w-0 rounded-xl px-3 py-2 bg-destructive/15 border border-destructive/40 text-destructive-foreground text-sm break-words [overflow-wrap:anywhere]"
                >
                  {m.text}
                  <MessageActions
                    text={m.text}
                    compact
                    onDelete={() => alphaStore.deleteChatMessage(m.id)}
                    onRetry={() => retry(m.id)}
                  />
                </div>
              );
            }
            
            // Proactive reminder notification card
            if (m.origin === "proactive" || m.proactiveEventId) {
              return (
                <NotificationCard
                  key={m.id}
                  messageId={m.id}
                  proactiveEventId={m.proactiveEventId || m.id}
                  text={m.text}
                  ts={m.ts}
                >
                  <MessageActions
                    text={m.text}
                    onDelete={() => alphaStore.deleteChatMessage(m.id)}
                    onRetry={() => retry(m.id)}
                  />
                </NotificationCard>
              );
            }

            // assistant: NO bubble — full width like ChatGPT/Gemini
            return (
              <div
                key={m.id}
                className="w-full min-w-0 overflow-hidden px-1 py-2 break-words [overflow-wrap:anywhere] [word-break:break-word]"
              >
                {m.images?.map((src, i) => (
                  <img key={i} src={src} className="rounded-lg max-h-60 mb-2 max-w-full" alt="" />
                ))}
                <MessageContent text={m.text} />
                <MessageActions
                  text={m.text}
                  onDelete={() => alphaStore.deleteChatMessage(m.id)}
                  onRetry={() => retry(m.id)}
                />
              </div>
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
          <div
            className="fixed right-3 top-28 z-40 flex flex-col gap-2"
          >
            <button
              onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
              aria-label="Top"
              className="glass rounded-full p-2 neon-border active:scale-95 opacity-90 shadow-md backdrop-blur-md"
            >
              <ArrowUp className="w-4 h-4 text-primary" />
            </button>
            <button
              onClick={() => scrollToBottom(true)}
              aria-label="Bottom"
              className="glass rounded-full p-2 neon-border active:scale-95 shadow-md backdrop-blur-md"
            >
              <ArrowDown className="w-4 h-4 text-primary" />
            </button>
          </div>
        )}

        {images.length > 0 && (
          <div className="px-3 pb-2 flex gap-2 overflow-x-auto">
            {images.map((src, i) => (
              <div key={i} className="relative shrink-0">
                <img src={src} className="w-16 h-16 rounded-lg object-cover" alt="" />
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
          <div className="px-3 pb-2 flex gap-2 overflow-x-auto">
            {attachedFiles.map((doc, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl glass neon-border text-xs text-primary shrink-0"
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

        <div className="p-3 glass border-t border-primary/20 relative shrink-0 z-20">
          {toolsOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setToolsOpen(false)} />
              <div className="absolute bottom-full left-2 right-2 mb-2 z-20 glass neon-border rounded-2xl p-2 grid grid-cols-4 gap-2">
                {NAV.map(({ to, icon: Icon, label }) => (
                  <Link
                    key={to}
                    to={to as any}
                    onClick={() => setToolsOpen(false)}
                    className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl bg-background/40 active:scale-95"
                  >
                    <Icon className="w-5 h-5 text-primary" />
                    <span className="text-[10px] text-foreground/80">{label}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
          {micError && <div className="mb-2 text-xs text-destructive">{micError}</div>}
          {eyeError && <div className="mb-2 text-xs text-destructive">{eyeError}</div>}
          {eyeOn && (
            <div className="mb-2 text-[10px] text-primary/80">
              Live Eye on — just point and ask ("what's on my head?")
            </div>
          )}
          <div className="mb-2 flex items-center gap-1.5 overflow-x-auto">
            <Zap className="w-3.5 h-3.5 text-primary shrink-0" />
            {(["auto", "fast", "thinking", "coding"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTask(t)}
                className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${task === t ? "bg-primary text-primary-foreground border-primary" : "glass neon-border text-muted-foreground"}`}
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
          {/* Composer: full-width growing textarea, all controls docked on the left row below */}
          <div className="flex flex-col gap-2">
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => {
                alphaStore.setComposerText(e.target.value);
                if (listening) baseTextRef.current = e.target.value;
              }}
              onInput={autoGrow}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Message Alpha…"
              rows={2}
              className="w-full min-w-0 bg-input rounded-2xl px-4 py-3 border border-border outline-none focus:border-primary resize-none min-h-[56px] max-h-44 overflow-y-auto text-base leading-6 break-words [overflow-wrap:anywhere]"
            />
            <div className="flex items-center gap-1.5">
              {/* Item 1: Burger menu for tools */}
              <button
                onClick={() => {
                  setToolsOpen((v) => !v);
                  setAttachmentsOpen(false);
                }}
                className={`p-2 rounded-lg glass shrink-0 transition-colors ${toolsOpen ? "border-primary text-primary" : "text-primary hover:text-primary/80"}`}
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
                  className={`p-2 rounded-lg glass shrink-0 transition-colors ${attachmentsOpen || attachedFiles.length > 0 || images.length > 0 ? "border-primary text-primary" : "text-primary hover:text-primary/80"}`}
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
                      {/* 1. Upload Image */}
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

                      {/* 2. Take Photo */}
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

                      {/* 3. Live Cyber-Eye */}
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

                      {/* 4. Attach Document / File */}
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
                <button
                  onClick={toggleMic}
                  className="p-2 rounded-lg glass"
                  aria-label="Microphone"
                >
                  {listening ? (
                    <MicOff className="w-5 h-5 text-destructive" />
                  ) : (
                    <Mic className="w-5 h-5 text-primary" />
                  )}
                </button>
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
                    className="p-2.5 rounded-xl bg-primary text-primary-foreground neon-border disabled:opacity-50"
                    aria-label="Send"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

