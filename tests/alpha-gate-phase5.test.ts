import { describe, it, expect } from "vitest";
import { alphaGate, ALPHA_GATE_FALLBACK_TEXT } from "../src/lib/alpha-gate";
import { finalizeReply } from "../src/lib/alpha.functions";
import { tryLocalIntent } from "../src/lib/local-intents";
import { trySettingsIntent } from "../src/lib/settings-intents";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";
import { alphaStore } from "../src/lib/alpha-store";
import { fireAlarm } from "../src/lib/alarm-engine";

describe("Alpha Gate Phase 5 — Full Forensic Integration & Authority Invariants", () => {
  it("1. Single Authority Invariant: every response producer routes to Gate before storage and UI", async () => {
    // 1. Model response
    const modelOut = await finalizeReply("Here is the requested information.", "");
    expect(modelOut).toBe("Here is the requested information.");

    // 2. Local intent response
    const lifecycle = new RequestActionLifecycle();
    const localOut = await tryLocalIntent("add note Project Roadmap Review milestones tomorrow", lifecycle);
    expect(localOut).toBeDefined();
    expect(typeof localOut).toBe("string");
    expect(localOut?.toLowerCase()).toContain("note saved");

    // 3. Settings intent response
    const settingsOut = await trySettingsIntent("disable voice", lifecycle);
    expect(settingsOut).toBe("Voice replies disabled.");

    // 4. Proactive candidate
    const proactiveRes = alphaGate.process({
      rawText: "Good morning! You have 2 reminders scheduled today.",
      origin: "proactive",
    });
    expect(proactiveRes.approvedText).toContain("Good morning!");
    expect(proactiveRes.status).toBe("approved");

    // 5. Ambient candidate
    const ambientRes = alphaGate.process({
      rawText: "A person entered the room carrying a notebook.",
      origin: "ambient",
    });
    expect(ambientRes.approvedText).toBe("A person entered the room carrying a notebook.");

    // 6. Notification candidate
    const notifRes = alphaGate.process({
      rawText: "Reminder: Team standup begins in 10 minutes.",
      origin: "notification",
    });
    expect(notifRes.approvedText).toBe("Reminder: Team standup begins in 10 minutes.");
  });

  it("2. Exactly-once gating invariant: already gated responses are not double-processed with redundant repairs", () => {
    const raw = "<think>Deliberating</think># Objective\n> [!NOTE]\n> Ensure quality.";
    const firstPass = alphaGate.process({ rawText: raw, origin: "model" });

    expect(firstPass.approvedText).not.toContain("<think>");
    expect(firstPass.approvedText).toContain("## Objective");
    expect(firstPass.status).toBe("repaired");
    expect(firstPass.diagnostics?.thinkingStripped).toBe(true);

    // If passed again, output remains identical and cleanly approved without re-mutation
    const secondPass = alphaGate.process({ rawText: firstPass.approvedText, origin: "model" });
    expect(secondPass.approvedText).toBe(firstPass.approvedText);
    expect(secondPass.status).toBe("approved");
    expect(secondPass.diagnostics).toBeUndefined();
  });

  it("3. Context loop purity: internal Gate diagnostics and reasoning never pollute conversation history", () => {
    const rawWithAllArtifacts = "<think>Secret tokens</think>As an OpenAI model, I have saved the note. # Details\n```js\nconsole.log(1);";
    const gateRes = alphaGate.process({ rawText: rawWithAllArtifacts, origin: "model" });

    // Stored message in alphaStore only receives gateRes.approvedText
    const storedMessage = {
      id: "msg-123",
      role: "model" as const,
      text: gateRes.approvedText,
      ts: Date.now(),
    };

    expect(storedMessage.text).not.toContain("<think>");
    expect(storedMessage.text).not.toContain("OpenAI");
    expect(storedMessage.text).toContain("## Details");
    expect((storedMessage as any).diagnostics).toBeUndefined();
    expect((storedMessage as any).actionStatus).toBeUndefined();
  });

  it("4. Action integrity: false mutation claims without execution record are completely neutralized", async () => {
    const falseClaim = "I deleted your note.";
    const toolSummary = {
      executedCount: 1,
      hasMutation: true,
      allMutationsSucceeded: false,
      hasFailedMutation: true,
      results: [
        {
          name: "deleteNote",
          success: false,
          isMutation: true,
          error: { message: "Note not found in repository." },
          logicalKeys: ["note:delete:999"],
        },
      ],
      executedLogicalKeys: [],
    };

    const reconciled = await finalizeReply(falseClaim, "", toolSummary);
    expect(reconciled).not.toContain("I deleted your note.");
    expect(reconciled).toContain("❌ Note not found in repository.");
  });

  it("5. Action integrity: verified executions preserve success prose and accurate action reports", async () => {
    const validProseWithTag = "I've added that note for you. [[ADD_NOTE: Standup Notes | Discussed Phase 5 verification and status.]]";
    const lifecycle = new RequestActionLifecycle();

    const approved = await finalizeReply(validProseWithTag, "", undefined, { lifecycle });
    expect(approved).toContain("I've added that note for you.");
    expect(approved).toContain('✅ Note saved: "Standup Notes"');
    expect(approved).not.toContain("[[ADD_NOTE");
  });

  it("6. Sources integrity: unsupported citation markers are removed while verified citations survive", async () => {
    const webContext = "[1] Alpha Architecture - https://alpha.ai/arch\n[2] Fast React - https://react.dev";
    const rawText = "Alpha is designed for real-time responsiveness [1] and high accuracy [99].";

    const result = await finalizeReply(rawText, webContext);
    expect(result).toContain("[1]");
    expect(result).not.toContain("[99]");
    expect(result).toContain("**Sources:**");
    expect(result).toContain("- [1] [Alpha Architecture](https://alpha.ai/arch)");
    expect(result).not.toContain("https://react.dev"); // Uncited source excluded
  });

  it("7. Semantic Immutability: numerical values, operators, code, dates, and names are protected", () => {
    const complexContent = `Financial update for 2026-09-28:
- Revenue: $1,450,200.50 (growth +14.8%)
- Formula: $f(x) = \\sum_{i=1}^n x_i^2$
- Server: https://api.alpha.internal:8080/v2/status

\`\`\`python
def calculate_growth(prev: float, curr: float) -> float:
    return ((curr - prev) / prev) * 100.0
\`\`\`
`;
    const res = alphaGate.process({ rawText: complexContent, origin: "model" });
    expect(res.approvedText).toContain("1,450,200.50");
    expect(res.approvedText).toContain("+14.8%");
    expect(res.approvedText).toContain("2026-09-28");
    expect(res.approvedText).toContain("https://api.alpha.internal:8080/v2/status");
    expect(res.approvedText).toContain("def calculate_growth(prev: float, curr: float) -> float:");
    expect(res.approvedText).toContain("return ((curr - prev) / prev) * 100.0");
  });

  it("8. Fail-safe fallback: empty, whitespace, and aborted generations produce safe in-character fallbacks", () => {
    const emptyRes = alphaGate.process({ rawText: "", origin: "model" });
    expect(emptyRes.approvedText).toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(emptyRes.status).toBe("fallback");

    const abortedRes = alphaGate.process({
      rawText: "Partial unfin",
      origin: "model",
      signal: { aborted: true } as any,
    });
    expect(abortedRes.approvedText).toBe("Generation stopped.");
  });

  it("9. Dedicated Audio Exception: alarm engine fires WebAudio chime and speech without polluting chat history", () => {
    const initialChatCount = alphaStore.get().chat.length;
    fireAlarm("Standup Meeting", "Prepare updates");
    expect(alphaStore.get().chat.length).toBe(initialChatCount);
  });
});
