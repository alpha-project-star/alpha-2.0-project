# Alpha — Phase 1: Reliability, Correctness & Core Polish

Repair pass over the existing Alpha implementation. No rebuild, no visual redesign, no Cyber-Eye or persona changes. Existing architecture (localStorage store, action tags, model routing, voice cascade, KITT/Cyber-Lens UI) is kept and hardened.

## What I confirmed by reading the code

- `executeActionTags` in `src/lib/alpha.functions.ts` mutates state and returns human strings, but the result is only appended as text — there is no structured result the response layer can trust, and the model's own prose ("done, deleted") is left untouched even when a tag fails or matches nothing.
- The tag grammar has `UPDATE_NOTE` only. There is no update tag for reminders, memories, plans, bills or profile fields, so "change my reminder from 8 PM to 9 PM" has no executable path.
- Fuzzy delete/mark helpers delete **every** match with no ambiguity handling, and `MARK_REMINDER_DONE`/`MARK_BILL_PAID` silently pick the first match.
- `ADD_REMINDER` accepts only `title | when` — user-supplied detail is dropped; `ADD_NOTE` truncates the title to 60 chars; `ADD_PLAN`/`ADD_BILL` drop details.
- Chat message actions (`MessageActions` in `src/routes/chat.tsx`) offer only Speak and Copy — no Retry, no Delete; user messages have no actions. The store has no message-removal API.
- Auto-speak is implicit: `speakWith` is called unconditionally after each reply and gated only by `settings.voiceEnabled`; there is no distinct auto-speak control, and both the mobile route and `DesktopChatPanel` call it independently.
- Voice auto-submit exists in `chat.tsx#toggleMic` but has no duplicate/stale-final guard and is absent from the desktop panel path; `MiniOrb` runs its own send pipeline (a third copy of send logic).
- Kokoro TTS tries OpenAI-compatible shapes first; fallback resets exist but the failure path relies on a `kokoro-fail` window event.
- Temporal context is generated at request time in `temporalBlock()` (good), but the system prompt tells the model to end factual answers with a Sources list even when no grounding ran, and `appendSourcesIfWeb` only helps when `webContext` exists — this is the likely cause of fabricated "sources verified" claims.
- `normalizeForSpeech` in `src/lib/speech-text.ts` strips `[*_`#>]`globally and converts every`-` inside math to " minus ", but leaves table pipes handled loosely and does not protect negative numbers/percent consistently.
- There is no test runner in `package.json` and no tests at all.

## Plan

### 1. Action result contract (root fix)

- Introduce an internal result type in the action layer: `{ tag, status: "success" | "failed" | "ambiguous" | "not_found" | "invalid", message, entity? }`.
- `executeActionTags` returns `{ text, results[] }` instead of a string; every handler produces an explicit status and re-reads the store after mutation to verify persistence.
- The chat pipeline appends a compact, honest execution block built from the results (success ticks, explicit failure/ambiguity lines). When any result is not success, the block states plainly what did not happen so Alpha's prose cannot pass as the record of truth.
- Strip/neutralise unverified success claims: when the model emitted no tag but its prose asserts a mutation, append an explicit "no change was made" notice.

### 2. Complete CRUD coverage

- Add `UPDATE_REMINDER`, `UPDATE_MEMORY`, `UPDATE_PLAN`, `UPDATE_BILL` tags (keyword match + field patch), plus reminder `notes`/plan `details`/bill fields in the ADD tags so nothing the user says is dropped.
- Ambiguity handling: when a keyword matches more than one item, return `ambiguous` with the candidate titles rather than mutating all of them (bulk delete stays available via `CLEAR_ALL` and an explicit "all matching" form).
- Remove the 60-char note title truncation and stop discarding bodies/details.
- Update the system-prompt tag reference to match the new grammar exactly.

### 3. Reminders & time

