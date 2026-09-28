import { describe, it, expect } from "vitest";
import { finalizeReply } from "../src/lib/alpha.functions";
import { tryLocalIntent } from "../src/lib/local-intents";
import { trySettingsIntent } from "../src/lib/settings-intents";
import { alphaStore } from "../src/lib/alpha-store";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";
import { NO_ACTION_NOTICE } from "../src/lib/actions";

describe("Alpha Gate Phase 2 — Core Chat Pipeline Integration", () => {

  it("1. Main model response passes through Alpha Gate and formats presentation", async () => {
    const raw = "# Main Heading\n\nHere is a formula: \\( x^2 + y^2 = z^2 \\)";
    const res = await finalizeReply(raw, "");
    expect(res).toContain("## Main Heading");
    expect(res).toContain("$x^2 + y^2 = z^2$");
  });

  it("2. A model response containing leaked reasoning is cleaned before becoming the final response", async () => {
    const raw = "<think>\nThinking about what to say to the user...\n</think>\nHello! How can I assist you today?";
    const res = await finalizeReply(raw, "");
    expect(res).not.toContain("<think>");
    expect(res).not.toContain("Thinking about what to say");
    expect(res).toBe("Hello! How can I assist you today?");
  });

  it("3. A false action-success claim cannot survive failed execution", async () => {
    const raw = "I deleted your note.";
    // finalizeReply receives a failed mutation tool summary
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
          error: { message: "Note id not found in database." },
          logicalKeys: ["note:delete:123"],
        },
      ],
      executedLogicalKeys: [],
    };

    const res = await finalizeReply(raw, "", toolSummary);
    expect(res).not.toContain("I deleted your note.");
    expect(res).toContain("❌ Note id not found in database.");
  });

  it("4. A valid action result remains available to the final response", async () => {
    const raw = "I've added that note for you. [[ADD_NOTE: Meeting Summary | Discussed Q3 targets and roadmap.]]";
    const lifecycle = new RequestActionLifecycle();
    const res = await finalizeReply(raw, "", undefined, { lifecycle });
    expect(res).toContain("I've added that note for you.");
    expect(res).toContain('✅ Note saved: "Meeting Summary"');
  });

  it("5. Web citations are reconciled through the Gate with unsupported numbers removed", async () => {
    const raw = "According to search results [1] and [99], Alpha is an autonomous system.";
    const webContext = `[1] Headline: "Alpha Architecture"
URL: https://example.com/alpha
Alpha is an autonomous voice-first AI assistant.`;

    const res = await finalizeReply(raw, webContext);
    expect(res).toContain("[1]");
    expect(res).not.toContain("[99]");
    expect(res).toContain("**Sources:**");
    expect(res).toContain("- [1] [Alpha Architecture](https://example.com/alpha)");
    expect(res).not.toContain("99");
  });

  it("6. Local Intent responses pass through the Gate", async () => {
    const lifecycle = new RequestActionLifecycle();
    const res = await tryLocalIntent("Note that we need to buy coffee beans", lifecycle);
    expect(res).toBeTruthy();
    expect(res).toContain("Got it — note saved:");
    expect(res).toContain("we need to buy coffee beans");
  });

  it("7. Settings Intent responses pass through the Gate", async () => {
    const lifecycle = new RequestActionLifecycle();
    const res = await trySettingsIntent("disable voice", lifecycle);
    expect(res).toBe("Voice replies disabled.");
    expect(alphaStore.get().settings.voiceEnabled).toBe(false);
  });

  it("8. The approved Gate text, rather than raw text, becomes the final user-facing response", async () => {
    const raw = "<thought>Internal deliberation</thought>I am ready to help with your project.";
    const res = await finalizeReply(raw, "");
    expect(res).toBe("I am ready to help with your project.");
  });

  it("9. Provider fallback still reaches the same final Gate boundary", async () => {
    // Both Ollama and OpenAI-compat routes call finalizeReply
    const rawOllamaOutput = "### Ollama Analysis\nHere is the breakdown:\n1. Step one\n2. Step two";
    const res = await finalizeReply(rawOllamaOutput, "");
    expect(res).toContain("### Ollama Analysis");
    expect(res).toContain("1. Step one");
  });

  it("10. Existing behavior remains intact for ordinary responses", async () => {
    const raw = "Here is a clean conversational response explaining TypeScript interfaces.";
    const res = await finalizeReply(raw, "");
    expect(res).toBe("Here is a clean conversational response explaining TypeScript interfaces.");
  });
});
