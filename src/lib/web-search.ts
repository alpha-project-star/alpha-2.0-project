/**
 * Real-time Web Search Engine & Query Routing.
 *
 * Alpha has a built-in, multi-source live web search engine. It automatically
 * detects explicit search requests, questions about current/live information,
 * and grants to search offers, while answering standard conversation and coding
 * directly from knowledge without unnecessary latency.
 */

/** Phrasing inquiring about Alpha's search tool or internet capability itself. */
const CAPABILITY_REGEX =
  /\b(?:do\s+you\s+have|can\s+you|are\s+you\s+able\s+to|does\s+alpha\s+have|is\s+there\s+a|how\s+do\s+you)\b[^.?!]*\b(?:web\s?search(?:ing)?|search(?:\s+the)?\s+(?:web|internet|online)|browse\s+(?:the\s+)?(?:web|internet)|internet\s+access|online\s+search|search\s+tool|searching\s+ability|live\s+search)\b/i;

/** Explicit "go online / search" phrasing. */
const EXPLICIT =
  /\b(search|searching|google|googling|bing|duckduckgo|look\s+(?:it\s+)?up|browse|surf|query)\b[^.?!]*\b(web|online|internet|net|for me|this|that|it)?\b|\bweb\s?search\b|\bsearch\s+(?:the\s+)?(?:web|internet|online)\b|\blook\s+(?:this|that|it)?\s*up\s+(?:online|on the web|on the internet)\b|\bcheck\s+(?:online|the web|the internet)\b|\bverify\s+online\b/i;

/** Verbs that count as a search request when paired with online wording. */
const VERBS = /\b(check|verify|confirm|find|research|look\s+up|fact.?check)\b/i;
const ONLINE_WORDS = /\b(online|web|internet|net|sources?|citation|latest|live|news)\b/i;

/** Short affirmatives that grant a pending offer. */
const AFFIRM =
  /^(?:\s*(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|search|go on|affirmative|do|please do)\b[\s.!,]*)+$/i;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

export interface SearchProvider {
  search(query: string, limit?: number): Promise<SearchResult[]>;
  readPage(url: string): Promise<{ title: string; content: string; status: string }>;
}

let pendingOffer: { query: string; at: number } | null = null;

/** Alpha may offer once; the offer expires after 10 minutes. */
export function setPendingSearchOffer(query: string) {
  pendingOffer = { query, at: Date.now() };
}
export function clearPendingSearchOffer() {
  pendingOffer = null;
}
export function getPendingSearchOffer(): string | null {
  if (!pendingOffer) return null;
  if (Date.now() - pendingOffer.at > 10 * 60 * 1000) {
    pendingOffer = null;
    return null;
  }
  return pendingOffer.query;
}

