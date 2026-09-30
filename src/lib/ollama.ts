import { alphaStore, conversationSummary, type ChatMessage } from "./alpha-store";
import { stripLeakedThinking, extractNormalizedResponse, getMonotonicTimeMs, type NormalizedChatResponse } from "./openai-compat";

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

/** Convert Alpha chat messages into Ollama's /api/chat shape with tool integrity. */
function toOllamaMessages(history: ChatMessage[]) {
  // 1. History Integrity: Ensure assistant tool-calls and tool-results are always paired, unique, and sequential.
  const allTurns = history.filter((m) => m.role !== "system");
  const validMessages: ChatMessage[] = [];
  const pendingCalls = new Set<string>();
  const seenCallIds = new Set<string>();
  const seenResultIds = new Set<string>();

  for (const m of allTurns) {
    if (m.role === "model" && m.tool_calls && m.tool_calls.length > 0) {
      // Reject duplicate call IDs and ensure sequence
      const newCalls = m.tool_calls.filter((tc: any) => tc.id && !seenCallIds.has(tc.id));
      if (newCalls.length > 0) {
        validMessages.push({ ...m, tool_calls: newCalls });
        newCalls.forEach((tc: any) => {
          pendingCalls.add(tc.id);
          seenCallIds.add(tc.id);
        });
      }
    } else if (m.role === "tool") {
      // Tool result MUST match a pending call ID and cannot be a duplicate result
      if (m.tool_call_id && pendingCalls.has(m.tool_call_id) && !seenResultIds.has(m.tool_call_id)) {
        validMessages.push(m);
        pendingCalls.delete(m.tool_call_id);
        seenResultIds.add(m.tool_call_id);
      }
    } else {
      validMessages.push(m);
    }
  }

  // Final check: Remove any assistant calls whose results were lost/orphaned
  let resolvedTurns = validMessages.filter((m) => {
    if (m.role === "model" && m.tool_calls && m.tool_calls.length > 0) {
      return m.tool_calls.every((tc: any) => seenResultIds.has(tc.id));
    }
    return true;
  });

  // 2. Group-Aware Truncation: Never split a tool-call from its results at the boundary.
  const limit = 40;
  if (resolvedTurns.length > limit) {
    let startIdx = resolvedTurns.length - limit;
    while (startIdx > 0) {
      const m = resolvedTurns[startIdx];
      const prev = resolvedTurns[startIdx - 1];
      // Do not start with a tool result or split a call from its results
      if (m.role === "tool" || (prev.role === "model" && prev.tool_calls && prev.tool_calls.length > 0)) {
        startIdx--;
        continue;
      }
      break;
    }
    resolvedTurns = resolvedTurns.slice(startIdx);
  }

  return resolvedTurns.map((m) => {
      const role = m.role === "user" ? "user" : m.role === "tool" ? "tool" : "assistant";
      const msg: any = { role, content: m.text || "" };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
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
  opts?: { signal?: AbortSignal; deadlineMs?: number },
): Promise<NormalizedChatResponse> {
  const model = alphaStore.get().settings.ollamaModel || "llama3.2:3b";
  const url = `${base()}/api/chat`;

  const messages = [
    { role: "system", content: webContext ? `${systemPrompt}\n\n${webContext}` : systemPrompt },
    ...toOllamaMessages(history),
  ];

  const now = getMonotonicTimeMs();
  const rem = opts?.deadlineMs !== undefined ? Math.max(0, opts.deadlineMs - now) : 60_000;
  if (rem <= 0) {
    const err: any = new Error("Ollama timed out: whole-turn deadline expired.");
    err.status = 504;
    err.name = "TimeoutError";
    throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(rem, 60_000));
  const onAbort = () => ctrl.abort();

  if (opts?.signal) {
    if (opts.signal.aborted) {
      ctrl.abort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let res: Response;
  let j: any;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
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
    j = await res.json();
  } catch (e: any) {
    if (opts?.signal?.aborted) {
      const err: any = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    if (e?.message?.startsWith("Ollama ")) throw e;
    const err: any = new Error(`Ollama timed out after ${Math.round(rem / 1000)}s.`);
    err.status = 504;
    err.name = "TimeoutError";
    throw err;
  } finally {
    clearTimeout(timer);
    if (opts?.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
  const content = typeof j?.message?.content === "string" ? j.message.content : "";
  const reasoning = j?.message?.reasoning_content || j?.message?.reasoning || "";
  const tool_calls = j?.message?.tool_calls;
  
  const normalized = extractNormalizedResponse(content, reasoning, tool_calls, model);
  if (!normalized.finalText && !normalized.hasToolCalls) {
    throw new Error("Ollama returned an empty response.");
  }

  // Fire-and-forget rolling summary using the same local model.
  void maybeCompactLocal(history, normalized.finalText, model);
  return normalized;
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(`${base()}/api/chat`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: prompt }],
          options: { temperature: 0.2 },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return;
    const j: any = await res.json();
    let out = (typeof j?.message?.content === "string" ? j.message.content : "").trim();
    out = stripLeakedThinking(out);
    if (out) conversationSummary.set(out);
  } catch {
    /* background */
  }
}
