import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Music,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
} from "lucide-react";
import { alphaStore, useAlpha, type Settings } from "../lib/alpha-store";
import { listVoices, speakWith, testKokoroTTS } from "../lib/voice";
import { listOllamaModels } from "../lib/ollama";
import { testAlarmNow, requestAlarmPermission } from "../lib/alarm-engine";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  isBrowserNotificationSupported,
} from "../lib/browser-notification-channel";
import { registerPushSubscription, unregisterPushSubscription, isPushSupported } from "../lib/push-subscription";
import { useAuth } from "../lib/auth";
import { ToolHeader } from "../components/ToolHeader";
import { KittScanner } from "../components/KittScanner";
import { MigrationDryRun } from "../components/MigrationDryRun";
import {
  addMusicFiles,
  deleteMusicTrack,
  listMusicTracks,
  playMusicByName,
  stopMusic,
  type MusicTrackMeta,
} from "../lib/music";
import {
  downloadAlphaData,
  exportAlphaData,
  importAlphaData,
  wipeAlphaData,
} from "../lib/data-portability";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [{ title: "Alpha — Settings" }, { name: "description", content: "Configure Alpha." }],
  }),
  component: SettingsRoute,
});

const KOKORO_VOICES = [
  { id: "am_michael", label: "Michael (smooth male)" },
  { id: "am_adam", label: "Adam (deep male)" },
  { id: "am_echo", label: "Echo (male)" },
  { id: "am_eric", label: "Eric (male)" },
  { id: "am_liam", label: "Liam (male)" },
  { id: "am_onyx", label: "Onyx (rich male)" },
  { id: "am_puck", label: "Puck (male)" },
  { id: "af_heart", label: "Heart (warm female)" },
  { id: "af_bella", label: "Bella (female)" },
  { id: "af_nicole", label: "Nicole (female)" },
  { id: "bf_emma", label: "Emma (British female)" },
  { id: "bm_george", label: "George (British male)" },
];

