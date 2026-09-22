import { alphaStore, conversationSummary, type ChatMessage } from "./alpha-store";
import { stripLeakedThinking } from "./openai-compat";

/** Normalise the endpoint the user typed. */
function base(): string {
  const raw = (alphaStore.get().settings.ollamaEndpoint || "").trim().replace(/\/+$/, "");
  return raw || "http://localhost:11434";
}

/** Split a data URL into { mime, base64 } for Ollama vision models. */
function splitDataUrl(u: string): { data: string } | null {
  const m = u.match(/^data:(.+?);base64,(.+)$/);
  return m ? { data: m[2] } : null;
}

/** Convert Alpha chat messages into Ollama's /api/chat shape. */
function toOllamaMessages(history: ChatMessage[]) {
  return history
    .filter((m) => m.role !== "system")
    .slice(-40)
    .map((m) => {
      const msg: any = { role: m.role === "user" ? "user" : "assistant", content: m.text || "" };
      if (m.images?.length) {
        const imgs = m.images
          .map(splitDataUrl)
          .filter(Boolean)
          .map((x) => (x as any).data);
        if (imgs.length) msg.images = imgs;
      }
      return msg;
    });
}

/** GET /api/tags — list installed local models. Used by Settings to show what's available. */
export async function listOllamaModels(endpoint?: string): Promise<string[]> {
  const root = (endpoint || base()).replace(/\/+$/, "");
  const res = await fetch(`${root}/api/tags`, { method: "GET" });
  if (!res.ok) throw new Error(`Ollama /api/tags failed: HTTP ${res.status}`);
  const j: any = await res.json();
  const models: string[] = (j?.models || []).map((m: any) => m?.name).filter(Boolean);
  return models;
}

/**
 * Local, offline chat via Ollama. Same public shape as the Gemini path in
 * alpha.functions.ts — takes the running history, returns Alpha's reply.
 * Deliberately DOES NOT claim access to web search; the system prompt below
 * tells the model it is fully offline so it stops fabricating citations.
 */
export async function sendChatOllama(
  history: ChatMessage[],
  systemPrompt: string,
  webContext = "",
): Promise<string> {
  const model = alphaStore.get().settings.ollamaModel || "llama3.2:3b";
  const url = `${base()}/api/chat`;

  const messages = [
    { role: "system", content: webContext ? `${systemPrompt}\n\n${webContext}` : systemPrompt },
    ...toOllamaMessages(history),
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_ctx: 8192,
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${t.slice(0, 300) || "no body"}`);
  }
  const j: any = await res.json();
  let text: string = (typeof j?.message?.content === "string" ? j.message.content : "").trim();
  text = stripLeakedThinking(text);
  if (!text) throw new Error("Ollama returned an empty response.");

  // Fire-and-forget rolling summary using the same local model.
  void maybeCompactLocal(history, text, model);
  return text;
}

let lastCompactAt = 0;
async function maybeCompactLocal(history: ChatMessage[], lastAssistant: string, model: string) {
  try {
    const turns = history.filter((m) => m.role !== "system").length;
    if (turns < 12 || turns - lastCompactAt < 10) return;
    lastCompactAt = turns;
    const older = history.slice(0, -10);
    if (!older.length) return;
    const transcript = older
      .slice(-40)
      .map((m) => `${m.role.toUpperCase()}: ${(m.text || "").slice(0, 300)}`)
      .join("\n");
    const previous = conversationSummary.get();
    const prompt = `Compress the chat below into a compact STATE MATRIX for the assistant "Alpha".
<=500 words, bullet sections only:
• User profile & preferences
• Active projects / topics
• Open decisions
• Facts the user told Alpha (with dates)
• Recent thread context (1 line each)
Merge with the previous state matrix, overwriting stale items. No prose.

PREVIOUS:
${previous || "(none)"}

TRANSCRIPT:
${transcript}

LAST REPLY:
${lastAssistant.slice(0, 500)}`;
    const res = await fetch(`${base()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) return;
    const j: any = await res.json();
    const out = j?.message?.content?.trim() || "";
    if (out) conversationSummary.set(out);
  } catch {
    /* background */
  }
}
