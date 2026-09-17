# ALPHA — Master Blueprint & Reconstruction Manual

> Everything Alpha is: what he does, how he looks, what he runs on, and every
> decision made from the first line of code to today. Written so that a
> competent developer (or another AI agent) could rebuild Alpha from zero
> using only this document.
>
> Last updated: 17 Aug 2026

---

## 1. What Alpha is

Alpha is a **voice-first, offline-capable, agentic AI companion** shipped as an
installable **PWA** (built and tuned primarily for Android, fully usable on
desktop). He is:

- **Voice-first** — the home screen is not a chat log, it is a living cybernetic
  eye you talk to. Typing is the secondary path.
- **Multi-modal** — text, images (upload / camera / live "eye" stream), speech
  in, speech out.
- **Agentic** — he can create, edit and delete the user's notes, bills,
  reminders, plans and memories, change his own settings, and fire real alarms
  in the background.
- **Provider-agnostic** — routes each kind of request to the best free model
  (Groq, OpenRouter, any OpenAI-compatible endpoint) or entirely to local
  Ollama when offline.
- **100% user-owned** — no Lovable/Supabase backend, no server database, no
  shared credits. All state lives in the browser (localStorage + IndexedDB);
  all AI calls go out from the client with the user's own API keys.
- **Personal** — he recognises the user as **Alex**, and keeps a persistent
  self-description ("Build Record") so he knows what he himself is.

---

## 2. Technology stack