function SettingsRoute() {
  const globalSettings = useAlpha((x) => x.settings);
  const [s, setS] = useState(globalSettings);
  
  function updateSetting(patch: Partial<Settings>) {
    setS(prev => ({ ...prev, ...patch }));
  }
  const profile = useAlpha((x) => x.profile);
  const auth = useAuth();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [saved, setSaved] = useState(false);
  const [kokoroStatus, setKokoroStatus] = useState<string>("");
  const [alarmStatus, setAlarmStatus] = useState<string>("");
  const [ollamaStatus, setOllamaStatus] = useState<string>("");
  const [whisperStatus, setWhisperStatus] = useState<string>("");
  const [musicStatus, setMusicStatus] = useState<string>("");
  const [dataStatus, setDataStatus] = useState<string>("");
  const [tracks, setTracks] = useState<MusicTrackMeta[]>([]);
  const [newModel, setNewModel] = useState("");
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [openGroup, setOpenGroup] = useState<"online" | "offline" | "data" | "migration" | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    void refreshTracks();
  }, []);

  async function refreshTracks() {
    try {
      setTracks(await listMusicTracks());
    } catch {
      setTracks([]);
    }
  }

  async function uploadMusic(files: FileList | null) {
    if (!files?.length) return;
    setMusicStatus("Saving…");
    try {
      const saved = await addMusicFiles(files);
      await refreshTracks();
      setMusicStatus(
        saved.length
          ? `Saved ${saved.length} track${saved.length === 1 ? "" : "s"}.`
          : "No audio files selected.",
      );
    } catch (e: any) {
      setMusicStatus(e?.message || "Could not save music.");
    }
  }

  async function handleExport() {
    setDataStatus("Exporting…");
    try {
      const data = await exportAlphaData();
      downloadAlphaData(data);
      setDataStatus(
        `✅ Exported ${data.exportedAt.slice(0, 10)}. ${data.music.length} music track(s).`,
      );
    } catch (e: any) {
      setDataStatus(`❌ Export failed: ${e?.message || "unknown"}`);
    }
  }

  async function handleImport(file: File | null) {
    if (!file) return;
    setDataStatus("Importing…");
    try {
      const { restored } = await importAlphaData(file);
      toast.success(`Restored ${restored.length} data bucket(s). Reloading…`);
    } catch (e: any) {
      setDataStatus(`❌ Import failed: ${e?.message || "unknown"}`);
      toast.error(`Import failed: ${e?.message || "unknown"}`);
    }
  }

  async function handleWipe() {
    if (
      !confirm(
        "This permanently deletes all Alpha data — chat, notes, reminders, memories, settings, and music. This cannot be undone. Continue?",
      )
    )
      return;
    setDataStatus("Wiping…");
    await wipeAlphaData();
  }

  useEffect(() => {
    const update = () => setVoices(listVoices());
    update();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = update;
    }
  }, []);

  async function testKokoro() {
    setKokoroStatus("Testing…");
    const url = s.kokoroEndpoint.trim();
    if (!url) {
      setKokoroStatus("⚠️ No endpoint set.");
      return;
    }
    try {
      const res = await testKokoroTTS("Mm — hi. This is Alpha. Voice check, one two.", {
        endpoint: url,
        voice: s.kokoroVoice,
        speed: s.ttsRate,
      });

      if (!res.ok) {
        setKokoroStatus(`❌ Failed to connect to Kokoro: ${res.error}. Check URL & CORS on your Kokoro server.`);
        return;
      }

      if (res.audio) {
        res.audio.play().catch(() => {});
      }

      const sizeKb = ((res.blobSize || 0) / 1024).toFixed(1);
      if (res.wasFallback && res.workingUrl) {
        updateSetting({ kokoroEndpoint: res.workingUrl });
        setKokoroStatus(
          `✅ Kokoro is working (${sizeKb} KB) via ${res.workingUrl}! Updated endpoint from /v1/audio/speech to /tts to eliminate 404 retry latency.`,
        );
      } else {
        setKokoroStatus(`✅ Kokoro is working (${sizeKb} KB).`);
      }
    } catch (e: any) {
      setKokoroStatus(
        `❌ ${e?.message || "Fetch failed"}. Most likely CORS — your Kokoro server must allow this origin.`,
      );
    }
  }

  async function testOllama() {
    setOllamaStatus("Testing…");
    try {
      const models = await listOllamaModels(s.ollamaEndpoint);
      if (!models.length) {
        setOllamaStatus("⚠️ Reached Ollama, but no models installed. Run: ollama pull llama3.2:3b");
        return;
      }
      updateSetting({ ollamaModels: models });
      setOllamaStatus(`✅ Connected. ${models.length} model(s): ${models.join(", ")}`);
    } catch (e: any) {
      setOllamaStatus(
        `❌ ${e?.message || "Could not reach Ollama"}. Make sure Ollama is running with OLLAMA_ORIGINS='*'.`,
      );
    }
  }

  async function testWhisper() {
    setWhisperStatus("Testing…");
    try {
      const url = (s.whisperEndpoint || "").replace(/\/+$/, "") + "/v1/models";
      const res = await fetch(url);
      if (!res.ok) {
        setWhisperStatus(`❌ HTTP ${res.status} @ ${url}. Is faster-whisper-server running?`);
        return;
      }
      setWhisperStatus(`✅ Whisper reachable.`);
    } catch (e: any) {
      setWhisperStatus(
        `❌ ${e?.message || "Fetch failed"}. Whisper server unreachable — check URL & CORS.`,
      );
    }
  }

  const allOllamaModels = Array.from(new Set([s.ollamaModel, ...s.ollamaModels].filter(Boolean)));

  return (
    <div className="starfield min-h-screen pb-8">
      <ToolHeader
        title="Settings"
        right={
          <span
            className={`inline-flex items-center gap-1 text-[10px] tracking-wider px-2 py-0.5 rounded-full border whitespace-nowrap ${online ? "border-emerald-400/40 text-emerald-300" : "border-amber-400/40 text-amber-300"}`}
          >
            {online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {online ? "ONLINE" : "OFFLINE"}
          </span>
        }
      />

      <div className="p-4 max-w-xl mx-auto space-y-4">
        {/* ONLINE ================================================== */}
        <Group
          id="online"
          title="Online Settings"
          hint="Cloud APIs Alpha uses when you have internet."
          open={openGroup === "online"}
          onToggle={() => setOpenGroup(openGroup === "online" ? null : "online")}
        >
          <Section
            title="Groq API Key"
            hint="Fast text models (Llama, Mixtral). Free tier at console.groq.com."
          >
            <input
              type="password"
              value={s.groqApiKey}
              onChange={(e) => updateSetting({ groqApiKey: e.target.value })}
              placeholder="gsk_..."
              className="w-full bg-input rounded-md px-3 py-2 border border-border"
            />
          </Section>

          <Section
            title="OpenAI-compatible provider"
            hint="For OpenAI, DeepSeek, Together, xAI Grok, or any /v1/chat/completions endpoint."
          >
            <input
              type="text"
              value={s.openaiCompatBase}
              onChange={(e) => updateSetting({ openaiCompatBase: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            />
            <input
              type="password"
              value={s.openaiCompatKey}
              onChange={(e) => updateSetting({ openaiCompatKey: e.target.value })}
              placeholder="sk-..."
              className="w-full bg-input rounded-md px-3 py-2 border border-border"
            />
          </Section>

          <Section
            title="OpenRouter API Key"
            hint="Used by Code mode and OpenRouter-hosted models such as Qwen Coder."
          >
            <input
              type="password"
              value={s.openRouterKey}
              onChange={(e) => updateSetting({ openRouterKey: e.target.value })}
              placeholder="sk-or-..."
              className="w-full bg-input rounded-md px-3 py-2 border border-border"
            />
          </Section>

          <Section
            title="Task Routing"
            hint="Which model runs each job. Format: provider:model (providers: groq, openai, openrouter). Auto uses Fast first when its key is available; the chat composer can switch task per message. Images route to OpenRouter vision automatically."
          >
            <TaskRow
              label="⚡ Fast (chat, quick)"
              value={s.taskModels.fast}
              onChange={(v) => updateSetting({ taskModels: { ...s.taskModels, fast: v } })}
              examples={[
                "groq:llama-3.3-70b-versatile",
                "groq:llama-3.1-8b-instant",
                "openrouter:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
              ]}
            />
            <TaskRow
              label="🧠 Deep thinking"
              value={s.taskModels.thinking}
              onChange={(v) =>
                updateSetting({ taskModels: { ...s.taskModels, thinking: v } })
              }
              examples={[
                "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
                "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
                "openrouter:minimax/minimax-m3:free",
              ]}
            />
            <TaskRow
              label="🛠 Coding & debug"
              value={s.taskModels.coding}
              onChange={(v) =>
                updateSetting({ taskModels: { ...s.taskModels, coding: v } })
              }
              examples={[
                "openrouter:cohere/north-mini-code:free",
                "openrouter:minimax/minimax-m3:free",
                "openrouter:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
              ]}
            />
          </Section>

          <Section
            title="Kokoro TTS (preferred male voice)"
            hint="FastAPI (/tts) or OpenAI-compatible (/v1/audio/speech) endpoint. Empty = browser voice fallback."
          >
            <input
              type="text"
              value={s.kokoroEndpoint}
              onChange={(e) => updateSetting({ kokoroEndpoint: e.target.value })}
              placeholder="https://your-kokoro-host/tts or .../v1/audio/speech"
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            />
            <div className="text-xs text-muted-foreground mb-1">Kokoro voice</div>
            <select
              value={s.kokoroVoice}
              onChange={(e) => updateSetting({ kokoroVoice: e.target.value })}
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            >
              {KOKORO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} — {v.label}
                </option>
              ))}
            </select>
            <div className="text-xs text-muted-foreground mb-1">Rate ({s.ttsRate.toFixed(2)}x)</div>
            <input
              type="range"
              min={0.7}
              max={1.4}
              step={0.05}
              value={s.ttsRate}
              onChange={(e) => updateSetting({ ttsRate: Number(e.target.value) })}
              className="w-full"
            />
            <div className="mt-2 flex gap-2 flex-wrap">
              <button
                onClick={() => speakWith("Mm — hi. This is Alpha. Voice check, one two.")}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground"
              >
                Test voice
              </button>
              <button
                onClick={testKokoro}
                className="px-3 py-1.5 text-sm rounded-md glass neon-border"
              >
                Diagnose Kokoro
              </button>
            </div>
            {kokoroStatus && <div className="mt-2 text-xs break-words">{kokoroStatus}</div>}
          </Section>
        </Group>

        {/* OFFLINE ================================================== */}
        <Group
          id="offline"
          title="Offline Settings"
          hint="Local servers Alpha uses with no internet."
          open={openGroup === "offline"}
          onToggle={() => setOpenGroup(openGroup === "offline" ? null : "offline")}
        >
          <Section title="Ollama (local LLM)" hint="Start with: OLLAMA_ORIGINS='*' ollama serve">
            <input
              type="text"
              value={s.ollamaEndpoint}
              onChange={(e) => updateSetting({ ollamaEndpoint: e.target.value })}
              placeholder="http://localhost:11434"
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            />
            <div className="text-xs text-muted-foreground mb-1">Active local model</div>
            <select
              value={s.ollamaModel}
              onChange={(e) => updateSetting({ ollamaModel: e.target.value })}
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            >
              {allOllamaModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {!allOllamaModels.includes("llama3.2:3b") && (
                <option value="llama3.2:3b">llama3.2:3b</option>
              )}
            </select>
            <div className="flex gap-2 mb-2">
              <input
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="add another model tag e.g. qwen2.5:7b"
                className="flex-1 bg-input rounded-md px-3 py-2 border border-border text-sm"
              />
              <button
                onClick={() => {
                  const t = newModel.trim();
                  if (!t) return;
                  const list = Array.from(new Set([...(s.ollamaModels || []), t]));
                  updateSetting({ ollamaModels: list, ollamaModel: t });
                  setNewModel("");
                }}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground"
              >
                Add
              </button>
            </div>
            <button
              onClick={testOllama}
              className="px-3 py-1.5 text-sm rounded-md glass neon-border"
            >
              Detect installed models
            </button>
            {ollamaStatus && <div className="mt-2 text-xs break-words">{ollamaStatus}</div>}
          </Section>

          <Section
            title="Speech-to-Text Backend"
            hint="Auto = browser when online, Whisper when offline."
          >
            <div className="grid grid-cols-3 gap-2 mb-3">
              {(["auto", "browser", "whisper"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => updateSetting({ sttBackend: v })}
                  className={`px-3 py-2 rounded-md text-sm border ${s.sttBackend === v ? "bg-primary text-primary-foreground border-primary" : "glass neon-border"}`}
                >
                  {v === "auto" ? "Auto" : v === "browser" ? "Browser" : "Whisper (local)"}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={s.whisperEndpoint}
              onChange={(e) => updateSetting({ whisperEndpoint: e.target.value })}
              placeholder="http://localhost:8001"
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            />
            <input
              type="text"
              value={s.whisperModel}
              onChange={(e) => updateSetting({ whisperModel: e.target.value })}
              placeholder="Systran/faster-whisper-small"
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            />
            <button
              onClick={testWhisper}
              className="px-3 py-1.5 text-sm rounded-md glass neon-border"
            >
              Test Whisper
            </button>
            {whisperStatus && <div className="mt-2 text-xs break-words">{whisperStatus}</div>}
          </Section>
        </Group>

        <Group
          id="migration"
          title="Migration Dry-Run"
          hint="Audit reminders for Firestore compatibility."
          open={openGroup === "migration"}
          onToggle={() => setOpenGroup(openGroup === "migration" ? null : "migration")}
        >
          <MigrationDryRun />
        </Group>

        {/* ALPHA DATA ================================================== */}
        <Group
          id="data"
          title="Alpha Data"
          hint="Persona, voice preferences, and who Alpha is."
          open={openGroup === "data"}
          onToggle={() => setOpenGroup(openGroup === "data" ? null : "data")}
        >
          <Section title="Vision (Cyber-Eye)">
            <div className="text-xs text-muted-foreground mb-2">
              Uses the front camera. Turn on Alpha's eye from the home screen or chat. Nothing is
              saved unless you ask.
            </div>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={s.visionAmbientEnabled}
                onChange={(e) => updateSetting({ visionAmbientEnabled: e.target.checked })}
              />
              Ambient watching (Alpha comments only when the scene changes)
            </label>
            <label className="block text-xs mb-1">
              Ambient check interval: {s.visionAmbientIntervalSec}s
            </label>
            <input
              type="range"
              min={15}
              max={120}
              step={5}
              value={s.visionAmbientIntervalSec}
              onChange={(e) =>
                updateSetting({ visionAmbientIntervalSec: Number(e.target.value) })
              }
              className="w-full"
            />
          </Section>

          <Section title="Voice">
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={s.voiceEnabled}
                onChange={(e) => updateSetting({ voiceEnabled: e.target.checked })}
              />
              Voice output enabled (master switch)
            </label>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={s.autoSpeak !== false}
                onChange={(e) => updateSetting({ autoSpeak: e.target.checked })}
              />
              Speak replies automatically{" "}
              <span className="text-xs text-muted-foreground">
                (manual Speak still works when off)
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={s.autoSubmitVoice !== false}
                onChange={(e) => updateSetting({ autoSubmitVoice: e.target.checked })}
              />
              Send voice transcript automatically{" "}
              <span className="text-xs text-muted-foreground">(off = review, then tap Send)</span>
            </label>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={s.continuousListen}
                onChange={(e) => updateSetting({ continuousListen: e.target.checked })}
              />
              Continuous listening on the Orb
            </label>
            <div className="text-xs text-muted-foreground mb-1">
              Browser voice fallback (used if Kokoro is unset/unreachable)
            </div>
            <select
              value={s.preferredVoice}
              onChange={(e) => updateSetting({ preferredVoice: e.target.value })}
              className="w-full bg-input rounded-md px-3 py-2 border border-border"
            >
              <option value="">Auto (prefers male)</option>
              {voices.map((v, i) => (
                <option key={`${v.name}-${v.lang}-${i}`} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </Section>

          <Section title="Persona Extras" hint="Personal context Alpha keeps each call.">
            <textarea
              value={s.personaExtra}
              onChange={(e) => updateSetting({ personaExtra: e.target.value })}
              className="w-full bg-input rounded-md px-3 py-2 border border-border min-h-[100px]"
            />
          </Section>

          <Section
            title="Alarms & System Notifications"
            hint="Alarms and proactive reminders can surface via in-app chat alerts and OS/browser notifications. When enabled, system notifications appear even if the window is in the background."
          >
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (!isBrowserNotificationSupported()) {
                      setAlarmStatus("⚠️ Browser notifications are not supported in this environment.");
                      return;
                    }
                    const res = await requestBrowserNotificationPermission();
                    if (res.state === "granted") {
                      setAlarmStatus("✅ Browser notifications enabled. System alerts will fire when reminders become due.");
                      toast.success("Browser notifications enabled");
                    } else if (res.state === "denied") {
                      setAlarmStatus("⚠️ Browser notifications are blocked in your browser settings. Please allow notifications in site permissions.");
                      toast.error("Browser notifications blocked");
                    } else {
                      setAlarmStatus("⚠️ Notification permission was dismissed.");
                    }
                  }}
                  className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground"
                >
                  Enable browser notifications
                </button>
                <button
                  type="button"
                  onClick={() => {
                    testAlarmNow();
                    setAlarmStatus(
                      "✅ Test alarm fired — scanner alert, chime, and voice were triggered.",
                    );
                  }}
                  className="px-3 py-1.5 text-sm rounded-md glass neon-border"
                >
                  Test alarm now
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (auth.status !== "authenticated") {
                      setAlarmStatus("⚠️ Please sign in to enable background push notifications.");
                      toast.error("Sign in required for background push");
                      return;
                    }
                    if (!isPushSupported()) {
                      setAlarmStatus("⚠️ Push notifications are not supported in this browser.");
                      toast.error("Push notifications not supported");
                      return;
                    }
                    const vapidKey = (import.meta.env.VITE_VAPID_PUBLIC_KEY || "") as string;
                    if (!vapidKey) {
                      // Fallback test key if none configured in env
                      const defaultKey = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
                      const res = await registerPushSubscription(auth.user.uid, defaultKey);
                      if (res.success) {
                        setAlarmStatus("✅ Background push registered successfully.");
                        toast.success("Background push notifications enabled");
                      } else {
                        setAlarmStatus(`⚠️ Push registration failed: ${res.error?.message || "unknown"}`);
                        toast.error(res.error?.message || "Push registration failed");
                      }
                      return;
                    }
                    const res = await registerPushSubscription(auth.user.uid, vapidKey);
                    if (res.success) {
                      setAlarmStatus("✅ Background push registered successfully.");
                      toast.success("Background push notifications enabled");
                    } else {
                      setAlarmStatus(`⚠️ Push registration failed: ${res.error?.message || "unknown"}`);
                      toast.error(res.error?.message || "Push registration failed");
                    }
                  }}
                  className="px-3 py-1.5 text-sm rounded-md glass neon-border text-primary"
                >
                  Enable background push
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (auth.status !== "authenticated") {
                      setAlarmStatus("⚠️ Please sign in first.");
                      return;
                    }
                    const res = await unregisterPushSubscription(auth.user.uid);
                    if (res.success) {
                      setAlarmStatus("✅ Background push unregistered.");
                      toast.success("Background push unregistered");
                    } else {
                      setAlarmStatus(`⚠️ Unsubscribe failed: ${res.error || "unknown"}`);
                    }
                  }}
                  className="px-3 py-1.5 text-sm rounded-md glass neon-border text-destructive"
                >
                  Disable background push
                </button>
              </div>

              {alarmStatus && <div className="text-xs text-muted-foreground">{alarmStatus}</div>}

              <div className="text-xs text-muted-foreground border-t border-border/40 pt-2 flex items-center gap-1.5">
                <span>System Notification Status:</span>
                <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-background/50 border border-border">
                  {typeof window === "undefined" || !isBrowserNotificationSupported()
                    ? "unsupported"
                    : getBrowserNotificationPermission()}
                </span>
              </div>
            </div>
          </Section>

          <Section
            title="Music Library"
            hint="Store MP3/audio locally in this browser. Then ask Alpha: 'play my music', 'play [track name]', or 'stop music'."
          >
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm cursor-pointer">
              <Music className="w-4 h-4" /> Upload MP3/audio
              <input
                type="file"
                accept="audio/*,.mp3"
                multiple
                hidden
                onChange={(e) => uploadMusic(e.target.files)}
              />
            </label>
            <div className="mt-3 space-y-2">
              {tracks.length === 0 && (
                <div className="text-xs text-muted-foreground">No tracks saved yet.</div>
              )}
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-primary/20 bg-background/30 px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        setMusicStatus(await playMusicByName(track.name));
                      } catch (e: any) {
                        setMusicStatus(e?.message || "Playback failed.");
                      }
                    }}
                    className="min-w-0 text-left text-sm truncate text-primary hover:text-primary/80"
                  >
                    {track.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${track.name}`}
                    onClick={async () => {
                      await deleteMusicTrack(track.id);
                      stopMusic();
                      await refreshTracks();
                      setMusicStatus(`Deleted ${track.name}.`);
                    }}
                    className="shrink-0 rounded-md p-1.5 glass neon-border"
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </button>
                </div>
              ))}
            </div>
            {tracks.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  stopMusic();
                  setMusicStatus("Music stopped.");
                }}
                className="mt-2 px-3 py-1.5 text-sm rounded-md glass neon-border"
              >
                Stop music
              </button>
            )}
            {musicStatus && <div className="mt-2 text-xs text-muted-foreground">{musicStatus}</div>}
          </Section>

          <Section
            title="Export / Import"
            hint="Back up or move your entire Alpha state — chat, notes, reminders, memories, settings, and music — as one JSON file."
          >
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                onClick={handleExport}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" /> Export Alpha data
              </button>
              <label className="px-3 py-1.5 text-sm rounded-md glass neon-border inline-flex items-center gap-2 cursor-pointer">
                <Upload className="w-4 h-4" /> Import Alpha data
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  ref={importRef}
                  onChange={(e) => handleImport(e.target.files?.[0] || null)}
                />
              </label>
            </div>
            {dataStatus && <div className="text-xs text-muted-foreground mb-3">{dataStatus}</div>}
            <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/10">
              <div className="flex items-center gap-2 text-xs text-destructive-foreground mb-2">
                <AlertTriangle className="w-4 h-4" /> Danger zone
              </div>
              <button
                onClick={handleWipe}
                className="px-3 py-1.5 text-sm rounded-md border border-destructive/50 text-destructive-foreground hover:bg-destructive/20"
              >
                Wipe all Alpha data
              </button>
            </div>
          </Section>

          <Section
            title="About You"
            hint="Alpha uses this to recognise and address you personally."
          >
            <input
              type="text"
              value={profile.name}
              onChange={(e) => alphaStore.setProfile({ ...profile, name: e.target.value })}
              placeholder="Your name (e.g. Alex)"
              className="w-full bg-input rounded-md px-3 py-2 border border-border mb-2"
            />
            <textarea
              value={profile.bio}
              onChange={(e) => alphaStore.setProfile({ ...profile, bio: e.target.value })}
              placeholder="Tell Alpha about yourself — role, interests, tone you prefer, anything you want him to remember about you."
              className="w-full bg-input rounded-md px-3 py-2 border border-border min-h-[100px]"
            />
          </Section>

          <Section
            title="Background Data (Watchlist)"
            hint="Topics or reminders Alpha keeps an eye on and surfaces proactively. One per line — e.g. 'Latest AI news', 'Alarm 5:00', 'Kimetsu no Yaiba release'."
          >
            <textarea
              value={s.backgroundData}
              onChange={(e) => updateSetting({ backgroundData: e.target.value })}
              placeholder="Latest AI news\nDelta intake update\n8:30 am Saturday reminder"
              className="w-full bg-input rounded-md px-3 py-2 border border-border min-h-[100px] font-mono text-xs"
            />
            <label className="flex items-center gap-2 text-sm mt-2">
              <input
                type="checkbox"
                checked={s.backgroundEnabled}
                onChange={(e) => updateSetting({ backgroundEnabled: e.target.checked })}
              />
              Background processing enabled (scanner lights on)
            </label>
          </Section>

          <Section
            title="Alpha Build Record"
            hint="Alpha's own spec sheet — he reads this so he knows himself. Edit to update his self-knowledge."
          >
            <textarea
              value={s.buildRecord}
              onChange={(e) => updateSetting({ buildRecord: e.target.value })}
              className="w-full bg-input rounded-md px-3 py-2 border border-border min-h-[160px] font-mono text-xs"
            />
          </Section>
        </Group>

        {/* Inline Save bar (was fixed & hidden behind orb — now inline) */}
        <div className="glass border border-primary/30 rounded-xl p-3 flex items-center justify-between mt-4">
          <span className="text-xs text-muted-foreground">Unsaved changes.</span>
          <button
            onClick={() => {
              alphaStore.setSettings(s);
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            }}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2"
          >
            {saved ? (
              <>
                <Check className="w-4 h-4" /> Saved
              </>
            ) : (
              "Save"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-xl p-4">
      <div className="text-sm font-semibold mb-1">{title}</div>
      {hint && <div className="text-xs text-muted-foreground mb-2">{hint}</div>}
      {children}
    </div>
  );
}

function Group({
  id,
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-primary/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`group-${id}`}
        className="w-full flex items-center gap-2 px-4 py-3 bg-primary/10 hover:bg-primary/15 transition text-left"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-primary shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-primary shrink-0" />
        )}
        <div className="flex-1">
          <div className="text-sm font-semibold tracking-wide">{title}</div>
          {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
        </div>
      </button>
      {open && (
        <div id={`group-${id}`} className="p-3 space-y-3 bg-background/20">
          {children}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  label,
  value,
  onChange,
  examples,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  examples: string[];
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="provider:model"
        className="w-full bg-input rounded-md px-3 py-2 border border-border text-sm font-mono"
      />
      <div className="mt-1 flex flex-wrap gap-1">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onChange(ex)}
            className="text-[10px] px-2 py-0.5 rounded-full glass neon-border text-muted-foreground hover:text-primary"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
