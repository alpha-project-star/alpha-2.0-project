# Alpha — Local Setup Guide

Alpha is a voice-first, futuristic AI companion built with **TanStack Start**, **React 19**, **Tailwind CSS v4**, and **Vite**. It runs as a Progressive Web App (PWA) on your phone or desktop.

## Requirements

- **Node.js** 20+ (22 LTS recommended)
- **Bun** package manager (`curl -fsSL https://bun.sh/install | bash`)
- A modern browser (Chrome/Edge/Firefox/Safari)

## Quick start

```bash
# 1. Clone or copy the project into a folder
cd alpha

# 2. Install dependencies
bun install

# 3. Start the development server
bun dev
```

Open the URL shown in the terminal (usually `http://localhost:8080`).

## Environment variables

Most configuration lives inside Alpha in **Settings → Online / Offline / Alpha Data**. The `.env` file is optional and mainly used for the build environment.

Copy `.env.example` to `.env` if you need to set anything:

```bash
cp .env.example .env
```

| Variable   | Purpose                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `NODE_ENV` | `development` or `production`                                                     |
| `VITE_*`   | Any public value you want to expose to the browser (not used by Alpha by default) |

## API keys you need

Alpha works best when you supply your own keys in **Settings → Online**:

- **Groq API key** — fast chat models (`console.groq.com`, free tier available)
- **OpenRouter API key** — vision and coding models (`openrouter.ai`, free tier available)
- **OpenAI-compatible key** — optional; for OpenAI, DeepSeek, xAI, etc.

Without these keys, Alpha falls back to **Ollama** in offline mode.

## Offline mode

To run Alpha fully offline on your machine:

1. **Ollama** — `ollama run llama3.2:3b` (or any model you prefer)
   - Start with: `OLLAMA_ORIGINS='*' ollama serve`
2. **Kokoro-FastAPI** (optional, for TTS) — run a local Kokoro-compatible endpoint
3. **Whisper** (optional, for STT) — run a faster-whisper-server endpoint

Set the endpoints in **Settings → Offline**.

## Build for production

```bash
bun run build
```

This produces a TanStack Start production bundle. You can preview it locally:

```bash
bun run preview
```

## PWA install

- Open the app in Chrome/Edge.
- Tap the **install icon** in the address bar or use **Add to Home Screen** on Android.
- The PWA works offline if you have configured Ollama and local services.

## Exporting / importing your Alpha data

All your data (chat history, notes, reminders, memories, settings, and uploaded music) is stored locally in your browser. To move it to another device or back it up:

1. Go to **Settings → Alpha Data → Export / Import**.
2. Tap **Export Alpha data** to download a JSON backup.
3. On the new device, open Alpha and tap **Import Alpha data**.
4. Select the backup file.

## Moving from Lovable to your own host

To deploy Alpha outside Lovable:

1. Push the code to a GitHub repository (Lovable → Plus menu → GitHub).
2. Connect the repo to your host of choice (Vercel, Netlify, Cloudflare Pages, etc.).
3. Set the build command to `bun run build` and output directory to `dist` (or `.output` depending on your host).
4. No backend database is required — Alpha is fully client-side except for the external AI APIs.

## Project structure

```text
src/
  routes/          # TanStack Start routes (pages)
  components/      # React components (Orb, HUD, CyberEye, etc.)
  lib/             # Core logic: store, AI calls, voice, vision, alarms
  styles.css       # Tailwind v4 + custom design tokens
  router.tsx       # Router setup
  server.ts        # SSR entry wrapper
public/            # Static assets: icons, manifest, images
```

## Need help?

If a build fails or a model returns errors, open **Settings → Online** and verify the API keys are pasted without quotes, spaces, or `Bearer` prefixes.
