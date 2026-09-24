import { alphaStore } from "./alpha-store";
import { GROQ_EMERGENCY_MODEL, MODEL_TRIO, isSupportedModel, ProviderId } from "./models";
import { activity } from "./activity";
import type { RequestActionLifecycle } from "./request-lifecycle";
import { getCanonicalSettingKey, getCanonicalProfileKey } from "./mutation-identity";

/**
 * Voice/text intents that flip settings or return a canned answer.
 * Returns confirmation string, or null if no match.
 */
export async function trySettingsIntent(raw: string, lifecycle?: RequestActionLifecycle): Promise<string | null> {
  const original = raw.trim();
  const t = original.toLowerCase();

  // Voice on/off
  if (/(mute|silence|stop\s+speaking\s+aloud|voice\s+off|disable\s+voice)/.test(t)) {
    activity.set("editing_settings");
    await alphaStore.setSettings({ voiceEnabled: false });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { voiceEnabled: false },
      logicalKeys: [getCanonicalSettingKey("voiceEnabled", false)],
    });
    return "Voice replies disabled.";
  }
  if (/(unmute|voice\s+on|enable\s+voice|speak\s+aloud)/.test(t)) {
    activity.set("editing_settings");
    await alphaStore.setSettings({ voiceEnabled: true });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { voiceEnabled: true },
      logicalKeys: [getCanonicalSettingKey("voiceEnabled", true)],
    });
    return "Voice replies enabled.";
  }

  if (/(continuous\s+listening|hands.?free|voice.?first).*(off|disable|stop)/.test(t)) {
    activity.set("editing_settings");
    await alphaStore.setSettings({ continuousListen: false });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { continuousListen: false },
      logicalKeys: [getCanonicalSettingKey("continuousListen", false)],
    });
    return "Continuous listening disabled.";
  }
  if (/(continuous\s+listening|hands.?free|voice.?first).*(on|enable|start)/.test(t)) {
    activity.set("editing_settings");
    await alphaStore.setSettings({ continuousListen: true });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { continuousListen: true },
      logicalKeys: [getCanonicalSettingKey("continuousListen", true)],
    });
    return "Continuous listening enabled.";
  }
  if (/(background|scanner|watchlist).*(off|disable|stop)/.test(t)) {
    activity.set("editing_settings");
    await alphaStore.setSettings({ backgroundEnabled: false });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { backgroundEnabled: false },
      logicalKeys: [getCanonicalSettingKey("backgroundEnabled", false)],
    });
    return "Background processing disabled.";
  }
  if (/(background|scanner|watchlist).*(on|enable|start)/.test(t)) {
    activity.set("editing_settings");
    await alphaStore.setSettings({ backgroundEnabled: true });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { backgroundEnabled: true },
      logicalKeys: [getCanonicalSettingKey("backgroundEnabled", true)],
    });
    return "Background processing enabled.";
  }

  let mm = original.match(/(?:set|change|make)\s+(?:my\s+)?name\s+(?:to|as)\s+(.+)$/i);
  if (mm) {
    activity.set("editing_settings");
    const nameVal = mm[1].trim();
    const profile = alphaStore.get().profile;
    await alphaStore.setProfile({ ...profile, name: nameVal });
    lifecycle?.recordSuccess({
      name: "SET_PROFILE",
      isMutation: true,
      result: { name: nameVal },
      logicalKeys: [getCanonicalProfileKey("name", nameVal)],
    });
    return `Your name is now set to ${nameVal}.`;
  }
  mm = original.match(/(?:set|change|update)\s+(?:my\s+)?bio\s+(?:to|as)\s+(.+)$/i);
  if (mm) {
    activity.set("editing_settings");
    const bioVal = mm[1].trim();
    const profile = alphaStore.get().profile;
    await alphaStore.setProfile({ ...profile, bio: bioVal });
    lifecycle?.recordSuccess({
      name: "SET_PROFILE",
      isMutation: true,
      result: { bio: bioVal },
      logicalKeys: [getCanonicalProfileKey("bio", bioVal)],
    });
    return "Updated your profile bio.";
  }
  mm = original.match(/(?:set|change)\s+(?:kokoro\s+)?voice\s+(?:to|as)\s+([a-z]{2}_[a-z0-9_]+)/i);
  if (mm) {
    activity.set("editing_settings");
    const voiceVal = mm[1].trim();
    await alphaStore.setSettings({ kokoroVoice: voiceVal });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { kokoroVoice: voiceVal },
      logicalKeys: [getCanonicalSettingKey("kokoroVoice", voiceVal)],
    });
    return `Kokoro voice set to ${voiceVal}.`;
  }
  mm = original.match(/(?:set|change)\s+(?:speech\s+)?rate\s+(?:to|as)\s+(\d+(?:\.\d+)?)/i);
  if (mm) {
    activity.set("editing_settings");
    const rate = Math.max(0.7, Math.min(1.4, Number(mm[1])));
    await alphaStore.setSettings({ ttsRate: rate });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { ttsRate: rate },
      logicalKeys: [getCanonicalSettingKey("ttsRate", rate)],
    });
    return `Speech rate set to ${rate.toFixed(2)}x.`;
  }
  mm = original.match(/(?:watch|monitor|add\s+to\s+watchlist)\s+(.+)$/i);
  if (mm) {
    activity.set("editing_settings");
    const cur = alphaStore.get().settings.backgroundData.trim();
    const topic = mm[1].trim();
    await alphaStore.setSettings({
      backgroundData: cur ? `${cur}\n${topic}` : topic,
      backgroundEnabled: true,
    });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { backgroundData: topic },
      logicalKeys: [getCanonicalSettingKey("backgroundData", topic)],
    });
    return `Added "${topic}" to Alpha's watchlist.`;
  }

  // Task model routing quick set: "use groq for fast", "use openrouter for coding"
  const m = t.match(
    /use\s+(groq|openai|openrouter)(?:\s+(\S+))?\s+for\s+(fast|thinking|deep|coding|code)/,
  );
  if (m) {
    const prov = m[1] as ProviderId;
    const defaultForProv =
      prov === "groq"
        ? GROQ_EMERGENCY_MODEL
        : prov === "openrouter"
          ? MODEL_TRIO.capable.replace(/^openrouter:/, "")
          : "gpt-4o-mini";
    const requestedModel = m[2];
    const model = requestedModel || defaultForProv;

    if (!isSupportedModel(prov, model)) {
      return `Model "${model}" is not a supported model for provider "${prov}".`;
    }

    const key: "fast" | "thinking" | "coding" = /coding|code/.test(m[3])
      ? "coding"
      : /thinking|deep/.test(m[3])
        ? "thinking"
        : "fast";
    activity.set("editing_settings");
    const cur = alphaStore.get().settings.taskModels;
    const modelVal = `${prov}:${model}`;
    await alphaStore.setSettings({ taskModels: { ...cur, [key]: modelVal } });
    lifecycle?.recordSuccess({
      name: "SET_SETTING",
      isMutation: true,
      result: { taskModel: { [key]: modelVal } },
      logicalKeys: [getCanonicalSettingKey(`taskModel:${key}`, modelVal)],
    });
    return `Set ${key} to ${modelVal}.`;
  }

  return null;
}