| Layer         | Choice                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| Framework     | TanStack Start v1 (file-based routing, React 19, SSR-capable)                                |
| Build         | Vite 7, Bun as package manager                                                               |
| Styling       | Tailwind CSS v4 via `@tailwindcss/vite`, tokens in `src/styles.css` (all colours in `oklch`) |
| UI primitives | shadcn-style components on Radix UI, `lucide-react` icons                                    |
| Markdown      | `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `katex`                   |
| Toasts        | `sonner`                                                                                     |
| PWA           | `vite-plugin-pwa` + `workbox-window` + `public/manifest.webmanifest`                         |
| Storage       | `localStorage` (all app state) + IndexedDB (`alpha.music.v1` for MP3s)                       |
| Backend       | **none** — deliberately. Everything client-side.                                             |

Scripts: `bun dev`, `bun run build`, `bun run build:dev`, `bun run preview`,
`bun lint`, `bun run format`.

---

## 3. Visual identity ("Cyber-Lens" theme)

### 3.1 Palette

Deep **obsidian black**, **polished silver**, and **bright navy neon blue**.
No cyan-teal, no purple, no light mode in practice (background is pure black).

Key tokens in `src/styles.css` `:root`:

```
--background: oklch(0 0 0)            /* pure black */
--foreground: oklch(0.9 0.01 240)
--primary:    oklch(0.68 0.26 258)    /* bright navy neon */
--accent:     oklch(0.62 0.26 258)
--neon:       oklch(0.7 0.28 258)
--neon-glow:  oklch(0.82 0.26 254)
--silver:      oklch(0.96 0.008 240)
--silver-dark: oklch(0.68 0.012 240)
--space-deep:  oklch(0.04 0.03 260)
--shadow-glow: 0 0 26px …258/.85, 0 0 78px …258/.55
--shadow-hud:  outer neon + inset neon + 1px silver rim
--gradient-aurora:  conic silver→navy→silver sweep (rotating bezel)
--gradient-brushed: 1px repeating stripes = brushed-metal texture
--gradient-hud-panel / --gradient-nebula
```

Rule enforced throughout: **never hardcode colours in components** — only
semantic tokens (`text-primary`, `border-border`, `bg-card`, etc.).

### 3.2 Custom utilities & animations (`src/styles.css`)

- `wordmark` — wide-tracked uppercase HUD label type.
- `hud-frame`, `hud-frame-corners`, `hud-bubble` — bracketed HUD panels and
  chat bubbles with neon rims and corner ticks.
- `glass`, `neon-border` — glassmorphism + glowing edges.
- KITT scanner classes: `kitt-scanner`, `kitt-bar`, `kitt-split`, `kitt-half`,
  `kitt-gap`, `kitt-curved`, `kitt-alert`, `kitt-arc`, `kitt-arc-rail`,
  `kitt-arc-frame`, `kitt-arc-segment`, `kitt-arc-gap`.
- Cyber-eye classes: `cyber-bezel`, `cyber-bezel-lip`, `cyber-groove`,
  `alpha-ripple`, `cyber-blink`.
- Keyframes: `spin-angle`, `aurora-drift`, `pulse-glow`, `orb-beat`,
  `hud-scan`, `kitt-wave`, `kitt-arc-pulse`, `cyber-spin`, `circuit-sweep`,
  `alpha-ripple`, `cyber-breath`, `cyber-pupil-pulse`, `cyber-blink`.

### 3.3 The Orb = the Cyber Eye

`src/components/CyberEye.tsx` (~540 lines) is the single most iterated file.
It replaced an earlier "cosmic orb" and now renders, layered outer→inner:

1. **Brushed-silver bezel** with a lip and machined grooves, rotating slowly
   (conic aurora gradient driven by `spin-angle`).
2. **Neon crescent light streaks** — long sweeping "scimitar" arcs of navy
   light around the iris (turbine motion; speed rises when speaking/listening).
3. **Holographic retina** — dense HUD rings, tick marks, crosshair.
4. **Living core / pupil** — multi-layered white-hot centre that pulses with
   the audio analyser (heartbeat when idle), glows and breathes.
5. **Life behaviours** — autonomous idle drift/tilt, breathing scale, periodic
   blink shutter, and pulsing **ripples** radiating outwards
   (`AlphaOrb.tsx` renders 4 staggered `alpha-ripple` spans).
6. **Live-eye state** — when the camera is on, the pupil tracks the brightest
   centroid in frame and a red **LIVE** indicator appears.

Reference-image detail (bezel micro-text like "CYBER-LENS 0.1nm RES", outer
spikes) was deliberately **removed** at the user's request to keep focus on the
orb; `showMicroText` remains a prop, default off.

### 3.4 Status ring — KITT scanner

`src/components/KittScanner.tsx` renders Knight-Rider-style horizontal LED bars
in three variants: straight bar, split (mirrored halves with a centre gap), and
**arc** (true SVG circular geometry curving up around the orb). It reacts to
speaking / listening / alert states; `kitt-off` kills animation when idle.

### 3.5 Layouts

- **Mobile / phone (default)**: full-bleed black, giant Cyber Eye centred,
  KITT arcs hugging it, minimal chrome, floating `GlobalDock` (home / chat /
  MiniOrb) on secondary pages, `BackArrow` in each page header.
- **Desktop ≥1024px**: HUD split-shell in `src/components/desktop/` —
  `DesktopShell` (two columns), `OrbStage` (left, eye + `HorizontalSpectrum` +
  `MicDock`), `DesktopChatPanel` (right, full chat in a `HudPanel` with
  `HudBubble` messages), `ToolRail` (icon rail to every tool),
  `DesktopHomePanel`, `LiveClock`.
- **Chat surface**: sticky header with a centred `MiniOrb`, generous message
  spacing (`MessageContent.tsx`), quick scroll-to-top/bottom buttons, task
  chips (Auto / ⚡ Fast / 🧠 Deep / 🛠 Code), composer with the textarea on its
  own full-width auto-growing row and all tools docked in a row beneath it.

---

## 4. Routes (file-based, `src/routes/`)

| Route             | Purpose                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/` (`index.tsx`) | Voice-first Orb home. Hands-free listening, KITT arcs, spoken navigation. No clock (removed by request).              |
| `/chat`           | Full text+voice chat: markdown/LaTeX rendering, image upload, camera capture, live-eye toggle, mic, task chips.       |
| `/notes`          | Notes CRUD (title, body).                                                                                             |
| `/bills`          | Bill ledger (name, amount, balance, dueDate, status due/paid/overdue).                                                |
| `/reminders`      | Reminders/alarms (title, when, notes, done).                                                                          |
| `/plans`          | Plans & routes (title, from, to, date, details).                                                                      |
| `/memories`       | Long-term memories (topic, detail).                                                                                   |
| `/image`          | Image generation dashboard (Pollinations FLUX.1-schnell).                                                             |
| `/settings`       | Grouped: **Online**, **Offline**, **Alpha Data** (+ Export/Import + Danger Zone).                                     |
| `__root.tsx`      | Shell: head metadata, icons/manifest, `<Toaster />`, global dock, error capture, PWA registration, engine bootstraps. |

