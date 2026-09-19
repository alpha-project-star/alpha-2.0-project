import { alphaStore } from "./alpha-store";
import { GROQ_EMERGENCY_MODEL, MODEL_TRIO } from "./models";

/**
 * Voice/text intents that flip settings or return a canned answer.
 * Returns confirmation string, or null if no match.
 */
export function trySettingsIntent(raw: string): string | null {
  const original = raw.trim();
  const t = original.toLowerCase();

  // Voice on/off
  if (/(mute|silence|stop\s+speaking\s+aloud|voice\s+off|disable\s+voice)/.test(t)) {
    alphaStore.setSettings({ voiceEnabled: false });
    return "Voice replies disabled.";
  }
  if (/(unmute|voice\s+on|enable\s+voice|speak\s+aloud)/.test(t)) {
    alphaStore.setSettings({ voiceEnabled: true });
    return "Voice replies enabled.";
  }

  if (/(continuous\s+listening|hands.?free|voice.?first).*(off|disable|stop)/.test(t)) {
    alphaStore.setSettings({ continuousListen: false });
    return "Continuous listening disabled.";
  }
  if (/(continuous\s+listening|hands.?free|voice.?first).*(on|enable|start)/.test(t)) {
    alphaStore.setSettings({ continuousListen: true });
    return "Continuous listening enabled.";
  }
  if (/(background|scanner|watchlist).*(off|disable|stop)/.test(t)) {
    alphaStore.setSettings({ backgroundEnabled: false });
    return "Background processing disabled.";
  }
  if (/(background|scanner|watchlist).*(on|enable|start)/.test(t)) {
    alphaStore.setSettings({ backgroundEnabled: true });
    return "Background processing enabled.";
  }

  let mm = original.match(/(?:set|change|make)\s+(?:my\s+)?name\s+(?:to|as)\s+(.+)$/i);
  if (mm) {
    const profile = alphaStore.get().profile;
    alphaStore.setProfile({ ...profile, name: mm[1].trim() });
    return `Your name is now set to ${mm[1].trim()}.`;
  }
  mm = original.match(/(?:set|change|update)\s+(?:my\s+)?bio\s+(?:to|as)\s+(.+)$/i);
  if (mm) {
    const profile = alphaStore.get().profile;
    alphaStore.setProfile({ ...profile, bio: mm[1].trim() });
    return "Updated your profile bio.";
  }
  mm = original.match(/(?:set|change)\s+(?:kokoro\s+)?voice\s+(?:to|as)\s+([a-z]{2}_[a-z0-9_]+)/i);
  if (mm) {
    alphaStore.setSettings({ kokoroVoice: mm[1].trim() });
    return `Kokoro voice set to ${mm[1].trim()}.`;
  }
  mm = original.match(/(?:set|change)\s+(?:speech\s+)?rate\s+(?:to|as)\s+(\d+(?:\.\d+)?)/i);
  if (mm) {
    const rate = Math.max(0.7, Math.min(1.4, Number(mm[1])));
    alphaStore.setSettings({ ttsRate: rate });
    return `Speech rate set to ${rate.toFixed(2)}x.`;
  }
  mm = original.match(/(?:watch|monitor|add\s+to\s+watchlist)\s+(.+)$/i);
  if (mm) {
    const cur = alphaStore.get().settings.backgroundData.trim();
    const topic = mm[1].trim();
    alphaStore.setSettings({
      backgroundData: cur ? `${cur}\n${topic}` : topic,
      backgroundEnabled: true,
    });
    return `Added "${topic}" to Alpha's watchlist.`;
  }

  // Task model routing quick set: "use groq for fast", "use openrouter for coding"
  const m = t.match(
    /use\s+(groq|openai|openrouter)(?:\s+(\S+))?\s+for\s+(fast|thinking|deep|coding|code)/,
  );
  if (m) {
    const prov = m[1];
    const defaultForProv =
      prov === "groq"
        ? GROQ_EMERGENCY_MODEL
        : prov === "openrouter"
          ? MODEL_TRIO.capable.replace(/^openrouter:/, "")
          : "gpt-4o-mini";
    const model = m[2] || defaultForProv;
    const key: "fast" | "thinking" | "coding" = /coding|code/.test(m[3])
      ? "coding"
      : /thinking|deep/.test(m[3])
        ? "thinking"
        : "fast";
    const cur = alphaStore.get().settings.taskModels;
    alphaStore.setSettings({ taskModels: { ...cur, [key]: `${prov}:${model}` } });
    return `Set ${key} to ${prov}:${model}.`;
  }

  return null;
}
