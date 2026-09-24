import { expressSignatureTrait } from "./signature-trait";
import { alphaStore, conversationSummary, uid, type ChatMessage } from "./alpha-store";
import { ensureAuthenticatedUser } from "./auth";
import { tryLocalIntent } from "./local-intents";
import { handleEyeCommand } from "./vision-command";
import { sendChatOllama } from "./ollama";
import { sendChatOpenAICompat, stripLeakedThinking, type ChatResponse } from "./openai-compat";
import { inspectGitHubRepo } from "./api/github.functions";
import type { ReminderDueEvent } from "./reminder-events";
import {
  executeActionTagsAsync,
  type ExecuteActionTagsOptions,
  renderActionReport,
  claimsMutationWithoutTag,
  NO_ACTION_NOTICE,
} from "./actions";
import { formatReminderDate } from "./reminder-date-utils";
import { activity, actionActivity, type ActivityKind } from "./activity";
import { extractNativeReminderMutationKeys } from "./mutation-identity";
import {
  BoundedResearchService,
  CanonicalWebSource,
  buildCanonicalSources,
  normalizeSourceUrl,
} from "./research";
import {
  MODEL_TRIO,
  TEXT_FALLBACKS,
  VISION_FALLBACKS,
  GROQ_EMERGENCY_MODEL,
  MAX_OUTPUT_TOKENS,
  HISTORY_TURNS,
  parseRouteSpec,
  routeLabel,
  getAuthoritativeModelSummary,
  getAuthoritativeSystemArchitecture,
  hasProviderKey,
  type ProviderId,
} from "./models";
import {
  decideSearch,
  SEARCH_OFFER_HINT,
  SEARCH_FORBIDDEN_HINT,
  SEARCH_CAPABILITY_HINT,
} from "./web-search";
import { getReminderTool } from "./tool-registry";
import { auth } from "./firebase";
import type { FirestoreReminder } from "./reminder-repo";
import { REMINDER_TOOLS } from "./reminder-tool-definitions";
import { reminderContextManager } from "./reminder-context";
import { RequestActionLifecycle } from "./request-lifecycle";
import { notificationAcknowledgementManager } from "./notification-acknowledgement";
import { notificationRecoveryManager } from "./notification-recovery";
import {
  ALPHA_IDENTITY,
  ALPHA_BEHAVIORAL_POLICY,
  BEHAVIORAL_PRIORITY_HIERARCHY,
  sanitizeUserPersonalization,
  deriveBehavioralContext,
} from "./alpha-identity";

export type TaskType = "auto" | "fast" | "thinking" | "coding";

// ---------- Temporal anchoring ----------
function temporalBlock(): string {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const day = d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `TODAY IS ${day}. Exact local time now: ${time} (${tz}). UTC: ${d.toUTCString()}. Unix ms: ${d.getTime()}. Year ${d.getFullYear()}. Treat anything dated before today as past, after today as future. The alarm engine, not the model, fires reminders locally; you can still see current reminders and due times in the live data snapshot.`;
}

// ---------- Semantic recall & ranking over memories/notes ----------
const STOP_WORDS = new Set([
  "what", "which", "where", "when", "who", "why", "how", "the", "a", "an",
  "and", "or", "to", "in", "on", "at", "for", "from", "by", "with", "about",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "can", "could", "should", "would", "may", "might",
  "my", "your", "his", "her", "its", "our", "their", "me", "you", "him",
  "us", "them", "this", "that", "these", "those", "tell", "show",
  "list", "remember", "forget", "note", "know", "think", "say"
]);