`SimpleCrud.tsx` is the shared generic CRUD list used by notes/bills/reminders/
plans/memories so all tools behave identically.

---

## 5. State model (`src/lib/alpha-store.ts`)

A hand-rolled store using `useSyncExternalStore` — no Redux/Zustand. Snapshot
shape:

```ts
AlphaState = { chat, notes, bills, reminders, plans, memories, profile, settings };
```

localStorage keys (versioned, all `alpha.*.v1`):
`alpha.chat.v1`, `alpha.notes.v1`, `alpha.bills.v1`, `alpha.reminders.v1`,
`alpha.plans.v1`, `alpha.memories.v1`, `alpha.profile.v1`,
`alpha.settings.v1`, `alpha.summary.v1` (rolling compacted state matrix).
Chat is capped at the last **200** messages on write.

`Settings` covers: voice (`voiceEnabled`, `continuousListen`, `preferredVoice`,
`kokoroEndpoint`, `kokoroVoice`, `ttsRate`), persona (`personaExtra`,
`buildRecord`), local backends (`ollamaEndpoint`, `ollamaModel`,
`ollamaModels`, `sttBackend`, `whisperEndpoint`, `whisperModel`), keys
(`groqApiKey`, `openRouterKey`, `openaiCompatKey`, `openaiCompatBase`),
background agent (`backgroundData` watchlist, `backgroundEnabled`), vision
(`visionAmbientEnabled`, `visionAmbientIntervalSec`), and
`taskModels {fast, thinking, coding}` as `"provider:model"` strings.

A **one-shot migration** on boot rewrites any task model that is in the legacy/
dead set (or any `gemini:*` route) to the current defaults — this is how the
app survives the free tier shifting under it.

`conversationSummary` reads/writes the rolling summary; `uid()` makes ids.

---

## 6. The brain (`src/lib/alpha.functions.ts`, ~740 lines)

### 6.1 Model routing

`TaskType = "auto" | "fast" | "thinking" | "coding"`; providers
`"groq" | "openai" | "openrouter"`. Route specs look like
`groq:llama-3.3-70b-versatile`. `pickRoute()` picks the lane's model, verifies
the provider has a key, and otherwise falls back to whichever lane has a key.
API keys are sanitised (`Bearer `, quotes, whitespace stripped).

Current verified free defaults:

| Lane         | Route                                                          |
| ------------ | -------------------------------------------------------------- |
| Fast         | `groq:llama-3.3-70b-versatile`                                 |
| Thinking     | `openrouter:nvidia/nemotron-3-super-120b-a12b:free`            |
| Coding       | `openrouter:poolside/laguna-s-2.1:free`                        |
| Vision       | `VISION_FALLBACKS[0]` on OpenRouter                            |
| Images       | Pollinations (`image.pollinations.ai`, FLUX.1-schnell, no key) |
| STT fallback | Groq `whisper-large-v3-turbo`                                  |

Fallback chains walked on 404 / rate-limit / empty answer:

