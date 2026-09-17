import type { useRouter } from "@tanstack/react-router";

type Router = ReturnType<typeof useRouter>;

export type RouterIntent =
  | { kind: "navigate"; to: "/chat" | "/notes" | "/bills" | "/image" | "/settings" | "/reminders" | "/plans" | "/memories" | "/" }
  | { kind: "stop" }
  | { kind: "chat"; text: string };

export function parseIntent(transcript: string): RouterIntent {
  const t = transcript.toLowerCase().trim();
  if (/(stop listening|pause listening|mute mic|go silent|shut up|be quiet)/.test(t)) return { kind: "stop" };
  if (/\bopen (chat|console|messages?)\b/.test(t)) return { kind: "navigate", to: "/chat" };
  if (/\bopen notes?\b/.test(t)) return { kind: "navigate", to: "/notes" };
  if (/\bopen (bills?|ledger|finance|money)\b/.test(t)) return { kind: "navigate", to: "/bills" };
  if (/\bopen (image|camera|vision|gallery|picture)\b/.test(t)) return { kind: "navigate", to: "/image" };
  if (/\bopen (reminders?|alarms?|tasks?)\b/.test(t)) return { kind: "navigate", to: "/reminders" };
  if (/\bopen (plans?|routes?|trips?|itinerary)\b/.test(t)) return { kind: "navigate", to: "/plans" };
  if (/\bopen (memor(?:ies|y)|remember)\b/.test(t)) return { kind: "navigate", to: "/memories" };
  if (/\bopen settings?\b/.test(t)) return { kind: "navigate", to: "/settings" };
  if (/\b(go )?home\b|\borb\b/.test(t)) return { kind: "navigate", to: "/" };
  return { kind: "chat", text: transcript };
}

export function execIntent(router: Router, intent: RouterIntent, onChat: (text: string) => void, onStop: () => void) {
  if (intent.kind === "navigate") router.navigate({ to: intent.to });
  else if (intent.kind === "stop") onStop();
  else onChat(intent.text);
}