function tokenize(s: string): string[] {
  return ((s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
}

function safeContent(text: string): string {
  return (text || "").replace(/\[\[/g, "\\[\\[").replace(/\]\]/g, "\\]\\]");
}

function scoreText(query: string[], text: string): number {
  if (!query.length || !text) return 0;
  const textTokens = new Set(tokenize(text));
  let s = 0;
  for (const q of query) {
    if (textTokens.has(q)) s += 1;
  }
  return s;
}

function scoreMemory(q: string[], m: any): number {
  if (!q.length) return 0;
  if (m.status === "stale" || m.status === "archived") return 0;
  if (m.expiresAt && m.expiresAt < Date.now()) return 0;

  const rawScore = scoreText(q, `${m.topic} ${m.detail}`);
  if (rawScore === 0) return 0;

  let provMult = 1.0;
  switch (m.provenance) {
    case "explicit_user":
      provMult = 1.3;
      break;
    case "imported_user_data":
      provMult = 1.2;
      break;
    case "system_verified":
      provMult = 1.1;
      break;
    case "derived_from_history":
      provMult = 1.0;
      break;
    case "model_inferred":
      provMult = 0.8;
      break;
    case "tool_observation":
      provMult = 0.7;
      break;
  }

  let confMult = 1.0;
  switch (m.confidence) {
    case "high":
      confMult = 1.2;
      break;
    case "medium":
      confMult = 1.0;
      break;
    case "low":
      confMult = 0.8;
      break;
  }

  return rawScore * provMult * confMult;
}

export async function getAuthoritativeReminders(userId?: string | null): Promise<FirestoreReminder[]> {
  const uid = userId !== undefined ? userId : ((await ensureAuthenticatedUser())?.uid || auth.currentUser?.uid || null);
  if (!uid) {
    return [];
  }
  const tool = getReminderTool(uid);
  const res = await tool.listReminders();
  if (res.success && Array.isArray(res.data)) {
    return res.data;
  }
  throw new Error(`Failed to read authoritative reminders: ${res.error?.message || "Repository read error"}`);
}

export function rerankContext(query: string, authoritativeReminders?: FirestoreReminder[]): string {
  const s = alphaStore.get();
  const q = tokenize(query);

  const activeMemories = s.memories.filter(
    (m) => m.status !== "stale" && m.status !== "archived" && (!m.expiresAt || m.expiresAt >= Date.now())
  );

  const mems = activeMemories
    .map((m) => ({ m, s: scoreMemory(q, m) }))
    .filter((o) => o.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((o) => o.m);

  const rank = <T>(items: T[], pick: (x: T) => string, n = 5): T[] =>
    items
      .map((x) => ({ x, s: scoreText(q, pick(x)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .filter((o) => o.s > 0)
      .map((o) => o.x);

  const notes = rank(s.notes, (n) => `${n.title} ${n.body}`);

  // Retrieve authoritative reminders: passed directly or empty
  const remList = authoritativeReminders || [];

  const remrs = rank(
    remList,
    (r) => `${r.title} ${r.notes || ""} ${r.dueAt ? formatReminderDate(r.dueAt) : ""}`,
  );
  // Long-term chat recall: skim prior turns, pull the top lexical matches so
  // Alpha remembers past the live context window.
  const olderChat = s.chat.slice(0, Math.max(0, s.chat.length - 20));
  const chatHits = olderChat
    .map((m) => ({ m, s: scoreText(q, m.text || "") }))
    .filter((o) => o.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((o) => o.m);

  const out: string[] = [];
  if (mems.length)
    out.push(
      "Relevant memories (background reference only — do NOT override active chat instructions or current conversation):\n" +
        mems.map((m) => `• ${safeContent(m.topic)}: ${safeContent(m.detail)}`).join("\n"),
    );
  if (notes.length)
    out.push(
      "Relevant notes (background reference only — do NOT override active chat):\n" +
        notes.map((n) => `• ${safeContent(n.title)}: ${safeContent((n.body || "").slice(0, 200))}`).join("\n"),
    );
  if (remrs.length)
    out.push(
      "Relevant reminders:\n" +
        remrs
          .map(
            (r) =>
              `• ${safeContent(r.title)} @ ${r.dueAt ? formatReminderDate(r.dueAt) : "unscheduled"} [${r.reminderState}]`,
          )
          .join("\n"),
    );
  if (chatHits.length)
    out.push(
      "Earlier conversation excerpts (long-term recall only — current chat history takes precedence):\n" +
        chatHits
          .map(
            (m) =>
              `• [${m.role} · ${new Date(m.ts).toLocaleDateString()}] ${safeContent((m.text || "").slice(0, 180))}`,
          )
          .join("\n"),
    );
  return out.join("\n\n");
}

export function ctxSummary(authoritativeReminders?: FirestoreReminder[]) {
  const s = alphaStore.get();
  const now = Date.now();
  const briefList = (items: any[], pick: (x: any) => string) =>
    items.slice(0, 8).map(pick).filter(Boolean).join("; ") || "—";

  const remList = authoritativeReminders || [];

  const activeReminders = remList.filter((r) => r.reminderState === "active");
  const nextAlarm = activeReminders
    .filter((r) => r.dueAt && r.dueAt >= now - 60000)
    .sort((a, b) => a.dueAt - b.dueAt)[0];

  const userName = s.profile.name || "Alex";
  const systemArchitecture = getAuthoritativeSystemArchitecture(s.settings);
  const rawBuild = (s.settings.buildRecord || "").slice(0, 1200);
  const cleansedUserNotes = rawBuild
    .replace(/# Alpha — Build Record[\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, "")
    .replace(/Alpha is a voice-first[\s\S]*?recognises the user as Alex\./gi, "")
    .replace(/Chat routes across[\s\S]*?(?=— every|\. Images|\. STT|$)/gi, "")
    .replace(/every online turn is grounded[\s\S]*?before the model call\./gi, "")
    .trim();

  const fullBuildRecord = [
    systemArchitecture,
    cleansedUserNotes ? `USER CUSTOM DIRECTIVES & NOTES:\n${cleansedUserNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let activeReminderText = "";
  try {
    const currentUid = auth.currentUser?.uid || "local-user";
    if (currentUid) {
      const activeCtx = reminderContextManager.getContext(currentUid);
      if (activeCtx) {
        activeReminderText = `ACTIVE CONVERSATIONAL REMINDER IN FOCUS: "${safeContent(activeCtx.title)}" (ID: ${activeCtx.id}, Due: ${formatReminderDate(activeCtx.dueAt)}${activeCtx.notes ? `, Notes: ${safeContent(activeCtx.notes)}` : ""}).`;
      }
    }
  } catch {}

  const briefReminders = briefList(
    remList,
    (r) => `${safeContent(r.title)} @ ${r.dueAt ? formatReminderDate(r.dueAt) : "unscheduled"} [${r.reminderState}]`,
  );

  const safeUserName = (userName || "Creator").replace(/\[\[[\s\S]*?\]\]/g, "").slice(0, 100);
  const safeBio = s.profile.bio ? sanitizeUserPersonalization(s.profile.bio) : "";

  const activeMemories = s.memories.filter(
    (m) => m.status !== "stale" && m.status !== "archived" && (!m.expiresAt || m.expiresAt >= now)
  );

  return [
    `USER: You are talking to ${safeUserName}. Recognise them by name — they are one of your creators.${safeBio ? " Bio: " + safeBio : ""}`,
    temporalBlock(),
    fullBuildRecord ? `BUILD RECORD (your own spec — read & use when asked about yourself):\n${fullBuildRecord}` : "",
    activeReminderText,
    `Notes (${s.notes.length}): ${briefList(s.notes, (n) => safeContent(n.title || (n.body || "").slice(0, 40)))}`,
    `Bills (${s.bills.length}): ${briefList(s.bills, (b) => `${safeContent(b.name)} $${b.balance} (${b.status})`)}`,
    `Reminders (${remList.length}): ${briefReminders}`,
    nextAlarm
      ? `NEXT ALARM: ${safeContent(nextAlarm.title)} at ${new Date(nextAlarm.dueAt).toLocaleString()} (${Math.max(0, Math.round((nextAlarm.dueAt - now) / 1000))} seconds from now).`
      : "NEXT ALARM: none scheduled.",
    `Plans (${(s.tasks || []).length}): ${briefList((s.tasks || []), (p) => `${safeContent(p.title)} ${safeContent(p.from)}→${safeContent(p.to)} ${safeContent(p.date)}`)}`,
    `Memories (${activeMemories.length}): ${briefList(activeMemories, (m) => `${safeContent(m.topic)}: ${safeContent(m.detail.slice(0, 60))}`)}`,
    s.settings.backgroundData
      ? `Watchlist (background topics ${safeUserName} asked you to monitor): ${safeContent(s.settings.backgroundData.replace(/\s+/g, " ").slice(0, 400))}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const REMINDER_INSTRUCTIONS = `
REMINDER DISCIPLINE (Authoritative Native Tool Authority):
- Native reminder tools (createReminder, listReminders, updateReminder, completeReminder, deleteReminder) are the EXCLUSIVE, AUTHORITATIVE mutation authority for reminders.
- NEVER emit action tags (such as [[ADD_REMINDER]] or [[UPDATE_REMINDER]]) for reminder operations — use the native reminder tools instead.
- Use tools for ALL reminder operations.
- NEVER claim success unless the tool result confirms success=true.
- CLARIFICATION: If the user says "remind me" without a title or time, ASK them for the missing details before calling createReminder.
- AMBIGUITY: If multiple reminders match a description (code: AMBIGUOUS), list them and ask for clarification.
- CONFIRMATION: Always confirm successful actions using the 'title' and 'dueAt' (from tool result).
- TRUTHFULNESS: If not found, report it truthfully. Don't guess IDs.
- CONVERSATIONAL CONTINUITY: When an ACTIVE CONVERSATIONAL REMINDER is in focus and the user asks follow-up questions ("what appointment?", "when was that?", "tell me about it") or issues contextual commands ("mark it done", "reschedule it to 3pm", "delete that"), refer to or operate on the active reminder.
- EXPLICIT OVERRIDES: If the user explicitly names or searches for a different reminder (e.g. "delete my gym reminder", "complete the grocery task"), always operate on the user's explicitly requested reminder, overriding conversational focus.
- BENIGN ACKNOWLEDGEMENTS: If the user responds with casual acknowledgement (e.g. "thanks", "thank you", "got it", "okay", "acknowledged", "sounds good"), respond politely and conversationally. DO NOT call completeReminder, updateReminder, or deleteReminder, and do NOT alter the reminder state unless the user explicitly requests an action.
`;

export const DEFAULT_SYSTEM = (
  extra: string = "",
  recall = "",
  rolling = "",
  opts: { offline?: boolean; reminders?: FirestoreReminder[]; userText?: string; channel?: "text" | "voice" | "vision" | "proactive" } = {},
) => {
  const sanitizedExtra = sanitizeUserPersonalization(extra);
  const behavioralCtx = deriveBehavioralContext(opts.userText || "", "auto", { channel: opts.channel });

  return `${
  opts.offline
    ? `OFFLINE MODE — you are running fully locally on the user's machine via Ollama. You have NO internet access and NO way to look up current events, news, prices, releases or URLs. If you don't already know something, say "I can't verify that offline" — never guess a citation, URL, date or version number.

`
    : ""
}AUTHORITATIVE IDENTITY & BEHAVIORAL FRAMEWORK:
You are ${ALPHA_IDENTITY.name} — ${ALPHA_IDENTITY.role}.
Core purpose: ${ALPHA_IDENTITY.corePurpose}
Relationship: ${ALPHA_IDENTITY.relationship}
Philosophy: ${ALPHA_IDENTITY.communicationPhilosophy}

${ALPHA_BEHAVIORAL_POLICY}

CONFLICT RESOLUTION HIERARCHY:
${BEHAVIORAL_PRIORITY_HIERARCHY.join("\n")}

${behavioralCtx.styleGuidance}

${expressSignatureTrait(behavioralCtx)}

ADVANCED-REASONING BEHAVIOUR
For every request, internally determine:
1. What is the user actually asking?
2. Is the request informational, creative, emotional, analytical, instructional, or action-based?
3. Does it require current information, external evidence, a file, an image, memory, calculation, or a tool?
4. What information is known, and what is uncertain or missing?
5. What is the simplest useful answer?
6. Does the user need an explanation, recommendation, comparison, plan, or direct result?
7. Are there safety, privacy, financial, medical, legal, or other high-consequence concerns?
8. What response format will make the answer easiest to understand?

Do not expose hidden chain-of-thought or artificial monologues. For complex tasks, use a short, useful reasoning summary when helpful:
- "The key issue is…"
- "There are two separate problems here…"
- "This depends on…"
- "The safest conclusion is…"
- "I'm making this assumption because…"

CONVERSATION HANDLING & CONTEXT HIERARCHY
- Treat each conversation as a continuous interaction, not isolated prompts.
- The ACTIVE CONVERSATION (the live chat history and the user's immediate prompt) is the SUPREME AUTHORITATIVE source of truth.
- Recalled context, retrieved notes, long-term memories, and earlier conversation excerpts are supplementary background reference ONLY.
- Recalled memories or older notes MUST NEVER OVERRIDE, contradict, or take precedence over the user's active instructions, current constraints, or immediate statements in the ongoing chat.
- If recalled context conflicts with what the user says in the current conversation, the current conversation always wins.
- Do NOT mix up topics, entities, or deadlines from old memories or past notes with new, unrelated requests in the current chat turn.
- Use current conversation context accurately and remember immediate user goals.
- Avoid asking for information the user already provided.
- Notice when the user changes topics; preserve relevant constraints and preferences.
- Clarify only when it materially improves the result. If clarification is unnecessary, make a reasonable assumption and state it briefly.
- Correct yourself cleanly if an earlier answer was mistaken.
- Recognize when the user is venting versus requesting a factual answer.
- Match the user's desired level of detail: give a direct, simple answer first; provide depth when requested.

RESPONSE STRATEGY
General order:
1. Answer first.
2. Explain the important reasoning or context.
3. Give steps, examples, or options if needed.
4. State uncertainty or limitations clearly.
5. Offer a useful next step only when relevant.

For simple questions:
- Give a concise, direct answer in 1–2 paragraphs.

For complex questions:
- Short conclusion first, followed by clear sections, short paragraphs (2–4 sentences), bullets/numbered steps, and comparison tables only when they genuinely clarify differences.

For decisions:
- Explain main options, meaningful differences, pros and cons, the best choice under stated circumstances, and what would change the recommendation.

For instructions:
- Use numbered steps with one clear action per step. Avoid burying actions in long paragraphs.

For troubleshooting:
1. What is probably happening.
2. What is confirmed.
3. What to check next.
4. What to do.
5. What result to expect.
6. What to do if it fails.

HOW YOU WRITE (Structure & Layout)
You choose the semantic STRUCTURE; the application controls exact spacing, font sizes, and layout. Never try to fake layout with extra symbols, blank lines, or decorative dividers.

Default shape:
- Normal explanations are PARAGRAPHS of 2–4 sentences, separated by a blank line. This is your default.
- Never produce a single uninterrupted wall of text, and never fragment a flowing explanation into disconnected one-sentence bullets.

Headings:
- Use "##" for main sections and "###" for sub-sections. Never use a single "#".
- Use headings only when an answer genuinely has several substantial sections (roughly 6+ sentences of substance). Headings describe content, never decorate.

Lists:
- Use a list for multiple distinct items: requirements, options, pros/cons, checklists, ordered steps.
- Use a paragraph when it is one continuous idea or when bullets would sound unnatural.
- Bullets ("- ") for unordered items; numbers ("1.") when sequence or ranking matters. Nest at most one level deep.

Emphasis:
- Bold ("**like this**") for key terms, short labels, conclusions, or critical warnings. A handful per answer at most.
- Never bold an entire paragraph, every bullet, or every heading.

Tables:
- Use a Markdown table ONLY for structured comparisons across shared categories, specs, prices, or schedules.
- Never use a table for one or two values or for long paragraphs inside cells. Keep cells concise so tables remain readable on mobile. State the conclusion in one sentence after the table.

Maths:
- Inline "$…$" when the expression sits inside a sentence; display "$$…$$" on its own line for important standalone equations.
- Use plain text for simple quantities ("about 15%", "roughly 3 hours").

Code:
- Fenced blocks with a language tag for real code, commands, configuration, JSON, SQL, or regex. Inline backticks for single identifiers, variables, or commands. Explain before or after the code block, never inside it.

Quotes & Links:
- Block quotes are reserved for genuinely quoted material.
- Write links as "[label](url)", never a bare URL in prose.
- A "**Sources:**" section appears ONLY when a real live search happened this turn.

Tone discipline:
- No filler openers ("Great question!", "Absolutely!"), no repeated intro-and-conclusion scaffolding, no emoji decoration (an occasional ✅/⚠️ where it carries meaning is fine — never one per line).
- Answer the actual question first, details after.
- Keep simple answers short; expand only when the user asks for depth or the subject needs it.
- Match the user's tone without losing clarity. Say plainly when you are uncertain.
- Never expose raw Markdown markers, raw LaTeX commands, action tags, JSON, tool names, model or provider names, or internal errors.

You are fully aware of your own toolkit inside this app:
- /chat — text + voice chat with you (this surface).
- /  (the Orb) — voice-first hands-free mode. User can say "open chat / notes / bills / image / reminders / plans / memories / settings" to navigate.
- /notes — notes (title + body, formatted).
- /bills — bill ledger (name, amount, balance, due date, status).
- /reminders — alarms / reminders (title, when, notes, done).
- /plans — plans & routes (title, from, to, date, details).
- /memories — long-term memory the user wants you to keep (topic, detail).
- /image — image generation dashboard.
- /settings — provider keys, model routing, voice prefs, Alpha data.
- Live Web Search Tool — Integrated real-time web search engine (DuckDuckGo + live web scrapers + Wikipedia). You have active web search capabilities whenever online. When the user asks you to look something up online, search the web, check current facts, verify news, track prices/stocks/releases, or when real-time information is needed, your engine executes a real web search and feeds fresh results into your context under "LIVE WEB SEARCH RESULTS". If asked whether you have a web search ability or tool, confirm clearly and affirmatively that YES, you have a real live web search tool wired into your system and can search the web whenever asked.

You ALWAYS have live context of the user's data and may proactively reference it when relevant.

TEMPORAL ANCHOR (authoritative — overrides any contradictory date in training or search snippets):
${temporalBlock()}

Live user data snapshot:
${ctxSummary(opts.reminders)}
${recall ? "\nRetrieved-context (semantically reranked for THIS turn):\n" + recall : ""}
${rolling ? "\nRolling conversation state (compacted from earlier turns):\n" + rolling : ""}

TRUTHFULNESS & EVIDENCE DISCIPLINE (hard rules — do not violate):
- Rigorously distinguish between: (1) existing model knowledge, (2) user-provided information, (3) retrieved live information, (4) information read from images or files, (5) calculated results, (6) inference, and (7) suggestions or estimates. Never present an inference or guess as a verified fact.
- Read the "EVIDENCE:" line below.
  * "EVIDENCE: live-search" means a LIVE WEB SEARCH RESULTS block is present:
    - CITATION TRACEABILITY: Every displayed citation "[1]", "[2]" MUST be directly traceable to a specific retrieved result number from the LIVE WEB SEARCH RESULTS block.
    - VERIFY SUPPORT BEFORE CITING: Before citing any source "[N]", verify that the title, snippet, or content of result [N] actually and directly supports the associated statement. Even if a retrieved source "[N]" is a real/reputable website, if its content does not specifically support your claim, do NOT cite it. Do not present irrelevant sources just because they were returned by the search tool. If no retrieved source supports a statement, the statement MUST be removed, qualified as inference, or clearly identified as unverified.
    - NEWS & HEADLINES SYNTHESIS: When retrieved search results, snippets, or article excerpts contain headline details, breaking news, or developing stories:
      * Report and summarize the headlines directly from the retrieved sources with clear inline citations "[N]".
      * For each reported headline, state the key facts or developing summary provided in the snippet/article, and attribute it to the publishing source (e.g. "[1] Reuters: ...", "[2] BBC: ...").
      * Synthesize and present usable headlines and news summaries cleanly to the user.
      * Only if a search completely failed or returned zero results should you state that no usable results were returned.
    - STRICT SOURCES SECTION RULE:
      * NO "**Sources:**" section should appear unless there are actual retrieved sources directly supporting specific claims in your response.
      * If no retrieved source supports a specific claim in your response, OMIT the "**Sources:**" section completely.
      * When legitimate citations "[N]" are used in the body to support specific claims, include in "**Sources:**" ONLY the specific items that were actually cited in your answer.
  * "EVIDENCE: none" means NO search ran on THIS specific turn (for instance, because the turn was an ordinary conversational greeting, general reasoning question, note/reminder management, or a conceptual inquiry). It does NOT mean you lack the web search tool — you DO have an active live web search tool wired into your runtime, and you can search whenever requested. On turns with EVIDENCE: none, answer from your existing model knowledge, flag anything uncertain, and do not imply you performed a search on that turn. Clearly state that the answer is based on existing knowledge or that live verification was unavailable. Never output a "**Sources:**" section on EVIDENCE: none turns.
- If a tool fails, times out, has no API key, or returns no useful results, report the actual failure state rather than improvising.
- Never claim to have read an image unless an image was actually attached to this turn.
- Never claim to remember something that is not in the live context or conversation history.
- Never state that a note, reminder, bill, memory, plan or setting changed. Only the app's verified action log or tool result may confirm that.
- Snippet honesty: if you only saw a search snippet, say "the snippet from <Publisher> says…" — don't claim you read the full article.
- Time and date questions: answer from the TEMPORAL ANCHOR above and name the timezone. Never claim a search verified the time.
- If the user corrects you, accept it in one line and give the corrected answer.

MUTATION AUTHORITIES — CLEAR SEPARATION OF RESPONSIBILITY:
1. REMINDERS (Native Tools):
Native reminder tools (\`createReminder\`, \`listReminders\`, \`updateReminder\`, \`completeReminder\`, \`deleteReminder\`) are the EXCLUSIVE, AUTHORITATIVE mutation authority for reminders.
- Use \`createReminder\` for new reminders. ALWAYS provide a clear title and \`dueAt\` (which can be a natural-language date/time string like "tomorrow at 9am" or a unix timestamp in milliseconds; Alpha normalizes temporal expressions deterministically).
- Use \`listReminders\` to see what's active.
- Use \`updateReminder\` or \`completeReminder\` to change state.
- Use \`deleteReminder\` to remove them.
- DO NOT emit reminder action tags (like [[ADD_REMINDER]]) when using native reminder tools.
Only claim success if the tool result returns \`success: true\`.

VISION (when an image is attached or captured from the live eye):
- Answer about what is ACTUALLY visible — objects, colours, text, position, what the person is wearing or holding.
- Deictic questions ("does this look good on me?", "what's on my head?", "read this") refer to the attached frame.
- If the frame is too dark, blurry or cropped to tell, say exactly that and suggest re-aiming. Never guess.

2. NOTES, MEMORIES, BILLS, PLANS, SETTINGS, & PROFILE (Action Tags):
Action tags are the authoritative mutation authority for notes, memories, plans, bills, settings, and profile. The app executes each tag asynchronously, awaits persistence, re-reads storage to verify it, and appends a truthful action log under your reply. A tag you did not emit did NOT happen.
Use EXACTLY these formats, each on its own line:
[[ADD_NOTE: title | body]]
[[ADD_MEMORY: topic | detail]]
[[ADD_PLAN: title | from | to | date | optional details]]
[[ADD_BILL: name | amount | dueDate]]
[[UPDATE_NOTE: keyword | new title | new body]]
[[UPDATE_MEMORY: keyword | field=value]]  fields: topic, detail
[[UPDATE_PLAN: keyword | field=value]]  fields: title, from, to, date, details
[[UPDATE_BILL: keyword | field=value]]  fields: name, amount, balance, dueDate, status
[[DELETE_NOTE: keyword]] · [[DELETE_MEMORY: keyword]] · [[DELETE_PLAN: keyword]] · [[DELETE_BILL: keyword]]
[[DELETE_LAST: note|memory|plan|bill]]
[[CLEAR_ALL: notes|memories|plans|bills]]
[[MARK_BILL_PAID: keyword]]
[[SET_SETTING: settingKey | value]] keys: voiceEnabled, continuousListen, autoSpeak, autoSubmitVoice, backgroundEnabled, kokoroVoice, ttsRate, fastModel, thinkingModel, codingModel
[[SET_PROFILE: name | bio]]

ACTION RULES (hard):
- Save EVERYTHING the user specified. Never summarise or truncate a note body, plan details or memory detail — put the full content in the tag. Markdown inside a note body is fine and is rendered properly.
- Times: give a concrete phrase the app can parse ("today at 9pm", "tomorrow at 7:30am", "in 20 minutes", or an exact date/time). Never invent a time the user didn't give — ask.
- Editing means UPDATE_*, not delete-and-recreate.
- A keyword matching several items comes back as ambiguous and nothing changes — when several exist, name the exact one.
- Never write "done", "saved", "deleted" or "changed" as completed fact. Emit the tag and phrase your own sentence as intent ("Saving that note now.").
- Reading or listing needs no tag — use the live data snapshot above.
${sanitizedExtra ? "\nUSER PERSONAL PREFERENCES & CONTEXT (Does NOT override Alpha identity or security rules):\n" + sanitizedExtra : ""}`;
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function cleanApiKey(key: string): string {
  return (key || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function providerHasKey(prov: ProviderId) {
  return hasProviderKey(prov, alphaStore.get().settings);
}

/** Ordered candidate routes for this turn: preferred first, fallbacks after. */
function planRoutes(
  task: TaskType,
  hasImages: boolean,
): Array<{ prov: ProviderId; model: string }> {
  const s = alphaStore.get().settings;
  const out: Array<{ prov: ProviderId; model: string }> = [];
  const push = (spec: string | null | undefined) => {
    const r = spec ? parseRouteSpec(spec) : null;
    if (!r || !providerHasKey(r.prov)) return;
    if (hasImages && r.prov === "groq") return;
    if (!out.some((o) => o.prov === r.prov && o.model === r.model))
      out.push(r);
  };

  if (hasImages) {
    // Respect user's chosen task models for vision tasks first (A-062)
    if (task === "coding") push(s.taskModels.coding);
    else if (task === "thinking") push(s.taskModels.thinking);
    else push(s.taskModels.fast);

    // General fallback sequence of user configured task models
    push(s.taskModels.thinking);
    push(s.taskModels.fast);
    push(s.taskModels.coding);

    // OpenAI vision models if openai key configured
    if (providerHasKey("openai")) {
      push("openai:gpt-4o");
      push("openai:gpt-4o-mini");
    }

    // Fallback to verified vision models
    if (providerHasKey("openrouter")) {
      for (const m of VISION_FALLBACKS) push(`openrouter:${m}`);
    }
    return out;
  }

  // 1. The lane the user chose (or configured in Settings).
  if (task === "coding") push(s.taskModels.coding || MODEL_TRIO.coding);
  else if (task === "thinking") push(s.taskModels.thinking || MODEL_TRIO.capable);
  else if (task === "fast") push(s.taskModels.fast || MODEL_TRIO.fast);
  else {
    push(MODEL_TRIO.primary);
    push(s.taskModels.fast);
  }

  // 2. The rest of the centrally configured trio.
  push(MODEL_TRIO.primary);
  push(MODEL_TRIO.fast);
  push(MODEL_TRIO.capable);
  push(MODEL_TRIO.coding);
  // 3. Verified fallback chain.
  if (providerHasKey("openrouter")) for (const m of TEXT_FALLBACKS) push(`openrouter:${m}`);
  // 4. Whatever other lanes the user configured.
  push(s.taskModels.thinking);
  push(s.taskModels.coding);
  // 5. OpenAI-compatible routes if provider has key (e.g. OpenAI, xAI Grok, Together, DeepSeek)
  if (providerHasKey("openai")) {
    push("openai:gpt-4o-mini");
    push("openai:gpt-4o");
    push("openai:grok-2");
    push("openai:grok-beta");
  }
  // 6. Groq lane if provider has key.
  if (providerHasKey("groq")) {
    push("groq:llama-3.3-70b-versatile");
    push(`groq:${GROQ_EMERGENCY_MODEL}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-engine Live Web Search (DuckDuckGo + Jina Reader + Wikipedia)
// ---------------------------------------------------------------------------

export async function fetchLiveWebContext(query: string): Promise<string> {
  if (!query) return "";

  const researchService = new BoundedResearchService();
  const research = await researchService.research(query);

  const sources: CanonicalWebSource[] =
    research.sources && research.sources.length > 0
      ? research.sources
      : buildCanonicalSources(research.results, research.articles, research.evidence);

  if (research.status === "failed" || sources.length === 0) {
    return `LIVE WEB SEARCH RESULTS: the search ran for "${query}" at ${new Date().toLocaleString()}, but returned no usable public results. Tell the user plainly that the search returned no usable results; do not guess, do not fabricate headlines, and do not output a Sources section.`;
  }

  const isHeadlineQuery = /news|headline|headlines|breaking|top\s+stories|current\s+events|latest/i.test(query);

  const lines = [
    `LIVE WEB SEARCH RESULTS (Retrieved at ${new Date().toLocaleString()} for query "${query}"):`,
    `---`,
  ];

  const structuredArticles = sources.filter((s) => s.isStructuredArticle);

  if (isHeadlineQuery && structuredArticles.length > 0) {
    lines.push(`STRUCTURED NEWS ARTICLES & HEADLINES (Primary Results):`);
    structuredArticles.slice(0, 6).forEach((s) => {
      lines.push(
        `[${s.id}] Headline: "${s.title}"\n    Publisher: ${s.publisher || "Unknown"}\n    URL: ${s.url}${s.publishedDate ? `\n    Date: ${s.publishedDate}` : ""}${s.summary ? `\n    Summary: ${s.summary}` : ""}`
      );
    });
    lines.push(`---`);
  }

  lines.push(`Sources:`);
  sources.forEach((s) => {
    lines.push(`[${s.id}] ${s.title}${s.publisher ? ` (${s.publisher})` : ""} - ${s.url}`);
    lines.push(`    URL: ${s.url}`);
    if (s.summary) {
      lines.push(`    Summary: ${s.summary}`);
    }
  });

  if (!isHeadlineQuery && structuredArticles.length > 0) {
    lines.push(`---`, `STRUCTURED ARTICLES & HEADLINES:`);
    structuredArticles.slice(0, 6).forEach((s) => {
      lines.push(
        `[${s.id}] Headline: "${s.title}"\n    Publisher: ${s.publisher || "Unknown"}\n    URL: ${s.url}${s.publishedDate ? `\n    Date: ${s.publishedDate}` : ""}${s.summary ? `\n    Summary: ${s.summary}` : ""}`
      );
    });
  }

  if (research.evidence && research.evidence.length > 0) {
    lines.push(`---`, `Verified content details:`);
    const urlMap = new Map(sources.map((s) => [normalizeSourceUrl(s.url), s.id]));
    research.evidence.forEach((e) => {
      const canonicalId = urlMap.get(normalizeSourceUrl(e.url));
      const prefix = canonicalId ? `[${canonicalId}] ` : "";
      lines.push(
        `${prefix}${e.title} (URL: ${e.url}, Publisher: ${e.publisher || "Unknown"}, Retrieved: ${e.retrievedAt}):\n${e.excerpt}`,
      );
    });
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool Execution
// ---------------------------------------------------------------------------

interface ToolContext {
  userId: string | null;
}

export interface NativeToolExecutionSummary {
  executedCount: number;
  hasMutation: boolean;
  allMutationsSucceeded: boolean;
  hasFailedMutation: boolean;
  results: Array<{
    name: string;
    success: boolean;
    isMutation: boolean;
    error?: any;
    executionKey?: string;
    logicalKeys?: string[];
  }>;
  executedLogicalKeys?: string[];
}

export async function executeTool(call: any, context: ToolContext) {
  const { name, arguments: argsRaw } = call.function;
  let args: any = {};
  try {
    args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
  } catch (e) {
    return { 
      success: false, 
      operation: name, 
      error: { code: 'INVALID_INPUT', message: 'Malformed JSON arguments' } 
    };
  }

  // Security: strip any provided ownership fields to prevent override
  const forbidden = ["userId", "uid", "ownerId", "user_id"];
  for (const f of forbidden) if (f in args) delete args[f];

  const { userId } = context;
  const tool = getReminderTool(userId);

  try {
    let res: any;
    switch (name) {
      case 'createReminder':
        activity.set("writing_reminder");
        res = await tool.createReminder(args);
        break;
      case 'getReminder':
        activity.set("reading_reminder");
        res = await tool.getReminder(args.idOrQuery || args.id || args.query);
        break;
      case 'listReminders':
        activity.set("reading_reminder");
        res = await tool.listReminders();
        break;
      case 'updateReminder':
        activity.set("writing_reminder");
        res = await tool.updateReminder(args);
        break;
      case 'deleteReminder':
        activity.set("writing_reminder");
        res = await tool.deleteReminder(args.idOrQuery || args.id || args.query);
        break;
      case 'completeReminder':
        activity.set("writing_reminder");
        res = await tool.completeReminder(args.idOrQuery || args.id || args.query);
        break;
      case 'inspectGitHubRepo': {
        activity.set("calling_tool");
        const authUser = await ensureAuthenticatedUser();
        if (!authUser) {
          return {
            success: false,
            errorType: "inaccessible",
            errorReason: "Authentication failure: User is not authenticated in Firebase Auth.",
          };
        }
        const idToken = await authUser.getIdToken();
        if (!idToken) {
          return {
            success: false,
            errorType: "inaccessible",
            errorReason: "Authentication failure: Failed to acquire Firebase ID token.",
          };
        }
        res = await inspectGitHubRepo({ data: { urlOrSlug: args.urlOrSlug || args.url || args.slug, subpath: args.subpath, idToken } });
        break;
      }
      default:
        activity.set("calling_tool");
        return { 
          success: false, 
          operation: name, 
          error: { code: 'UNKNOWN_TOOL', message: `Tool ${name} not found` } 
        };
    }
    if (res && res.success && ['createReminder', 'updateReminder', 'deleteReminder', 'completeReminder'].includes(name)) {
      // Canonical repository persists and dispatches alpha:reminders-changed
    }
    return res;
  } catch (e: any) {
    return { 
      success: false, 
      operation: name, 
      error: { code: 'REPOSITORY_ERROR', message: e.message || 'Unknown repository error' } 
    };
  }
}

function getCanonicalExecutionKey(call: any): string {
  const name = call?.function?.name || "";
  let args = call?.function?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // keep raw
    }
  }
  let canonicalArgs = "";
  if (typeof args === "object" && args !== null) {
    const copy = { ...args };
    const forbidden = ["userId", "uid", "ownerId", "user_id"];
    for (const f of forbidden) delete copy[f];
    const sortedKeys = Object.keys(copy).sort();
    const sortedObj: any = {};
    for (const k of sortedKeys) {
      sortedObj[k] = copy[k];
    }
    canonicalArgs = JSON.stringify(sortedObj);
  } else {
    canonicalArgs = String(args || "");
  }
  return `${name}:${canonicalArgs}`;
}

function getLogicalMutationKey(call: any): string | null {
  const name = call?.function?.name || "";
  if (!name || !["createReminder", "updateReminder", "deleteReminder", "completeReminder"].includes(name)) {
    return null;
  }
  const keys = extractNativeReminderMutationKeys(name, call?.function?.arguments);
  return keys.length > 0 ? keys[0] : null;
}

async function reconcileAmbiguousMutation(call: any, context: ToolContext, originalError: any): Promise<any> {
  const name = call.function?.name || "";
  const { userId } = context;
  if (!userId) {
    return {
      success: false,
      operation: name,
      error: { code: "UNAUTHENTICATED", message: "User must be authenticated" },
    };
  }

  let args: any = {};
  try {
    args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function?.arguments || {});
  } catch {
    return {
      success: false,
      operation: name,
      error: { code: "INVALID_INPUT", message: "Malformed JSON arguments" },
    };
  }

  const tool = getReminderTool(userId);

  if (name === "createReminder" && args.title) {
    try {
      const list = await tool.listReminders();
      if (list.success && Array.isArray(list.data)) {
        const candidate = list.data.find(
          (r: any) =>
            r.title.toLowerCase() === String(args.title).toLowerCase() &&
            Math.abs(Date.now() - (r.createdAt || 0)) < 60000,
        );
        if (candidate) {
          return { success: true, operation: name, data: candidate };
        }
      }
    } catch {}
  }

  if (name === "deleteReminder" && (args.id || args.idOrQuery || args.query)) {
    try {
      const target = args.id || args.idOrQuery || args.query;
      const existing = await tool.getReminder(target);
      if (!existing.success && existing.error?.code === "NOT_FOUND") {
        return { success: true, operation: name, data: { id: target, title: "deleted" } };
      }
    } catch {}
  }

  if (name === "completeReminder" && (args.id || args.idOrQuery || args.query)) {
    try {
      const target = args.id || args.idOrQuery || args.query;
      const existing = await tool.getReminder(target);
      if (existing.success && existing.data?.reminderState === "completed") {
        return { success: true, operation: name, data: existing.data };
      }
    } catch {}
  }

  return {
    success: false,
    operation: name,
    error: {
      code: "REPOSITORY_ERROR",
      message: originalError?.message
        ? `Execution outcome was ambiguous (${originalError.message}); prevented duplicate side effects.`
        : "Execution outcome was ambiguous; prevented duplicate side effects.",
    },
  };
}

// ---------------------------------------------------------------------------
// Request discipline: one user message → one model request
// ---------------------------------------------------------------------------

let inFlight: { key: string; promise: Promise<string> } | null = null;
let lastLogicalKey = "";
let lastLogicalTime = 0;
let lastLogicalPromise: Promise<string> | null = null;

/** Which model actually produced the last reply (developer record). */
export let lastAnsweredBy = "";

function requestKey(history: ChatMessage[], task: TaskType): string {
  const last = [...history].reverse().find((m) => m.role === "user");
  const normalizedText = (last?.text || "").trim().toLowerCase();
  const imageCount = last?.images?.length || 0;
  // Exclude volatile generated message ID (last?.id) so duplicate message objects
  // representing the same logical user turn map to the exact same request key.
  return `${task}|${normalizedText}|${imageCount}`;
}

export function isChatGenerating(): boolean {
  return inFlight !== null;
}

export async function waitForChatIdle(): Promise<void> {
  while (inFlight) {
    try {
      await inFlight.promise;
    } catch {
      // Ignore user generation errors so proactive handler can proceed safely
    }
  }
}

export interface ProactiveReminderOptions {
  task?: TaskType;
  historyTurns?: number;
}

/**
 * Generates an authoritative conversational Alpha response for an application-triggered ReminderDueEvent.
 * Does NOT execute any tools or mutate reminders.
 * Strictly presents the verified reminder title and verified due time to the model.
 */
export async function generateProactiveReminderResponse(
  event: ReminderDueEvent,
  opts: ProactiveReminderOptions = {},
): Promise<string> {
  const s = alphaStore.get().settings;
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  const task: TaskType = opts.task ?? "fast";
  const routes = online ? planRoutes(task, false) : [];

  const dueTimeFormatted = new Date(event.dueAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const dueDateFormatted = new Date(event.dueAt).toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const reminderInstruction = `
PROACTIVE REMINDER EVENT (Application-Triggered):
The application has already authoritatively determined that the following user reminder is due right now.
Reminder Title: "${event.title || "Untitled Reminder"}"
Due Time: ${dueDateFormatted} at ${dueTimeFormatted} (Timestamp: ${event.dueAt})

Respond as Alpha in a natural, concise, conversational way to proactively inform the user about this reminder.
CONSTRAINTS:
- Keep the response short (1 to 2 sentences).
- Do not claim to have performed an action (such as completing, setting, or deleting a reminder).
- Do not invent additional details, times, locations, recipients, reasons, or user intentions.
- Do not expose internal event IDs, database states, scheduler details, or tool names.
- Do NOT call or request any tools.
`;

  const rolling = conversationSummary.get();
  const sys = DEFAULT_SYSTEM(s.personaExtra || "", "", rolling, { offline: !online }) + "\n\n" + reminderInstruction;

  // Recent conversation context so Alpha remains coherent, filtered to pure dialogue
  const recentHistory = alphaStore
    .get()
    .chat.filter((m) => m.role === "user" || (m.role === "model" && m.text))
    .slice(-(opts.historyTurns ?? 4));

  const messagesForTurn: ChatMessage[] = [
    ...recentHistory,
    {
      id: `sys_event_${event.eventId}`,
      role: "system",
      text: `[SYSTEM NOTIFICATION: Reminder is due right now: "${event.title || "Untitled"}" at ${dueDateFormatted} ${dueTimeFormatted}. Proactively inform the user.]`,
      ts: Date.now(),
    },
  ];

  activity.set("thinking");
  if (routes.length) {
    let lastErr: any = null;
    for (let i = 0; i < routes.length; i++) {
      const { prov, model } = routes[i];
      try {
        const response = await callProvider(prov, model, messagesForTurn, sys, {
          allowImages: false,
          maxTokens: 150,
          historyTurns: 4,
          tools: [], // Strictly no tools allowed during proactive reminder generation
        });
        const rawContent = response.content || "";
        const cleaned = stripLeakedThinking(rawContent).trim();
        if (cleaned) {
          return cleaned;
        }
      } catch (err: any) {
        lastErr = err;
        const st = err?.status;
        const retryableElsewhere =
          st === 429 ||
          st === 404 ||
          st === 402 ||
          st === 403 ||
          st === 502 ||
          st === 504 ||
          (st >= 500 && st < 600) ||
          /unavailable|no endpoints|rate.?limit|quota|empty response|timed out/i.test(
            String(err?.message || ""),
          );
        if (!retryableElsewhere) break;
      }
    }
    throw lastErr || new Error("Failed to generate proactive response from online models");
  }

  // Fallback to local Ollama if offline or no routes
  const text = await sendChatOllama(messagesForTurn, sys);
  const cleaned = stripLeakedThinking(text).trim();
  if (!cleaned) throw new Error("Empty response from Ollama");
  return cleaned;
}

export function determineInitialActivity(
  hasImages: boolean,
  task: TaskType,
  userText: string,
): ActivityKind {
  if (hasImages) return "reading_image";
  if (
    task === "coding" ||
    /^(?:write|create|generate|fix|debug|refactor|implement)\s+(?:a\s+)?(?:function|component|script|code|sql|query|regex|test|class|program)\b|```|\b(?:javascript|typescript|python|html|css|react|bash|dockerfile|c\+\+|golang|rust|java)\b/i.test(
      userText,
    )
  ) {
    return "writing_code";
  }
  if (/^(?:calculate|solve|evaluate|compute)\b|\b\d+\s*[+\-*/]\s*\d+/i.test(userText)) {
    return "calculating";
  }
  return "thinking";
}

export async function sendChat(
  history: ChatMessage[],
  opts: { task?: TaskType; signal?: AbortSignal; disableTools?: boolean } = {},
): Promise<string> {
  const task: TaskType = opts.task ?? "auto";
  const key = requestKey(history, task);
  const now = Date.now();
  // Duplicate submissions (double tap, re-render, voice + button, duplicate message objects) share one request.
  if (inFlight && inFlight.key === key) return inFlight.promise;
  if (lastLogicalKey === key && now - lastLogicalTime < 3500 && lastLogicalPromise) {
    return lastLogicalPromise;
  }
  lastLogicalKey = key;
  lastLogicalTime = now;

  const promise = runChat(history, task, opts.signal, opts.disableTools).finally(() => {
    if (inFlight?.key === key) inFlight = null;
  });
  inFlight = { key, promise };
  lastLogicalPromise = promise;
  return promise;
}

async function runChat(history: ChatMessage[], task: TaskType, signal?: AbortSignal, disableTools?: boolean): Promise<string> {
  const lifecycle = new RequestActionLifecycle();
  const s = alphaStore.get().settings;
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  const currentUid = auth.currentUser?.uid || null;

  const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
  const hasImages = !!lastUserMsg?.images?.length;
  const userText = lastUserMsg?.text || "";

  // Detect whether user is answering a prior assistant clarification/question
  const priorAssistantMsg = [...history].reverse().find((m) => m.role === "model" && m.text);
  const priorAssistantText = (priorAssistantMsg?.text || "").trim();
  const isAnsweringClarification =
    priorAssistantText.endsWith("?") ||
    /\b(?:what|when|which|clarify|specify|details|who|where)\b/i.test(priorAssistantText);
  if (isAnsweringClarification && userText) {
    lifecycle.setClarificationSupplied(true);
  }

  // Local intents answer instantly with no model request at all.
  if (userText && !hasImages) {
    const eyeRes = await handleEyeCommand(userText);
    if (eyeRes) {
      lifecycle.recordSuccess({ name: "handleEyeCommand", isMutation: false, result: eyeRes });
      activity.clear();
      return eyeRes;
    }
    try {
      const local = await tryLocalIntent(userText, lifecycle);
      if (local) {
        activity.clear();
        return local;
      }
    } catch (err) {
      activity.clear();
      throw err;
    }

    // Explicit notification acknowledgement check for active/delivered reminders
    if (currentUid) {
      try {
        const ackResult = await notificationAcknowledgementManager.acknowledgeFromUserUtterance(currentUid, userText);
        if (ackResult.success && ackResult.conversationalReply) {
          activity.clear();
          return ackResult.conversationalReply;
        } else if (ackResult.status === 'ambiguous_target') {
          activity.clear();
          const candidateList = ackResult.error.candidates?.map((c) => (c.title ? `"${c.title}"` : 'a reminder')).join(', ');
          return `Which reminder did you mean? ${candidateList ? `(${candidateList})` : ''}`;
        }

        // Notification follow-up & recovery inquiry check
        const inquiryReply = await notificationRecoveryManager.handleConversationalInquiry(currentUid, userText);
        if (inquiryReply) {
          activity.clear();
          return inquiryReply;
        }
      } catch {
        // Fall through cleanly to general chat
      }
    }
  }

  const routes = online ? planRoutes(task, hasImages) : [];

  if (hasImages && online && !routes.length) {
    activity.set("error");
    throw new Error(
      "No OpenRouter API key set — Alpha needs one to see images. Add it in Settings → Online.",
    );
  }

  activity.set(determineInitialActivity(hasImages, task, userText));

  let authReminders: FirestoreReminder[] = [];
  try {
    authReminders = await getAuthoritativeReminders();
  } catch (err) {
    console.error("Repository failure reading reminders for context:", err);
  }
  const recall = userText ? rerankContext(userText, authReminders) : "";
  const rolling = conversationSummary.get();

  // ---- Real-time web search execution & capability routing ----
  let webContext = "";
  let searchHint = SEARCH_FORBIDDEN_HINT;
  if (online && !hasImages) {
    const decision = decideSearch(userText);
    if (decision.search) {
      activity.set("searching");
      webContext = await fetchLiveWebContext(decision.query || "");
      if (!activity.isActionActive()) {
        activity.set(determineInitialActivity(hasImages, task, userText));
      }
    } else if ("capabilityInquiry" in decision && decision.capabilityInquiry) {
      searchHint = SEARCH_CAPABILITY_HINT;
    } else if ("offer" in decision && decision.offer) {
      searchHint = SEARCH_OFFER_HINT;
    }
  } else if (hasImages) {
    searchHint = SEARCH_FORBIDDEN_HINT;
  }
  
  const hasEvidence = /^\[1\]/m.test(webContext);
  const clarificationGuidance = lifecycle.getClarificationState().suppliedInTurn
    ? `\n\nCONVERSATION CONTEXT: The user has answered your prior question ("${safeContent(priorAssistantText.slice(0, 140))}"). Do NOT repeat your clarification question. Proceed directly to fulfill the requested action using available tools.`
    : "";

  const buildSys = (offline: boolean) =>
    DEFAULT_SYSTEM(s.personaExtra || "", recall, rolling, {
      offline,
      reminders: authReminders,
      userText,
      channel: hasImages ? "vision" : "text",
    }) +
    REMINDER_INSTRUCTIONS +
    clarificationGuidance +
    `\n\nEVIDENCE: ${hasEvidence ? "live-search" : "none"}\n${searchHint}` +
    (webContext ? `\n\n${webContext}` : "");

  if (routes.length) {
    const sys = buildSys(false);
    const budget = hasImages ? "vision" : task;
    const maxTokens =
      MAX_OUTPUT_TOKENS[budget as keyof typeof MAX_OUTPUT_TOKENS] ?? MAX_OUTPUT_TOKENS.auto;
    const historyTurns = HISTORY_TURNS[budget as keyof typeof HISTORY_TURNS] ?? HISTORY_TURNS.auto;

    let lastErr: any = null;
    const currentHistory = [...history];
    let loopCount = 0;
    let finalResponse: ChatResponse | null = null;
    const callResults = new Map<string, any>();
    const executedLogicalMutations = new Map<string, any>();
    const executedTools: Array<{
      name: string;
      success: boolean;
      isMutation: boolean;
      error?: any;
      executionKey?: string;
      logicalKeys: string[];
    }> = [];

    const MUTATION_TOOLS = new Set([
      "createReminder",
      "updateReminder",
      "deleteReminder",
      "completeReminder",
    ]);

    let currentRouteIndex = 0;
    let prov = routes[0].prov;
    let model = routes[0].model;

    while (loopCount < 5 && currentRouteIndex < routes.length) {
      prov = routes[currentRouteIndex].prov;
      model = routes[currentRouteIndex].model;

      activity.set(determineInitialActivity(hasImages, task, userText));

      let response: ChatResponse;
      try {
        response = await callProvider(prov, model, currentHistory, sys, {
          allowImages: hasImages,
          maxTokens,
          historyTurns,
          tools: disableTools ? [] : REMINDER_TOOLS,
          signal,
        });
      } catch (err: any) {
        lastErr = err;
        if (err?.name === "AbortError" || signal?.aborted) {
          activity.clear();
          throw err;
        }
        if (typeof console !== "undefined")
          console.warn(`[alpha] ${prov}:${model} failed`, err?.status, err?.message);
        const st = err?.status;
        const retryableElsewhere =
          st === 429 ||
          st === 404 ||
          st === 402 ||
          st === 403 ||
          st === 502 ||
          st === 504 ||
          (st >= 500 && st < 600) ||
          /unavailable|no endpoints|rate.?limit|quota|empty response|timed out/i.test(
            String(err?.message || ""),
          );
        if (retryableElsewhere && currentRouteIndex + 1 < routes.length) {
          currentRouteIndex++;
          activity.set("switching_model");
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        break;
      }

      if (!response.tool_calls || response.tool_calls.length === 0) {
        finalResponse = response;
        break;
      }

      // Tool execution round
      activity.set("calling_tool");
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: "model",
        text: response.content || "",
        ts: Date.now(),
        tool_calls: response.tool_calls,
      };
      currentHistory.push(assistantMsg);
      await alphaStore.appendChat(assistantMsg);

      let hasNewMutation = false;
      let hasNewRead = false;
      let hasFailure = false;
      let allToolsAlreadyCompleted = true;

      for (const call of response.tool_calls) {
        const invocationKey = getCanonicalExecutionKey(call);
        const stableCallId = call.id;
        const logicalKey = getLogicalMutationKey(call);
        const isMutation = MUTATION_TOOLS.has(call.function?.name);

        let result: any;
        const logicalKeysForTool: string[] = [];

        // Check if already completed in lifecycle or earlier execution in this run
        const alreadyCompletedMutationResult =
          (logicalKey && lifecycle.hasCompletedMutation(logicalKey))
            ? lifecycle.getCompletedMutationResult(logicalKey)
            : null;

        const existingResult =
          alreadyCompletedMutationResult ||
          (stableCallId && callResults.get(stableCallId)) ||
          callResults.get(invocationKey) ||
          (logicalKey && executedLogicalMutations.get(logicalKey));

        if (existingResult) {
          result = existingResult;
          if (isMutation) {
            // Provide structured state indicating completion and directing the model to conclude
            result = {
              ...existingResult,
              _lifecycleStatus: "ALREADY_COMPLETED",
              _directive: "This operation was ALREADY successfully completed and persisted. Do NOT call this tool again. Present your confirmation to the user.",
            };
          }
        } else {
          allToolsAlreadyCompleted = false;
          const op = lifecycle.startOperation({
            name: call.function?.name,
            isMutation,
            logicalKey,
            executionKey: invocationKey,
            args: call.function?.arguments,
          });

          const authUser = await ensureAuthenticatedUser();
          const context: ToolContext = {
            userId: authUser?.uid || auth.currentUser?.uid || null,
          };

          try {
            result = await executeTool(call, context);
          } catch (execErr: any) {
            if (isMutation) {
              result = await reconcileAmbiguousMutation(call, context, execErr);
            } else {
              result = {
                success: false,
                operation: call.function?.name,
                error: { code: "REPOSITORY_ERROR", message: execErr?.message || "Execution error" },
              };
            }
          }

          if (invocationKey) callResults.set(invocationKey, result);
          if (stableCallId) callResults.set(stableCallId, result);

          if (result && result.success) {
            if (isMutation) {
              hasNewMutation = true;
              const canonicalKeys = extractNativeReminderMutationKeys(
                call.function?.name,
                call.function?.arguments,
                result.data,
              );
              for (const k of canonicalKeys) {
                executedLogicalMutations.set(k, result);
                logicalKeysForTool.push(k);
              }
              if (invocationKey) {
                executedLogicalMutations.set(invocationKey, result);
              }
              lifecycle.recordSuccess({
                opId: op.id,
                name: call.function?.name,
                isMutation: true,
                result,
                logicalKeys: canonicalKeys.length > 0 ? canonicalKeys : (logicalKey ? [logicalKey] : []),
                executionKey: invocationKey,
              });
            } else {
              hasNewRead = true;
              lifecycle.recordSuccess({
                opId: op.id,
                name: call.function?.name,
                isMutation: false,
                result,
                executionKey: invocationKey,
              });
            }
          } else {
            hasFailure = true;
            if (result?.error?.code === "AMBIGUOUS") {
              lifecycle.recordClarification(result.error?.message || "Ambiguous request", call.function?.name);
            } else {
              lifecycle.recordFailure({
                opId: op.id,
                name: call.function?.name,
                isMutation,
                error: result?.error,
                logicalKey,
                executionKey: invocationKey,
              });
            }
          }
        }

        executedTools.push({
          name: call.function?.name,
          success: !!result?.success,
          isMutation,
          error: result?.error,
          executionKey: invocationKey,
          logicalKeys: logicalKeysForTool,
        });

        const toolMsg: ChatMessage = {
          id: uid(),
          role: "tool",
          text: JSON.stringify(result),
          ts: Date.now(),
          tool_call_id: call.id,
        };
        currentHistory.push(toolMsg);
        await alphaStore.appendChat(toolMsg);
      }

      loopCount++;

      // Action Completion & Multi-Round Boundary Control: Set continuation needs FIRST, then evaluate fulfillment
      if (hasNewMutation && !hasNewRead && !hasFailure) {
        lifecycle.setNeedsAnotherStep(false);
      } else if (hasNewRead) {
        lifecycle.setNeedsAnotherStep(true);
      }

      if (allToolsAlreadyCompleted || lifecycle.isRequestFulfilled()) {
        // The request is fully fulfilled or only duplicate completed operations were attempted. Break loop immediately.
        break;
      }
    }

    if (!finalResponse) {
      try {
        finalResponse = await callProvider(prov, model, currentHistory, sys, {
          allowImages: hasImages,
          maxTokens: Math.min(maxTokens, 300),
          historyTurns,
          tools: [], // Force text completion, no further tool loop
          signal,
        });
      } catch {
        finalResponse = {
          content: lifecycle.hasCompletedMutations()
            ? "I've completed the requested action."
            : "I've processed your request.",
          tool_calls: [],
        };
      }
    }

    const mutationTools = executedTools.filter((t) => t.isMutation);
    const toolSummary: NativeToolExecutionSummary = {
      executedCount: executedTools.length,
      hasMutation: mutationTools.length > 0,
      allMutationsSucceeded: mutationTools.length > 0 && mutationTools.every((t) => t.success),
      hasFailedMutation: mutationTools.some((t) => !t.success),
      results: executedTools,
      executedLogicalKeys: Array.from(executedLogicalMutations.keys()),
    };

    if (finalResponse) {
      lastAnsweredBy = routeLabel(prov, model);
      activity.set("preparing");
      const finalText = await finalizeReply(finalResponse.content || "", webContext, toolSummary, { userId: currentUid, lifecycle });
      void maybeCompactSummary(history, finalText);
      activity.clear();
      return finalText;
    }

    activity.set("error");
    // One user-facing sentence — never the raw provider body.
    const st = lastErr?.status;
    const friendly =
      st === 429
        ? "Every model I can reach is rate-limited right now. Give it a minute and try again."
        : st === 401 || st === 403
          ? "My model provider rejected the API key. Re-paste it in Settings → Online."
          : "I couldn't get a reply from any model just now. Try again in a moment.";
    const e: any = new Error(friendly);
    e.status = st;
    throw e;
  }

  // No online route (no keys or offline) — fall through to local Ollama.
  activity.set(determineInitialActivity(hasImages, task, userText));
  try {
    const text = await sendChatOllama(history, buildSys(!webContext), webContext);
    lastAnsweredBy = "local model (Ollama)";
    activity.set("preparing");
    const out = await finalizeReply(text, webContext, undefined, { userId: currentUid, lifecycle });
    activity.clear();
    return out;
  } catch (e) {
    activity.set("error");
    throw e;
  }
}

async function callProvider(
  prov: ProviderId,
  model: string,
  history: ChatMessage[],
  sys: string,
  o: { allowImages: boolean; maxTokens: number; historyTurns: number; tools?: any[]; signal?: AbortSignal },
): Promise<ChatResponse> {
  const s = alphaStore.get().settings;
  const shared = {
    model,
    maxTokens: o.maxTokens,
    historyTurns: o.historyTurns,
    allowImages: o.allowImages,
    tools: o.tools,
    signal: o.signal,
    retries: 1,
    onStatus: (st: "waiting" | "retrying") => {
      if (st === "retrying") {
        activity.set("retrying");
      }
      // "waiting_provider" is intentionally NOT set here for normal requests.
    },
  };
  if (prov === "groq") {
    return sendChatOpenAICompat(history, sys, {
      ...shared,
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: cleanApiKey(s.groqApiKey),
    });
  }
  if (prov === "openai") {
    return sendChatOpenAICompat(history, sys, {
      ...shared,
      baseUrl: s.openaiCompatBase || "https://api.openai.com/v1",
      apiKey: cleanApiKey(s.openaiCompatKey),
    });
  }
  return sendChatOpenAICompat(history, sys, {
    ...shared,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: cleanApiKey(s.openRouterKey),
    extraHeaders: {
      "HTTP-Referer":
        typeof window !== "undefined" ? window.location.origin : "https://alpha.local",
      "X-Title": "Alpha",
    },
  });
}

/**
 * Post-process a raw model reply: execute action tags, verify them, and make
 * the execution record (not the model's prose) the source of truth.
 */
export async function finalizeReply(
  raw: string,
  webContext: string,
  toolSummary?: NativeToolExecutionSummary,
  options?: ExecuteActionTagsOptions,
): Promise<string> {
  const hasTags = /\[\[[A-Z_]+:/.test(raw);
  if (hasTags) {
    const firstTagMatch = raw.match(/\[\[([A-Z_]+):/);
    if (firstTagMatch && firstTagMatch[1]) {
      activity.set(actionActivity(firstTagMatch[1]));
    } else {
      activity.set("executing_action");
    }
  }
  const { text, results } = await executeActionTagsAsync(raw, {
    ...options,
    toolSummary,
    executedLogicalKeys: toolSummary?.executedLogicalKeys,
    lifecycle: options?.lifecycle,
  });
  let out = text;
  const report = renderActionReport(results);
  if (report) {
    if (results.some((r) => r.status !== "success")) activity.set("action_failed");
    out = (out ? out + "\n\n" : "") + report;
  } else if (claimsMutationWithoutTag(text)) {
    // If native tool mutations or lifecycle mutations executed and ALL mutations succeeded, the action was actually performed.
    // In that case, do NOT generate the false NO_ACTION_NOTICE.
    const nativeMutationsFullySucceeded =
      Boolean(toolSummary && toolSummary.hasMutation && toolSummary.allMutationsSucceeded && !toolSummary.hasFailedMutation);
    const lifecycleMutationsSucceeded =
      Boolean(options?.lifecycle?.hasCompletedMutations() && !options?.lifecycle?.hasFailedMutations());

    if (!nativeMutationsFullySucceeded && !lifecycleMutationsSucceeded) {
      out = (out ? out + "\n\n" : "") + NO_ACTION_NOTICE;
    }
  }

  // If there were failed native mutations, ensure activity and log reflect the failure
  if (toolSummary?.hasFailedMutation) {
    activity.set("action_failed");
    const failedMutations = toolSummary.results.filter((r) => r.isMutation && !r.success);
    const failureLines = failedMutations.map((f) => {
      const msg = f.error?.message || `Failed to execute ${f.name}.`;
      return `❌ ${msg}`;
    });
    const failureReport = `**Action log — read this over anything I said above:**\n${failureLines.join("\n")}`;
    if (!out.includes(failureReport)) {
      out = (out ? out + "\n\n" : "") + failureReport;
    }
  }

  return appendSourcesIfWeb(out, webContext);
}

/**
 * Parses canonical web sources from webContext using the single authoritative citation numbering scheme.
 * Guarantees every citation marker [N] maps to exactly one source URL and title.
 */
export function parseSourcesFromWebContext(
  webContext: string,
): Map<number, { n: number; title: string; url: string }> {
  const sourcesMap = new Map<number, { n: number; title: string; url: string }>();
  if (!webContext) return sourcesMap;

  const lines = webContext.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^\[(\d+)\]\s+(.+)$/);
    if (!m) continue;

    const n = Number(m[1]);
    let title = m[2].trim();

    // Check if title is formatted as: Headline: "..."
    const headlineMatch = title.match(/^Headline:\s*["“](.+?)["”]$/);
    if (headlineMatch) {
      title = headlineMatch[1].trim();
    }

    // Check if URL is inline on the same line:
    // e.g. "[1] Some Title (Publisher) - https://..."
    // or "[1] Title (URL: https://..., ...)"
    let url = "";
    const inlineDashUrl = title.match(/^(.+?)\s+-\s+(https?:\/\/\S+)$/);
    if (inlineDashUrl) {
      title = inlineDashUrl[1].trim();
      url = inlineDashUrl[2].trim();
    } else {
      const inlineParenUrl = title.match(/\(URL:\s*(https?:\/\/[^,)\s]+)/i);
      if (inlineParenUrl) {
        url = inlineParenUrl[1].trim();
        title = title.replace(/\s*\(URL:\s*https?:\/\/[^)]+\)/i, "").trim();
      }
    }

    // If no inline URL was found, look ahead for a "URL: <url>" line
    if (!url) {
      const urlLine = lines.slice(i + 1, i + 6).find((l) => /^\s*URL:\s*/i.test(l));
      if (urlLine) {
        url = urlLine.replace(/^\s*URL:\s*/i, "").trim();
      }
    }

    if (url) {
      // Remove any trailing publisher or URL fragments from title
      title = title.replace(/\s+-\s+https?:\/\/\S+$/, "").trim();
      if (!sourcesMap.has(n)) {
        sourcesMap.set(n, { n, title, url });
      } else {
        // If already present, keep the highest-quality title without changing the canonical mapping
        const existing = sourcesMap.get(n)!;
        if ((!existing.title || existing.title.startsWith("Headline:")) && title && !title.startsWith("Headline:")) {
          sourcesMap.set(n, { n, title, url: existing.url || url });
        }
      }
    }
  }

  return sourcesMap;
}

/**
 * Strict Citation & Evidence Discipline:
 * 1. Every displayed citation in the Sources footer MUST be traceable to a specific retrieved result.
 * 2. NO Sources section should appear unless there are actual retrieved sources supporting specific claims.
 * 3. If no citations [N] appear in the text body (or if the reply admits evidence was insufficient),
 *    strip any hallucinated or orphaned Sources section completely.
 * 4. When citations [N] ARE legitimately used to support claims, include ONLY the specific cited items.
 */
export function appendSourcesIfWeb(text: string, webContext: string): string {
  // Strip any existing **Sources:** block to inspect the pure body
  const bodyText = text.replace(/\n+\*\*Sources:?\*\*[\s\S]*$/i, "").trim();

  // If the body expresses that search results were insufficient, general, or unverified, NEVER show a Sources block
  const admitsInsufficient =
    /\b(?:insufficient (?:evidence|results|details)|returned (?:no usable|mostly general)|couldn\x27t responsibly|cannot responsibly|risking (?:another )?fabricated|could not verify)\b/i.test(
      bodyText,
    );
  if (admitsInsufficient) {
    return bodyText;
  }

  // Parse retrieved items from webContext into map
  const sourcesMap = parseSourcesFromWebContext(webContext);

  if (sourcesMap.size === 0) {
    return bodyText;
  }

  // Find all citation markers [N] or [N, M] in the body text
  const citationMatches = [...bodyText.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)];
  const citedNumbers = new Set<number>();
  for (const m of citationMatches) {
    const parts = m[1].split(",");
    for (const p of parts) {
      const num = Number(p.trim());
      if (!isNaN(num) && num > 0) {
        citedNumbers.add(num);
      }
    }
  }

  // RULE: No Sources section should appear unless there are actual sources supporting specific claims
  if (citedNumbers.size === 0) {
    return bodyText;
  }

  // Keep ONLY sources that were actually cited in the body of the response
  const validCited = [...citedNumbers]
    .filter((n) => sourcesMap.has(n))
    .sort((a, b) => a - b)
    .map((n) => sourcesMap.get(n)!);

  if (validCited.length === 0) {
    return bodyText;
  }

  const sourcesList = validCited.map((r) => `- [${r.n}] [${r.title}](${r.url})`).join("\n");
  return `${bodyText}\n\n**Sources:**\n${sourcesList}`;
}

// ---------- Background semantic compactor ----------
let lastCompactAt = 0;
export function resetCompactionState(): void {
  lastCompactAt = 0;
}

async function maybeCompactSummary(history: ChatMessage[], lastAssistant: string) {
  try {
    const turns = history.filter((m) => m.role !== "system").length;
    // Deliberately rare: a compaction is an extra request, so it only runs
    // every 10+ turns on long threads.
    if (turns < 16) return;
    if (turns - lastCompactAt < 12) return;
    lastCompactAt = turns;
    const groqKey = cleanApiKey(alphaStore.get().settings.groqApiKey);
    if (!groqKey) return; // Best-effort only; never worth an extra paid/limited call.
    const older = history.slice(0, -10);
    if (!older.length) return;
    const transcript = older
      .slice(-30)
      .map((m) => `${m.role.toUpperCase()}: ${(m.text || "").slice(0, 300)}`)
      .join("\n");
    const previous = conversationSummary.get();
    const prompt = `Compress this chat into a compact STATE MATRIX for an assistant named Alpha. <=500 words, bullet sections only:
• User profile & preferences
• Active projects / topics
• Open decisions / unanswered questions
• Facts the user told Alpha (and dates)
• Recent thread context (1 line each)
No prose, no preamble. Merge with the previous matrix, overwriting stale items.

PREVIOUS STATE MATRIX:
${previous || "(none)"}

TRANSCRIPT:
${transcript}

LATEST REPLY:
${lastAssistant.slice(0, 500)}`;
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: GROQ_EMERGENCY_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        stream: false,
        max_tokens: 800,
      }),
    });
    if (!res.ok) return;
    const j: any = await res.json();
    const out = j?.choices?.[0]?.message?.content?.trim() || "";
    if (out && alphaStore.get().chat.length >= 10) conversationSummary.set(out);
  } catch {
    /* swallow — background */
  }
}

export async function generateImage(
  prompt: string,
): Promise<{ dataUrl: string; via: "pollinations" }> {
  const seed = Math.floor(Math.random() * 1_000_000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
  return { dataUrl: url, via: "pollinations" };
}
