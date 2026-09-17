# Live model verification with your own keys

Yes — the OpenRouter key is the one I need. It covers the vision lane and the
deep-thinking / coding lanes. If you also paste the Groq key, I can verify the
fast lane in the same pass. Nothing else is needed.

## How the key gets used

Alpha itself keeps your keys in your browser only, and that does not change.
To run the verification I need a temporary copy of the key inside the build
sandbox, saved through the secure secrets form (never pasted into chat, never
written into any source file, never logged or echoed).

After the check I can delete the sandbox copy, or leave it so future model
sweeps don't need you to re-enter it — your choice.

## What I will actually test

For every candidate model, one real minimal request through the same shape
Alpha uses:

1. Text lanes — a one-sentence prompt to each candidate free slug.
2. Vision lane — a tiny test image plus "what is in this image?", so I confirm
   the model really accepts an `image_url` block rather than just claiming
   image support in the catalogue.
3. Groq fast lane (if you share that key) — same one-sentence prompt.

For each model I record: works / 404 / paid-only / rate-limited / rejects
images, plus rough latency.

## Then

- Promote the models that actually pass into the defaults for fast, thinking,
  coding, and the vision fallback chain, fastest first.
- Drop any slug that fails, so Alpha stops burning calls discovering dead
  models at runtime.
- Report the full pass/fail table back to you.

## Notes

- Free-tier slugs rotate often. Rather than repeat this by hand, I can also add
  a small "Verify models" button in Settings that runs the same check from your
  browser with your own keys, whenever you want it.
- Free rate limits are shared per account, so a 429 during the sweep gets
  retried once before a model is marked failed.
