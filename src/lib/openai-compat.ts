import type { ChatMessage } from "./alpha-store";

export interface CompatOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Only true for vision-capable lanes. Text-only providers (Groq Llama)
   * hard-400 with `messages[n].content must be a string` when handed an
   * OpenAI content array, so images are flattened to text by default. */
  allowImages?: boolean;
  /** Cap the reply so one turn cannot exhaust a tokens-per-minute budget. */
  maxTokens?: number;
  /** How many prior turns to send. Smaller context = fewer tokens burned. */
  historyTurns?: number;
  /** Bounded retries for 429 / 5xx. Default 2 (so 3 attempts total). */
  retries?: number;
  /** Tools (OpenAI function calling format) */
  tools?: any[];
  /** tool_choice */
  toolChoice?: string | object;
  /** User-facing status hook ("Retrying…", "Waiting for provider…"). */
  onStatus?: (s: "waiting" | "retrying") => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  tool_calls?: any[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry-After may be seconds or an HTTP date; also parse "try again in 4.5s". */
function retryAfterMs(res: Response, body: string): number | null {
  const h = res.headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(h);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  const m = body.match(/try again in\s+([\d.]+)\s*(ms|s|m)\b/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (Number.isFinite(n)) return unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
  }
  return null;
}

/**
 * Some free reasoning models leak their scratchpad into `content`
 * ("Thinking Process: 1. Analyse the request…"). Strip a leading thinking
 * preamble and any <think> blocks so the user only sees the answer.
 */
export function stripLeakedThinking(text: string): string {
  if (!text) return "";
  let t = text;
  t = t.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  t = t.replace(/^<(think|thinking|reasoning)>[\s\S]*$/i, "").trim();
  // "Here's a thinking process:" / "Thinking Process:" / "Let me think:" blocks
  // that end at a clear answer marker.
  const marker = t.match(
    /^(?:here'?s\s+(?:a|my)\s+)?(?:thinking process|reasoning|thought process|internal monologue)\s*:?[\s\S]*?(?:\n\s*(?:final answer|answer|response)\s*:?\s*)/i,
  );
  if (marker) t = t.slice(marker[0].length).trim();
  return t;
}

/**
 * Minimal OpenAI-compatible /chat/completions caller with bounded retry and
 * rate-limit awareness. Works for Groq, OpenRouter and OpenAI itself.
 */
export async function sendChatOpenAICompat(
  history: ChatMessage[],
  systemPrompt: string,
  opts: CompatOpts,
): Promise<ChatResponse> {
  const apiKey = (opts.apiKey || "").replace(/[\s\r\n\t]+/g, "").replace(/^Bearer/i, "");
  if (!apiKey) {
    throw new Error(
      `Missing API key for ${opts.baseUrl}. Open Settings → Online and paste a valid key for this provider.`,
    );
  }
  const url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const messages: any[] = [{ role: "system", content: systemPrompt }];
  const turns = history.filter((m) => m.role !== "system").slice(-(opts.historyTurns ?? 20));
  // Only the newest user turn keeps its images — resending historical base64
  // images balloons the payload and stalls vision providers.
  const lastImageIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--)
      if (turns[i].role === "user" && turns[i].images?.length) return i;
    return -1;
  })();
  for (let idx = 0; idx < turns.length; idx++) {
    const m = turns[idx] as any;
    const role = m.role === "user" ? "user" : m.role === "tool" ? "tool" : "assistant";
    const keepImages = idx === lastImageIdx;

    const msg: any = { role };
    if (role === "tool") {
      msg.tool_call_id = m.tool_call_id;
      msg.content = m.text || "";
    } else if (role === "user" && m.images?.length && opts.allowImages && keepImages) {
      const parts: any[] = [];
      if (m.text) parts.push({ type: "text", text: m.text });
      for (const img of m.images) parts.push({ type: "image_url", image_url: { url: img } });
      msg.content = parts;
    } else if (role === "user" && m.images?.length && keepImages) {
      const note = `[user attached ${m.images.length} image${m.images.length > 1 ? "s" : ""} — not visible to this text-only model]`;
      msg.content = m.text ? `${m.text}\n\n${note}` : note;
    } else if (role === "user" && m.images?.length) {
      msg.content = m.text || "[image]";
    } else {
      msg.content = m.text || "";
    }

    if (m.tool_calls) {
      msg.tool_calls = m.tool_calls;
    }

    messages.push(msg);
  }

  const maxAttempts = Math.max(1, (opts.retries ?? 2) + 1);
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Hard timeout so a stalled provider surfaces an error instead of leaving
    // the UI stuck on "Thinking…".
    const ctrl = new AbortController();
    const timeoutMs = opts.allowImages ? 90_000 : 60_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) {
        ctrl.abort();
      } else {
        opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
      }
    }
    let res: Response;
    try {
      if (attempt > 1) {
        opts.onStatus?.("retrying");
      }
      res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(opts.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: 0.8,
          stream: false,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.tools ? { tools: opts.tools } : {}),
          ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
          ...(opts.extraBody || {}),
        }),
      });
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
        const err: any = new Error(
          `${opts.model} timed out after ${Math.round(timeoutMs / 1000)}s.`,
        );
        err.status = 504;
        throw err;
      }
      // Network blip — one bounded retry with backoff.
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err: any = new Error(`${opts.model} ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      err.model = opts.model;
      err.providerBody = body;

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (retryable && attempt < maxAttempts) {
        const wait = retryAfterMs(res, body);
        // Respect Retry-After; otherwise exponential backoff with jitter.
        // Skip waiting altogether when the provider asks for longer than we
        // are willing to block — the caller falls back to another model.
        const backoff = wait ?? Math.min(8000, 700 * 2 ** (attempt - 1)) + Math.random() * 250;
        if (backoff > 12_000) {
          err.longWaitMs = backoff;
          throw err;
        }
        lastErr = err;
        await sleep(backoff);
        continue;
      }
      throw err;
    }

    const j: any = await res.json();
    const msg = j?.choices?.[0]?.message;
    const tool_calls = msg?.tool_calls;
    let content = (typeof msg?.content === "string" ? msg.content : "").trim();
    content = stripLeakedThinking(content);
    if (!content && !tool_calls) {
      const err: any = new Error(`${opts.model} returned an empty response.`);
      err.status = 502;
      throw err;
    }
    return { content, tool_calls };
  }
  throw lastErr || new Error("Request failed.");
}