```
VISION_FALLBACKS = nvidia/nemotron-nano-12b-v2-vl:free
                   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
                   google/gemma-4-26b-a4b-it:free
TEXT_FALLBACKS   = nvidia/nemotron-3-super-120b-a12b:free
                   poolside/laguna-s-2.1:free
                   inclusionai/ling-3.0-flash:free
                   nvidia/nemotron-3-nano-30b-a3b:free
```

**Google Gemini was removed entirely** (too restrictive, quota burn, 401/404
churn). Any leftover `gemini:` route is auto-migrated away.

### 6.2 Grounding pipeline

`shouldFetchWeb()` regex-detects time-sensitive/factual questions. If it hits,
`fetchLiveWebContext()` scrapes **DuckDuckGo HTML** results and reads pages via
**Jina reader**, then injects a `LIVE WEB SEARCH RESULTS` block into the system
prompt. Every online provider gets the same evidence block. Web fetch is
skipped when images are attached (latency) and when fully offline.
`appendSourcesIfWeb()` appends a real **Sources** list.

### 6.3 System prompt (the personality contract)

`DEFAULT_SYSTEM(extra, recall, rolling, {offline})` composes:

1. Optional **OFFLINE MODE** preamble (no internet → never invent citations).
2. Identity: _"You are Alpha — a hyper-intelligent, futuristic AI companion
   with warm, level-3 wit"_, natural acknowledgement cues, never robotic.
3. **Response Style & Formatting Specification** (highest priority): human
   readability first, 2–4-sentence paragraphs, blank line between every block,
   `##`/`###` descriptive headings past ~5 sentences, sparing bold, lists over
   comma runs, Markdown tables for comparisons, fenced code with language tags,
   LaTeX math, warnings under their own **Warning** line, the default
   `Short answer → Explanation → Steps → Notes → Recommendation` pattern, at
   most one organiser emoji per heading, and a silent pre-send skim checklist.
4. **Self-awareness of his own toolkit** — every route and what it does.
5. **Temporal anchor** — exact local date/time, tz, UTC, unix ms, with the rule
   that it overrides training data and search snippets.
6. **Live user data snapshot** (`ctxSummary()`) + semantically reranked recall
   - rolling compacted state.
7. **Grounding & truthfulness hard rules** — evidence-only mode, forbidden to
   invent titles/URLs/authors/dates/quotes/versions, snippet-vs-full-page
   honesty, `[1]`-style citations, contradiction check, single-source labelling,
   never double down when corrected.
8. **Internal reasoning** — plan silently, self-critique, never print CoT.
9. **Proactive intelligence** — answer the obvious follow-ups in one pass.
10. **Vision rules** — answer about what is actually visible; deictic questions
    ("does this look good on me?") refer to the attached frame; say when the
    frame is too dark/blurry instead of guessing.
11. **Evidence labels** ✅ confirmed / 💭 likely / ❓ unknown.
12. **TOOL ACTIONS** — the action-tag grammar (below).
13. User personalisation (`personaExtra`).

### 6.4 Action tags (agentic control)

Alpha must emit these inline, one per line; `executeActionTags()` parses and
executes them against the store, with name-based and fuzzy matching:

```
[[ADD_NOTE: title | body]]
[[ADD_REMINDER: title | when]]
[[ADD_MEMORY: topic | detail]]
[[ADD_PLAN: title | from | to | date]]
[[ADD_BILL: name | amount | dueDate]]
[[DELETE_LAST: note|reminder|memory|plan|bill]]
[[DELETE_NOTE|DELETE_REMINDER|DELETE_MEMORY|DELETE_PLAN|DELETE_BILL: keyword]]
[[CLEAR_ALL: notes|reminders|memories|plans|bills]]
[[UPDATE_NOTE: keyword | new title | new body]]
[[MARK_REMINDER_DONE: keyword]]
[[MARK_BILL_PAID: keyword]]
[[SET_SETTING: key | value]]   // voiceEnabled, continuousListen, backgroundEnabled,
                               // kokoroVoice, ttsRate, fastModel, thinkingModel, codingModel
[[SET_PROFILE: name | bio]]
```

