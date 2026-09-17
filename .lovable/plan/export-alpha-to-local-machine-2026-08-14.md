# Export Alpha to Local Machine

Goal: Take the full Alpha project source code and run it locally on your own machine for independent review, editing, and offline testing.

## What you'll get

- The complete source tree (React + TanStack Start + Tailwind + Vite + PWA).
- All assets and icons.
- No locked-in Lovable runtime dependencies.
- **Not included**: runtime data stored in your browser's localStorage (notes, memories, reminders, settings, chat history). Those are device-local and would need to be migrated separately if needed.

## Plan

1. **Export from Lovable**
   - Connect your GitHub account to Lovable via the Plus (+) menu → GitHub.
   - Transfer the project to a GitHub repository.
   - Clone the repo to your local machine with `git clone <repo-url>`.
   - _(Alternative if you don't want GitHub)_: Use the Code Editor View to copy files, or use a Lovable export option if available.

2. **Install prerequisites**
   - Node.js 20+ (or 22 LTS recommended).
   - Bun package manager (the project uses `bun` based on `bunfig.toml`).
   - A GitHub account if you choose the transfer route.

3. **Install dependencies locally**
   - `cd <project-folder>`
   - `bun install`

4. **Configure local environment**
   - Create `.env` in the project root with the required API keys and settings. The app expects keys like:
     - OpenRouter key
     - Groq key
     - (Optional) Kokoro-FastAPI / Ollama endpoints for offline voice and models
   - Verify that `VITE_*` browser-side variables and server-side `process.env` keys are set correctly.

5. **Run locally**
   - `bun dev` (or `bun run dev`) — starts the Vite dev server.
   - Open the URL shown (usually `http://localhost:8080`).
   - Test the PWA install in Chrome/Edge DevTools → Application → Manifest.

6. **Build and validate**
   - Run `bun run build` to confirm the production TanStack Start bundle succeeds.
   - Check for any missing environment variables that cause runtime errors.

7. **Optional: preserve local data**
   - If you want to keep your current in-browser notes, reminders, memories, chat history, and settings, I can add a one-click export/import JSON feature to Alpha before you move.

## Open questions to confirm

- Do you want me to add an in-app "Export / Import my data" feature so you can move your localStorage data too?
- Do you need help generating a proper `.env.example` file listing every key the app currently uses?