/** Is the user asking conceptually whether Alpha has a search tool / ability? */
export function isCapabilityInquiry(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (!CAPABILITY_REGEX.test(t)) return false;
  // If the user actually provided a search subject (e.g. "can you search the web for SpaceX?"), it's an actual search!
  if (/\b(?:search|look\s+up|browse|check)\b[^.?!]*\bfor\s+[\w"'$]/i.test(t)) return false;
  return true;
}

/** Did the user explicitly ask Alpha to go online / search? */
export function isExplicitSearchRequest(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  // Ignore purely internal searches like "search my notes", "search reminders"
  if (/\bsearch\s+(?:my|the)\s+(?:notes|memories|reminders|plans|bills|chat)\b/i.test(t)) {
    return false;
  }
  if (isCapabilityInquiry(t)) {
    return false;
  }
  // Exclude algorithm, coding, and UI concepts like "binary search", "search tree", "search algorithm", "search bar", etc.
  if (
    /\b(?:binary|linear|tree|depth.?first|breadth.?first|graph|grid|heuristic|fuzzy|a\*)\s+search\b/i.test(t) ||
    /\bsearch\s+(?:algorithm|tree|bar|input|box|component|field|method|function)\b/i.test(t)
  ) {
    return false;
  }
  if (
    /\b(search|google|bing|duckduckgo)\b/i.test(t) &&
    !/\bsearch\s+(?:my|the)\s+(?:notes|memories|reminders|plans|bills|chat)\b/i.test(t)
  ) {
    return true;
  }
  if (EXPLICIT.test(t)) return true;
  if (VERBS.test(t) && ONLINE_WORDS.test(t)) return true;
  return false;
}

/**
 * Would current live information materially help this request?
 * Detects time-sensitive events, current news, market data, versions, weather, etc.
 */
export function mayBenefitFromSearch(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (isCapabilityInquiry(t)) return false;
  // Exclude greetings and pleasantries containing "today" (e.g. "how are you today?")
  if (
    /^(?:good\s+(?:morning|afternoon|evening|day)|hello|hi|hey|howdy)\b/i.test(t) &&
    !/\b(?:news|weather|price|score|stock|happened|schedule|event)\b/i.test(t)
  ) {
    return false;
  }
  if (
    /\b(?:how\s+are\s+you|how(?:\x27s|\s+is)\s+your\s+day)\b/i.test(t) &&
    !/\b(?:news|weather|price|score|stock|happened)\b/i.test(t)
  ) {
    return false;
  }
  return /\b(latest|breaking news|headlines?|stock price|crypto price|exchange rate|match score|sports score|release date|version number|weather in|weather forecast|who won|election results?|202\d|203\d|(?:news|weather|price|events?|happened|schedule)\s+today|today(?:\x27s|\s+(?:news|weather|price|events?|headlines?)))\b/i.test(
    t,
  );
}

/**
 * Decide what to do with this user turn.
 * `search: true` means the app runs a live multi-engine search and provides evidence.
 */
export type SearchDecision = {
  search: boolean;
  query?: string;
  capabilityInquiry?: boolean;
  offer?: boolean;
  reason?: string;
};

export function decideSearch(text: string): SearchDecision {
  const t = (text || "").trim();
  if (!t) return { search: false, offer: false };

  // 1. If user is asking if Alpha has web search ability, return capability inquiry
  if (isCapabilityInquiry(t)) {
    return { search: false, capabilityInquiry: true };
  }

  // 2. If an offer was pending and user affirmed
  const pending = getPendingSearchOffer();
  if (pending && AFFIRM.test(t)) {
    clearPendingSearchOffer();
    return { search: true, query: pending, reason: "granted" };
  }

  // 3. Explicit search command ("search for X", "look up X online", etc.)
  if (isExplicitSearchRequest(t)) {
    clearPendingSearchOffer();
    return { search: true, query: stripSearchPreamble(t), reason: "explicit" };
  }

  // 4. Live / time-sensitive / factual queries benefit from automatic search
  if (mayBenefitFromSearch(t)) {
    clearPendingSearchOffer();
    return { search: true, query: stripSearchPreamble(t), reason: "auto" };
  }

  return { search: false, offer: false };
}

/** Turn "can you search the web for X please" into a clean search query "X". */
export function stripSearchPreamble(text: string): string {
  let q = text
    .replace(/^\s*(?:hey\s+)?alpha[,\s]+/i, "")
    .replace(/\b(?:please|can you|could you|would you|i want you to|i need you to)\b/gi, " ")
    .replace(
      /\b(?:do a |run a |perform a )?(?:web\s?)?search(?:\s+(?:the\s+)?(?:web|internet|online))?(?:\s+for)?\b/gi,
      " ",
    )
    .replace(/\b(?:google|bing|duckduckgo)\b/gi, " ")
    .replace(/\blook\s+(?:this|that|it)?\s*up\b/gi, " ")
    .replace(/\b(?:check|verify|confirm|research|fact.?check)\b/gi, " ")
    .replace(/\b(?:online|on the web|on the internet)\b/gi, " ")
    .replace(/\bfor me\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,:;-]+|[?!.]+$/g, "")
    .trim();
  if (q.length < 3) q = text.trim();
  return q;
}

/** Sentence Alpha uses when it wants permission. */
export const SEARCH_OFFER_HINT =
  `SEARCH PERMISSION: no search ran and none is allowed this turn. Answer from your own knowledge. ` +
  `If the answer is time-sensitive or may have changed since your training, say so plainly and end by asking: ` +
  `"This may have changed since my knowledge cutoff. Would you like me to search the web?" Then stop — do not pretend to search.`;

export const SEARCH_FORBIDDEN_HINT = `SEARCH PERMISSION: no search ran this turn and none was requested. Answer from your own knowledge, flag anything uncertain, and do not imply you looked anything up.`;

export const SEARCH_CAPABILITY_HINT =
  `CAPABILITY CONFIRMATION: You DO have a real, live, accurate web search tool integrated into your engine (using live DuckDuckGo, web scraping via Jina reader, and Wikipedia retrieval). ` +
  `When asked if you have web search ability or a web searching tool, confirm clearly and enthusiastically that YES, you have a real live web search tool wired into your system. ` +
  `Explain how it works: whenever the user asks you to look something up, search the web, or asks about current news, weather, prices, or live facts, your engine fetches real-time web results with direct citation links. Invite them to test it with any query.`;