Hard rule in the prompt: never claim "done/deleted/changed" without emitting
the matching tag — the app only mutates state when a tag is present.

### 6.5 Memory architecture

- **Short term**: last N chat turns sent to the model.
- **Rolling compactor** (`maybeCompactSummary`): every ~10 turns a cheap model
  compresses history into a ≤600-word bullet **STATE MATRIX** stored in
  `alpha.summary.v1`.
- **Semantic recall** (`tokenize` / `score` / `rerankContext`): scans the entire
  history plus notes/memories and injects the top matches for this turn, so
  Alpha remembers beyond the message cap.
- **Explicit memories**: `/memories` tool, always in the live snapshot.

---

## 7. Voice pipeline

### 7.1 TTS (`src/lib/voice.ts`, ~540 lines)

Cascade, first that works wins:

1. **Kokoro-FastAPI** (`kokoroEndpoint`, default voice `am_michael`) — the
   preferred natural voice.
2. **Browser `speechSynthesis`** with `pickVoice()` preferring British voices.
3. **Network TTS fallback** (StreamElements "Brian") — added because
   `window.speechSynthesis` is undefined in some Android WebViews.

Latency tricks: `prepareUtterance()` unlocks audio with a silent WAV on the
first user gesture; `chunkForTTS()` splits the reply into a short first chunk
(~80 chars) and larger rest chunks (~220) so speech starts in well under 3s;
emojis and markdown are stripped before speaking (`speech-text.ts` also
normalises LaTeX into speakable words). `speakingState` is a tiny pub/sub the
Orb subscribes to; `stopSpeaking()` hard-cancels.

### 7.2 STT

`ContinuousRecognizer` (Web Speech API) with an Android-safe auto-restart loop,
plus `WhisperRecognizer` (local faster-whisper OpenAI-compatible server) and
`GroqWhisperRecognizer` (`whisper-large-v3-turbo`). `pickBackend()` chooses
`browser | whisper | groq` from `sttBackend` and actual support/online state;
failures reset the orb state instead of hanging.

**Half-duplex** discipline: the mic is muted while Alpha speaks so he never
hears himself, and only one component may own the microphone stream at a time
(this fixed the original "words not recognised" bug).

### 7.3 Voice navigation

