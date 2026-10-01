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
  /** Absolute turn deadline in monotonic time (ms) */
  deadlineMs?: number;
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

export function getMonotonicTimeMs(): number {
  if (typeof process !== "undefined" && process.hrtime && typeof process.hrtime.bigint === "function") {
    return Number(process.hrtime.bigint()) / 1000000;
  }
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  throw new Error("No monotonic clock source available.");
}

export class WholeTurnTimeoutError extends Error {
  status = 504;
  code = "WHOLE_TURN_TIMEOUT";
  constructor(message = "Whole-turn deadline expired.") {
    super(message);
    this.name = "TimeoutError";
  }
}

const sleep = (ms: number, signal?: AbortSignal) => 
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err: any = new Error("Aborted");
      err.name = "AbortError";
      return reject(err);
    }
    const onAbort = () => {
      clearTimeout(timer);
      const err: any = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

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
 * Now supports all common reasoning, thinking, and tool-call header patterns recursively.
 */
export function stripLeakedThinking(text: string): string {
  if (!text) return "";
  let t = text;
  
  // 1. Remove known XML tags containing thinking or tool calls
  const tagsToStrip = [
    "think", "thinking", "reasoning", "analysis", "thought", "internal_monologue",
    "thought_process", "tool_call", "call", "function_call", "scratchpad"
  ];
  for (const tag of tagsToStrip) {
    const rx = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi");
    t = t.replace(rx, "");
    // Also remove unclosed tags at the very start/end
    const startRx = new RegExp(`^<${tag}>[\\s\\S]*$`, "i");
    const endRx = new RegExp(`^[\\s\\S]*?<\\/${tag}>$`, "i");
    t = t.replace(startRx, "").replace(endRx, "");
  }
  
  // 2. Remove block patterns with clear final headers
  const blockRegexes = [
    // Pattern A: Restrictive reasoning-to-answer transition.
    // Uses high-confidence internal identifiers and definitive final-answer markers only.
    /^(?:here'?s\s+(?:a|my)\s+)?(?:thinking process|thought process|internal monologue|internal dialogue)\s*:?[\s\S]*?(?:\n\s*(?:final answer|final response)\s*:?\s*)/i,
    // Pattern B: High-confidence unambiguous internal headers that can be stripped if they occupy the whole string.
    /^(?:thinking process|thought process|internal monologue|internal dialogue)\s*:?[\s\S]*$/i,
    /^<ctrl94>\s*(?:thinking|thought|reasoning)[\s\S]*?(?:\n\n|$)/im, // Blockquote thinking
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
  const extractedToolCalls: any[] = toolCalls ? [...toolCalls] : [];

  // 1. Extract from tags in content if present (Thinking & XML Tool Calls)
  const thinkingTags = ["think", "thinking", "reasoning", "analysis", "thought", "internal_monologue", "thought_process"];
  for (const tag of thinkingTags) {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    let startIndex = finalText.toLowerCase().indexOf(startTag);
    while (startIndex !== -1) {
      const endIndex = finalText.toLowerCase().indexOf(endTag, startIndex + startTag.length);
      if (endIndex !== -1) {
        const block = finalText.slice(startIndex + startTag.length, endIndex).trim();
        if (block && !internalReasoning.includes(block)) {
          internalReasoning += (internalReasoning ? "\n" : "") + block;
        }
        finalText = finalText.slice(0, startIndex) + finalText.slice(endIndex + endTag.length);
      } else {
        const block = finalText.slice(startIndex + startTag.length).trim();
        if (block && !internalReasoning.includes(block)) {
          internalReasoning += (internalReasoning ? "\n" : "") + block;
        }
        finalText = finalText.slice(0, startIndex);
      }
      startIndex = finalText.toLowerCase().indexOf(startTag);
    }
  }

  // 2. Fallback: Parse XML tool calls if native tool calls are missing (fixes Screenshot 7 leakage)
  if (extractedToolCalls.length === 0) {
    // Regex to find <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>
    // or similar variants used by non-native-tool models
    const toolCallMatch = finalText.match(/<tool_call>[\s\S]*?<\/tool_call>/gi);
    if (toolCallMatch) {
      for (const rawCall of toolCallMatch) {
        const fnNameMatch = rawCall.match(/<function=([^>]+)>/i);
        if (fnNameMatch) {
          const fnName = fnNameMatch[1].trim();
          const args: any = {};
          const paramMatches = rawCall.matchAll(/<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi);
          for (const pm of paramMatches) {
            args[pm[1].trim()] = pm[2].trim();
          }
          extractedToolCalls.push({
            id: `call_xml_${Math.random().toString(36).slice(2, 11)}`,
            type: "function",
            function: { name: fnName, arguments: JSON.stringify(args) }
          });
        }
        finalText = finalText.replace(rawCall, "");
      }
    }
  }

  // 3. Extract text-headers in content
  const headers = [
    // Match high-confidence reasoning-to-answer transition
    /^(?:here'?s\s+(?:a|my)\s+)?(?:thinking process|thought process|internal monologue|internal dialogue)\s*:?[\s\S]*?(?:\n\s*(?:final answer|final response)\s*:?\s*)/i,
    // Match high-confidence unambiguous internal headers only
    /^(?:thinking process|thought process|internal monologue|internal dialogue)\s*:?[\s\S]*$/i,
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
    toolCalls: extractedToolCalls.length > 0 ? extractedToolCalls : undefined,
    internalReasoning: internalReasoning || undefined,
    hasToolCalls: extractedToolCalls.length > 0,
    modelIdentity: model,
  };
}

/**
 * Applies strict history integrity rules and group-aware truncation.
 * Enforces exact call/result pairing before and after truncation, selectively pruning invalid groups.
 */
export function applyHistoryIntegrity(history: ChatMessage[], limit: number): ChatMessage[] {
  const allTurns = history.filter((m) => m.role !== "system");
  
  // 1. Identify and group Assistant turns with their associated tool calls/results
  const groupedTurns: ChatMessage[] = [];
  const turnResults = new Map<string, ChatMessage>(); // callId -> tool result
  const turnCalls = new Map<string, string[]>(); // modelMsgId -> callIds

  // First pass: Index everything
  for (const m of allTurns) {
    if (m.role === "model" && m.tool_calls) {
      turnCalls.set(m.id, m.tool_calls.map(tc => tc.id));
    } else if (m.role === "tool" && m.tool_call_id) {
      turnResults.set(m.tool_call_id, m);
    }
  }

  // Second pass: Validate integrity and build ordered history
  const validHistory: ChatMessage[] = [];
  const processedCallIds = new Set<string>();

  for (const m of allTurns) {
    if (m.role === "model" && m.tool_calls) {
      const callIds = turnCalls.get(m.id) || [];
      // Only keep if all tool calls have a corresponding result
      if (callIds.length > 0 && callIds.every(id => turnResults.has(id))) {
        validHistory.push(m);
        callIds.forEach(id => processedCallIds.add(id));
      } else if (callIds.length === 0) {
        validHistory.push(m);
      }
    } else if (m.role === "tool") {
      if (m.tool_call_id && processedCallIds.has(m.tool_call_id)) {
        validHistory.push(m);
      }
    } else {
      validHistory.push(m);
    }
  }

  // 2. Group-Aware Truncation
  let resolvedTurns = validHistory;
  if (resolvedTurns.length > limit) {
    let startIdx = resolvedTurns.length - limit;
    while (startIdx > 0) {
      const m = resolvedTurns[startIdx];
      const prev = resolvedTurns[startIdx - 1];
      if (
        m.role === "tool" ||
        (prev.role === "model" && prev.tool_calls && prev.tool_calls.length > 0)
      ) {
        startIdx--;
        continue;
      }
      break;
    }
    resolvedTurns = resolvedTurns.slice(startIdx);
  }

  // 3. Post-truncation revalidation (Ensure atomic groups)
  const activeCalls = new Set<string>();
  const finalTurns: ChatMessage[] = [];
  
  // To handle multi-turn atomic groups correctly after truncation, 
  // we need to ensure every tool result still has its call and vice-versa.
  for (const m of resolvedTurns) {
    if (m.role === "model" && m.tool_calls) {
      const allResultsPresent = m.tool_calls.every(tc => turnResults.has(tc.id));
      if (allResultsPresent) {
        finalTurns.push(m);
        m.tool_calls.forEach(tc => activeCalls.add(tc.id));
      }
    } else if (m.role === "tool") {
      if (m.tool_call_id && activeCalls.has(m.tool_call_id)) {
        finalTurns.push(m);
      }
    } else {
      finalTurns.push(m);
    }
  }

  return finalTurns;
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

  // 1. History Integrity & Truncation
  const limit = opts.historyTurns ?? 20;
  const turns = applyHistoryIntegrity(history, limit);

  // 2. Vision/Image Handling: Only the newest user turn keeps its images.
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
    let textContent = m.text || "";
    if (m.attachments && m.attachments.length > 0) {
      const fileContexts = m.attachments
        .map(
          (a: any) =>
            `[ATTACHED FILE: "${a.name}" (${Math.round((a.size || 0) / 1024)} KB, format: ${a.format || "doc"})]\n${a.text || ""}\n[END OF FILE "${a.name}"]`
        )
        .join("\n\n");
      textContent = textContent
        ? `${fileContexts}\n\nUser Message:\n${textContent}`
        : `${fileContexts}\n\nPlease analyze and explain this attached document.`;
    }

    if (role === "tool") {
      msg.tool_call_id = m.tool_call_id;
      msg.content = textContent;
    } else if (role === "user" && m.images?.length && opts.allowImages && keepImages) {
      const parts: any[] = [];
      if (textContent) parts.push({ type: "text", text: textContent });
      for (const img of m.images) parts.push({ type: "image_url", image_url: { url: img } });
      msg.content = parts;
    } else if (role === "user" && m.images?.length && keepImages) {
      const note = `[user attached ${m.images.length} image${m.images.length > 1 ? "s" : ""} — not visible to this text-only model]`;
      msg.content = textContent ? `${textContent}\n\n${note}` : note;
    } else if (role === "user" && m.images?.length) {
      msg.content = textContent || "[image]";
    } else {
      msg.content = textContent;
    }

    if (m.tool_calls) {
      msg.tool_calls = m.tool_calls;
    }

    messages.push(msg);
  }

  const maxAttempts = Math.max(1, (opts.retries ?? 2) + 1);
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      const err: any = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    const getRemaining = () =>
      opts.deadlineMs !== undefined
        ? Math.max(0, opts.deadlineMs - getMonotonicTimeMs())
        : (opts.allowImages ? 90_000 : 60_000);

    const remaining = getRemaining();
    if (remaining <= 0) {
      throw new WholeTurnTimeoutError(`${opts.model} timed out: whole-turn deadline expired.`);
    }

    const ctrl = new AbortController();
    const defaultTimeoutMs = opts.allowImages ? 90_000 : 60_000;
    const fetchTimeoutMs = Math.min(remaining, defaultTimeoutMs);
    const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs);
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
          temperature: 0.4, // Lower temperature for consistent Alpha presentation and identity
          stream: false,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.tools ? { tools: opts.tools } : {}),
          ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
          ...(opts.extraBody || {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        clearTimeout(timer);
        const err: any = new Error(`${opts.model} ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        err.model = opts.model;
        err.providerBody = body;

        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (retryable && attempt < maxAttempts) {
          const rem = getRemaining();
          if (rem <= 0) {
            throw new WholeTurnTimeoutError(`${opts.model} timed out: whole-turn deadline expired.`);
          }
          const wait = retryAfterMs(res, body);
          const backoff = wait ?? Math.min(8000, 700 * 2 ** (attempt - 1)) + Math.random() * 250;
          if (backoff > 12_000 || backoff > rem) {
            err.longWaitMs = backoff;
            throw err;
          }
          lastErr = err;
          await sleep(Math.min(backoff, rem), opts.signal);
          if (getRemaining() <= 0) {
            throw new WholeTurnTimeoutError(`${opts.model} timed out: whole-turn deadline expired after retry wait.`);
          }
          continue;
        }
        throw err;
      }

      const j: any = await res.json();
      clearTimeout(timer);

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
    } catch (e: any) {
      clearTimeout(timer);
      if (opts.signal?.aborted) {
        const err: any = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      if (ctrl.signal.aborted || e?.name === "AbortError" || /aborted/i.test(e?.message || "")) {
        if (getRemaining() <= 0) {
          throw new WholeTurnTimeoutError(
            `${opts.model} timed out after ${Math.round(fetchTimeoutMs / 1000)}s.`,
          );
        }
        const err: any = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      // Network blip — one bounded retry with backoff.
      lastErr = e;
      if (attempt < maxAttempts) {
        const rem = getRemaining();
        if (rem <= 0) {
          throw new WholeTurnTimeoutError(`${opts.model} timed out: whole-turn deadline expired.`);
        }
        await sleep(Math.min(500 * attempt, rem), opts.signal);
        if (getRemaining() <= 0) {
          throw new WholeTurnTimeoutError(`${opts.model} timed out: whole-turn deadline expired.`);
        }
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("Request failed.");
}