- Consolidate `when` parsing: one shared natural-language → epoch parser used by both `normalizeReminderWhen` and `alarm-engine.ts` (currently duplicated), storing an absolute ISO timestamp plus the original phrase.
- Fix alarm scheduling on edit/delete: cancel and re-register timers on the `alpha:reminders-changed` event, dedupe scheduled entries, re-sync on `visibilitychange`/reload so stale timers don't double-fire or go missing.
- Keep the honest statement that alarms only fire while a tab is alive; surface that in Settings copy rather than implying OS-level scheduling.

### 4. Truthfulness & grounding

- Tighten the system prompt: a Sources list is required **only** when a live evidence block was supplied; with no evidence Alpha must say it could not verify and must never fabricate citations or claim it searched.
- Pass an explicit `EVIDENCE: none | live-search` marker into the prompt so the instruction is unambiguous, and keep `appendSourcesIfWeb` as the only source of URLs.
- Vision: keep capability detection; when the routed model cannot see images, say so instead of answering as if it looked.

### 5. Speech sanitisation

- Rewrite `normalizeForSpeech` as ordered passes: fenced code → "code block", tables → row-wise natural reading, headings/bold/italic markers removed, list bullets removed, action tags/internal metadata removed, URLs dropped, emoji dropped.
- Preserve semantics: `%` → "percent", `×` → "times", negative numbers and "minus" kept, `$` outside math kept as "dollars", math conversion applied only inside detected math delimiters.

### 6. TTS, auto-speak, auto-submit, half-duplex

- Single speak entry point used by chat, desktop panel and MiniOrb; add an explicit `autoSpeak` setting (defaulting to current behaviour) with a Settings toggle, gating automatic speech only — manual Speak always works.
- Guarantee `speaking` state resets on every path (provider failure, empty audio, cancel, unmount) so the orb can't stick.
- Kokoro stays configurable, tried in the order the real server supports, with clean abort and browser/StreamElements fallback.
- Voice auto-submit: shared send path with a final-transcript guard (ignore empty, duplicate, and stale finals; never submit while a generation is in flight), applied to both mobile and desktop; manual send preserved when auto-submit is off.
- Half-duplex: keep mic suspension while speaking, single owner of the recognizer, resume only if continuous listening is on.

### 7. Chat message actions & navigation

- Assistant messages: compact Speak / Copy / Retry / Delete icons. User messages: Copy / Delete.
- Copy uses the full stored message text. Retry removes the stale assistant turn and regenerates from the same user turn (no duplicate turns). Delete adds a real store API that mutates state and localStorage, with the existing pair semantics preserved.
- Verify jump-to-top / jump-to-bottom controls appear only when the thread is long, don't cover the composer, and work on both layouts.

### 8. Formatting & readability

- Verify the actual render pipeline in `MessageContent.tsx` (remark-gfm, remark-math, rehype-katex): paragraphs, headings, bold/italic, nested lists, blockquotes, inline/fenced code, tables with mobile horizontal scroll, links, rules, inline and display math.
- Tune spacing so long answers breathe and short answers don't fragment; keep KaTeX errors contained to the offending expression instead of blanking the message; keep ordinary dollar-sign text intact.

### 9. Error handling & state sync

- Every failure path resets busy/speaking/listening, surfaces a useful message, and avoids duplicate requests; timeouts and cancellations audited.
- All mutations go through `alphaStore` so UI CRUD, chat commands and voice commands converge on one source of truth.

### 10. Tests, build, sweep

- Add Vitest and regression tests for the pure logic: action executor (create/update/delete/complete/not-found/ambiguous/false-confirmation), reminder time parsing, persistence round-trip, speech sanitiser cases (markdown, emoji, tables, math, negatives, percentages), temporal context.
- Run the suite, a security scan, and a production build; then do the connected-systems sweep (UI CRUD, TTS fallback, duplicate speech/messages, deletion persistence, retry integrity, math/dollar text, mobile tables, alarms) and fix directly related regressions.
- Finish with the completion report: fixes, root causes, related bugs found, test/build status, and genuine platform limitations kept separate from bugs.

## Out of scope

Cyber-Eye/orb redesign, spectrum rework, Phase-3 visual redesign, Phase-4 personality, image generation changes, backend/database, model-selection redesign.