`voice-router.ts` parses intents from the transcript ("open chat / notes /
bills / image / reminders / plans / memories / settings", stop, etc.) and
`execIntent()` performs router navigation hands-free.

### 7.4 Local intents

`local-intents.ts` (288 lines) answers/executes common commands **without any
model call** — list items, bulk clear, fuzzy delete, natural-language time
parsing (`parseNaturalWhen`). `settings-intents.ts` lets Alpha change his own
settings by voice. This is the zero-latency, zero-cost fast path.

---

## 8. Vision ("the seeing eye")

- `vision-stream.ts` — owns `getUserMedia`, the hidden `<video>`, brightness/
  motion sampling, `subscribeActive` / `subscribeBrightness` pub/subs, and
  `captureFrame(maxSide=640, q=0.72)`.
- `vision-command.ts` — `isVisionCommand()` for explicit "what do you see", and
  `shouldCaptureFrame()` for **deictic** questions ("how do I look?", "what's
  on my head?", "read this") so pointing the eye at something is enough.
- `vision-ambient.ts` — optional background watching loop, hard-capped at
  **12 calls/hour**, interval configurable in Settings.
- `image-utils.ts` — `fileToShrunkDataUrl()` downscales uploads to ~1024px JPEG
  before they ever leave the device.
- `openai-compat.ts` — strips historical base64 images (only the current turn
  carries image data), flattens multimodal content to text for non-vision
  models, and extracts `reasoning_content` when `content` is empty.
- Hard request timeouts (60–90s) so the UI never hangs "thinking" forever.

---

## 9. Background agency

- `alarm-engine.ts` — real on-device alarms with sub-minute precision: WebAudio
  chime, system Notification, and a spoken announcement. Global AudioContext
  unlock on first gesture so Android allows sound.
- `proactive.ts` — morning briefing (once per day), overdue-bill and upcoming-
  plan nudges, gated by `alpha.proactive.*` day keys.
- `alerts.ts` — small alert bus the UI and voice layer both read.
- `music.ts` — IndexedDB MP3 library (`addMusicFiles`, `listMusicTracks`,
  `deleteMusicTrack`, `playMusicByName`, `stopMusic`) so Alpha can play the
  user's own uploaded music by name.
- `pwa.ts`, `error-capture.ts`, `error-page.ts`,
  `lovable-error-reporting.ts` — install/update flow and crash reporting.

---

## 10. Data portability

`src/lib/data-portability.ts` exports every `alpha.*` localStorage key **plus**
IndexedDB music tracks as a versioned JSON file
(`{version:1, exportedAt, localStorage, music[]}`), re-imports it, and can wipe
everything. Surfaced in **Settings → Alpha Data → Export / Import** with a
Danger Zone. Verified end-to-end (export → wipe → import restores state).

---

## 11. Setup / recreation checklist

1. `bun install`, `bun dev` → http://localhost:8080.
2. Paste keys in **Settings → Online**: Groq (fast + Whisper STT), OpenRouter
   (thinking/coding/vision), optionally any OpenAI-compatible base+key.
   Keys must be pasted raw — no quotes, no `Bearer`.
3. Optional offline stack (**Settings → Offline**):
   `OLLAMA_ORIGINS='*' ollama serve` + `ollama run llama3.2:3b`,
   Kokoro-FastAPI for TTS, faster-whisper-server for STT.
4. Install as a PWA from Chrome/Edge (Add to Home Screen on Android).
5. `bun run build` for production; deploy anywhere static/edge — no database.

---

## 12. Known weak points / next moves

- Browser STT is still the least reliable link inside Android WebViews; Groq
  Whisper is the safety net but costs a round trip.
- Free-tier model slugs rotate constantly — the migration list and fallback
  chains need periodic live re-verification (a "Verify models" button in
  Settings is the obvious next feature).
- Recall is lexical (token overlap), not vector-based; embeddings would sharpen
  long-term memory.
- Offline mode has no local vision model wired in yet.
- Ambient vision is intentionally throttled; continuous local scene
  understanding would need an on-device model.

---

## 13. File map

```
src/
  routes/        __root, index (Orb), chat, notes, bills, reminders,
                 plans, memories, image, settings
  components/    CyberEye, AlphaOrb, MiniOrb, KittScanner, AudioSpectrum,
                 LiveClock, LiveTranscript, MessageContent, SimpleCrud,
                 AlphaLock, GlobalDock (+ BackArrow)
    desktop/     DesktopShell, OrbStage, DesktopHomePanel, DesktopChatPanel,
                 HudPanel, HudBubble, HorizontalSpectrum, MicDock, ToolRail
  lib/           alpha-store, alpha.functions (brain), openai-compat, ollama,
                 voice, whisper, groq-whisper, speech-text, voice-router,
                 local-intents, settings-intents, vision-stream,
                 vision-ambient, vision-command, image-utils, alarm-engine,
                 proactive, alerts, music, data-portability, pwa,
                 error-capture, error-page, config.server, utils
  styles.css     design tokens, HUD utilities, all keyframes
  router.tsx, server.ts, start.ts
public/          icon-192.png, icon-512.png, favicon, manifest.webmanifest
README.md, .env.example, ALPHA_BLUEPRINT.md
```
