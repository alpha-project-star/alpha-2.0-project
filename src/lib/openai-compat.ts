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

export interface NormalizedChatResponse {
  finalText: string;
  toolCalls?: any[];
  internalReasoning?: string;
  hasToolCalls: boolean;
  modelIdentity?: string;
}

export type ChatResponse = NormalizedChatResponse;

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
 * Now supports all common reasoning and thinking header patterns recursively.
 */
export function stripLeakedThinking(text: string): string {
  if (!text) return "";
  let t = text;
  
  // Remove known XML tags containing thinking
  t = t.replace(/<(think|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi, "").trim();
  t = t.replace(/^<(think|thinking|reasoning|analysis)>[\s\S]*$/i, "").trim();
  
  // Remove block patterns with clear final headers
  const blockRegexes = [
    /^(?:here'?s\s+(?:a|my)\s+)?(?:thinking process|reasoning|thought process|internal monologue|analysis)\s*:?[\s\S]*?(?:\n\s*(?:final answer|answer|response|result)\s*:?\s*)/i,
    /^(?:thinking process|reasoning|thought process|internal monologue|analysis)\s*:?[\s\S]*$/i,
    /^(?:thinking|reasoning|thought process|internal monologue|analysis)\s*:?[\s\S]*$/i,
  ];

  for (const rx of blockRegexes) {
    const match = t.match(rx);
    if (match) {
      t = t.slice(match.index! + match[0].length).trim();
      break;
    }
  }

  // Double check if there is an unclosed tag at the start/end
  t = t.replace(/^<(think|thinking|reasoning|analysis)>[\s\S]*$/i, "").trim();
  t = t.replace(/^[\s\S]*?<\/(think|thinking|reasoning|analysis)>/i, "").trim();
  
  return t;
}

/**
 * Extracts raw content, dedicated reasoning, and tool calls into a unified,
 * normalized chat response structure. Excludes internal reasoning from the user-facing output.
 */
export function extractNormalizedResponse(
  content: string,
  reasoningContent?: string,
  toolCalls?: any[],
  model?: string
): NormalizedChatResponse {
  let finalText = (content || "").trim();
  let internalReasoning = (reasoningContent || "").trim();

  // Extract from tags in content if present
  const tags = ["think", "thinking", "reasoning", "analysis"];
  for (const tag of tags) {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    let startIndex = finalText.toLowerCase().indexOf(startTag);
    while (startIndex !== -1) {
      const endIndex = finalText.toLowerCase().indexOf(endTag, startIndex + startTag.length);
      if (endIndex !== -1) {
        const block = finalText.slice(startIndex + startTag.length, endIndex).trim();
        if (block) {
          internalReasoning += (internalReasoning ? "\n" : "") + block;
        }
        finalText = finalText.slice(0, startIndex) + finalText.slice(endIndex + endTag.length);
      } else {
        const block = finalText.slice(startIndex + startTag.length).trim();
        if (block) {
          internalReasoning += (internalReasoning ? "\n" : "") + block;
        }
        finalText = finalText.slice(0, startIndex);
      }
      startIndex = finalText.toLowerCase().indexOf(startTag);
    }
  }

  // Extract text-headers in content
  const headers = [
    /^(?:here'?s\s+(?:a|my)\s+)?(?:thinking process|reasoning|thought process|internal monologue|analysis)\s*:?[\s\S]*?(?:\n\s*(?:final answer|answer|response|result)\s*:?\s*)/i,
    /^(?:thinking process|reasoning|thought process|internal monologue|analysis)\s*:?[\s\S]*$/i,
  ];

  for (const rx of headers) {
    const match = finalText.match(rx);
    if (match) {
      const block = match[0].trim();
      if (!internalReasoning.includes(block)) {
        internalReasoning += (internalReasoning ? "\n" : "") + block;
      }
      finalText = finalText.slice(match.index! + match[0].length).trim();
      break;
    }
  }

  // Safety sanitize
  finalText = stripLeakedThinking(finalText).trim();

  return {
    finalText,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    internalReasoning: internalReasoning || undefined,
    hasToolCalls: !!(toolCalls && toolCalls.length > 0),
    modelIdentity: model,
  };
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
    const content = typeof msg?.content === "string" ? msg.content : "";
    const reasoning = msg?.reasoning_content || msg?.reasoning || "";
    
    const normalized = extractNormalizedResponse(content, reasoning, tool_calls, opts.model);
    if (!normalized.finalText && !normalized.hasToolCalls) {
      const err: any = new Error(`${opts.model} returned an empty response.`);
      err.status = 502;
      throw err;
    }
    return normalized;
  }
  throw lastErr || new Error("Request failed.");
}
