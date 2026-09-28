import { describe, expect, it } from "vitest";
import { NO_ACTION_NOTICE } from "../src/lib/actions";
import {
  alphaGate,
  ALPHA_GATE_FALLBACK_TEXT,
  type AlphaGateCandidate,
  type AlphaGateOrigin,
} from "../src/lib/alpha-gate";

describe("Alpha Gate Phase 1 Foundation Suite", () => {
  // -------------------------------------------------------------------------
  // 1. Reasoning Isolation
  // -------------------------------------------------------------------------
  describe("Reasoning Isolation", () => {
    it("strips <think> and </think> tags and their contents", () => {
      const input = "<think>Let me figure this out step by step...</think>The capital of France is Paris.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toBe("The capital of France is Paris.");
      expect(res.diagnostics?.thinkingStripped).toBe(true);
    });

    it("strips <thinking>, <reasoning>, and <thought> tags", () => {
      const input = "<thinking>Secret internal plan.</thinking><reasoning>Step 1</reasoning><thought>Step 2</thought>Here is the final answer.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toBe("Here is the final answer.");
      expect(res.diagnostics?.thinkingStripped).toBe(true);
    });

    it("strips <analysis> and <internal_monologue> tags", () => {
      const input = "<analysis>Deconstructing question</analysis><internal_monologue>User seems in a hurry</internal_monologue>Ready to assist.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toBe("Ready to assist.");
      expect(res.diagnostics?.thinkingStripped).toBe(true);
    });

    it("strips classic reasoning preambles without XML tags", () => {
      const input = "Thinking Process:\n1. Check dates.\n2. Summarize findings.\n\nFinal Answer:\nEverything is up to date.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toBe("Everything is up to date.");
      expect(res.diagnostics?.thinkingStripped).toBe(true);
    });

    it("preserves legitimate prose containing words like 'analysis' or 'thinking'", () => {
      const input = "Our financial analysis shows strong revenue growth. I have been thinking about this carefully.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("financial analysis shows strong revenue growth");
      expect(res.approvedText).toContain("thinking about this carefully");
      expect(res.diagnostics?.thinkingStripped).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Provider Leakage
  // -------------------------------------------------------------------------
  describe("Provider Leakage Filtering", () => {
    it("removes assistant self-identification as Llama 3", () => {
      const input = "Hello! I am Llama 3, how can I help you today?";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).not.toContain("Llama 3");
      expect(res.approvedText).toBe("how can I help you today?");
      expect(res.diagnostics?.providerLeakStripped).toBe(true);
    });

    it("removes assistant self-identification as OpenAI assistant", () => {
      const input = "As an OpenAI assistant, I am ready to process your files.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).not.toContain("OpenAI assistant");
      expect(res.approvedText).toBe("I am ready to process your files.");
      expect(res.diagnostics?.providerLeakStripped).toBe(true);
    });

    it("removes Groq and OpenRouter infrastructure banners", () => {
      const input = "The calculations are complete.\n\nRunning on Groq.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toBe("The calculations are complete.");
      expect(res.diagnostics?.providerLeakStripped).toBe(true);
    });

    it("strictly preserves informational mentions of OpenAI, Meta, or Llama", () => {
      const input = "OpenAI is an AI research company founded in 2015. Meta released Llama 3 under an open weights license.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("OpenAI is an AI research company founded in 2015.");
      expect(res.approvedText).toContain("Meta released Llama 3 under an open weights license.");
      expect(res.diagnostics?.providerLeakStripped).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Presentation Integration
  // -------------------------------------------------------------------------
  describe("Presentation Integration", () => {
    it("converts top-level H1 to canonical Alpha H2", () => {
      const input = "# System Overview\n\nAll services operational.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("## System Overview");
    });

    it("normalizes LaTeX math delimiters from bracket to KaTeX standard", () => {
      const input = "Inline math \\( x^2 + y^2 = z^2 \\) and display math:\n\\[ E = mc^2 \\]";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("$x^2 + y^2 = z^2$");
      expect(res.approvedText).toContain("$$\nE = mc^2\n$$");
    });

    it("auto-repairs unclosed display math", () => {
      const input = "Formula:\n\n$$\\int_0^1 f(x) dx";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("$$\\int_0^1 f(x) dx\n$$");
      expect(res.diagnostics?.mathRepaired).toBe(true);
    });

    it("normalizes callouts into GFM blockquote syntax", () => {
      const input = "> **Warning:** Do not unplug device during update.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("> [!WARNING]");
    });

    it("auto-closes unclosed code blocks for truncation safety", () => {
      const input = "```typescript\nconst active = true;";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("```typescript\nconst active = true;\n```");
      expect(res.diagnostics?.fencesRepaired).toBe(true);
    });

    it("fences ASCII box-drawings into diagram code blocks", () => {
      const input = "┌───┐   ┌───┐\n│ A │──>│ B │\n└───┘   └───┘";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("```diagram");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Semantic Preservation
  // -------------------------------------------------------------------------
  describe("Semantic Preservation Contract", () => {
    it("preserves dates, times, currencies, quantities, and URLs exactly", () => {
      const input = "Meeting on October 14, 2026 at 10:30 AM for $149.99 with 5 attendees. Reference: https://alpha.example.com/api/v2?session=xyz";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("October 14, 2026");
      expect(res.approvedText).toContain("10:30 AM");
      expect(res.approvedText).toContain("$149.99");
      expect(res.approvedText).toContain("5 attendees");
      expect(res.approvedText).toContain("https://alpha.example.com/api/v2?session=xyz");
    });

    it("preserves code tokens and quoted strings without alteration", () => {
      const input = "Run `curl -X POST https://api.alpha.io/auth` with header `\"Authorization: Bearer test-token\"`.";
      const res = alphaGate.process({ rawText: input, origin: "model" });
      expect(res.approvedText).toContain("`curl -X POST https://api.alpha.io/auth`");
      expect(res.approvedText).toContain("`\"Authorization: Bearer test-token\"`");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Action Verification
  // -------------------------------------------------------------------------
  describe("Action Verification", () => {
    it("Case A: allows claimed action when execution succeeded", () => {
      const input = "I have scheduled your reminder.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        actionResults: [
          { status: "success", message: "Reminder 'Team Sync' scheduled for 3:00 PM." },
        ],
      });
      expect(res.actionStatus).toBe("success");
      expect(res.approvedText).toContain("I have scheduled your reminder.");
      expect(res.approvedText).toContain("✅ Reminder 'Team Sync' scheduled for 3:00 PM.");
    });

    it("Case B: appends failure notice and neutralizes false success claim when action failed execution", () => {
      const input = "I deleted your note.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        actionResults: [
          { status: "failed", message: "Note not found." },
        ],
      });
      expect(res.actionStatus).toBe("all_failed");
      expect(res.approvedText).toContain("❌ Note not found.");
      expect(res.approvedText).not.toContain("I deleted your note.");
      expect(res.diagnostics?.actionRepaired).toBe(true);
    });

    it("Case B: preserves surrounding legitimate prose while removing false success claim on failure", () => {
      const input = "Here is your note history. I deleted your note.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        actionResults: [
          { status: "failed", message: "Note not found." },
        ],
      });
      expect(res.actionStatus).toBe("all_failed");
      expect(res.approvedText).toContain("Here is your note history.");
      expect(res.approvedText).not.toContain("I deleted your note.");
      expect(res.approvedText).toContain("❌ Note not found.");
      expect(res.diagnostics?.actionRepaired).toBe(true);
    });

    it("Case C: detects unexecuted claimed action, neutralizes false claim, and appends NO_ACTION_NOTICE", () => {
      const input = "I deleted your reminder for tomorrow morning.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        // No actionResults, no toolSummary
      });
      expect(res.actionStatus).toBe("unverified_claim");
      expect(res.approvedText).toContain(NO_ACTION_NOTICE);
      expect(res.approvedText).not.toContain("I deleted your reminder for tomorrow morning.");
      expect(res.diagnostics?.actionRepaired).toBe(true);
    });

    it("Case C: preserves legitimate prose while neutralizing unexecuted action claims", () => {
      const input = "I am looking into this for you. I created a new reminder.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
      });
      expect(res.actionStatus).toBe("unverified_claim");
      expect(res.approvedText).toContain("I am looking into this for you.");
      expect(res.approvedText).not.toContain("I created a new reminder.");
      expect(res.approvedText).toContain(NO_ACTION_NOTICE);
      expect(res.diagnostics?.actionRepaired).toBe(true);
    });

    it("Case D: handles partial failures across multiple actions accurately", () => {
      const input = "I processed your request.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        actionResults: [
          { status: "success", message: "Created task A." },
          { status: "failed", message: "Failed to create task B: storage full." },
        ],
      });
      expect(res.actionStatus).toBe("partial_failure");
      expect(res.approvedText).toContain("✅ Created task A.");
      expect(res.approvedText).toContain("❌ Failed to create task B: storage full.");
      expect(res.diagnostics?.actionRepaired).toBe(true);
    });

    it("Case E: appends action report when execution succeeded with no explicit prose claim", () => {
      const input = "All set.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        actionResults: [
          { status: "success", message: "Set alarm for 07:00." },
        ],
      });
      expect(res.actionStatus).toBe("success");
      expect(res.approvedText).toContain("✅ Set alarm for 07:00.");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Source Verification
  // -------------------------------------------------------------------------
  describe("Source Verification", () => {
    const sampleWebContext = `[1] Official Docs - https://docs.example.com/api\n[2] Tech News (URL: https://technews.com/update)`;

    it("validates and formats citations that match retrieved web context", () => {
      const input = "According to the official docs [1], version 2 is now stable.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        webContext: sampleWebContext,
      });
      expect(res.approvedText).toContain("[1]");
      expect(res.approvedText).toContain("**Sources:**");
      expect(res.approvedText).toContain("- [1] [Official Docs](https://docs.example.com/api)");
      expect(res.approvedText).not.toContain("Tech News"); // Item [2] was not cited
    });

    it("strips citations and sources when citation number was not in web context", () => {
      const input = "Here is some info [99].\n\n**Sources:**\n- [99] Hallucinated Link (https://fake.com)";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        webContext: sampleWebContext,
      });
      expect(res.approvedText).not.toContain("https://fake.com");
      expect(res.approvedText).not.toContain("**Sources:**");
      expect(res.approvedText).not.toContain("[99]");
      expect(res.approvedText).toBe("Here is some info.");
    });

    it("filters mixed citations keeping valid ones and removing unsupported markers", () => {
      const input = "According to docs [1, 99], the system is verified.";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        webContext: sampleWebContext,
      });
      expect(res.approvedText).toContain("[1]");
      expect(res.approvedText).not.toContain("99");
      expect(res.approvedText).toContain("**Sources:**");
      expect(res.approvedText).toContain("- [1] [Official Docs](https://docs.example.com/api)");
    });

    it("strips unsupported citation markers when webContext is entirely missing", () => {
      const input = "Here is unverified info [1].\n\n**Sources:**\n- [1] Unverified Link (https://example.com)";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        webContext: undefined,
      });
      expect(res.approvedText).not.toContain("[1]");
      expect(res.approvedText).not.toContain("**Sources:**");
      expect(res.approvedText).toBe("Here is unverified info.");
    });

    it("strips sources section when response explicitly admits insufficient evidence", () => {
      const input = "I returned no usable results and found insufficient evidence.\n\n**Sources:**\n- [1] Some Link";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        webContext: sampleWebContext,
      });
      expect(res.approvedText).not.toContain("**Sources:**");
      expect(res.approvedText).not.toContain("- [1] Some Link");
    });

    it("strips orphaned **Sources:** footer when webContext is missing entirely", () => {
      const input = "Here is the summary.\n\n**Sources:**\n- [1] Unverified Link (https://example.com)";
      const res = alphaGate.process({
        rawText: input,
        origin: "model",
        webContext: undefined,
      });
      expect(res.approvedText).toBe("Here is the summary.");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Empty & Failure Fallback Behavior
  // -------------------------------------------------------------------------
  describe("Empty & Failure Fallback Behavior", () => {
    it("returns in-character fallback on empty string", () => {
      const res = alphaGate.process({ rawText: "", origin: "model" });
      expect(res.approvedText).toBe(ALPHA_GATE_FALLBACK_TEXT);
      expect(res.status).toBe("fallback");
    });

    it("returns in-character fallback on whitespace-only string", () => {
      const res = alphaGate.process({ rawText: "   \n\t  ", origin: "model" });
      expect(res.approvedText).toBe(ALPHA_GATE_FALLBACK_TEXT);
      expect(res.status).toBe("fallback");
    });

    it("returns generation stopped when abort signal is triggered", () => {
      const controller = new AbortController();
      controller.abort();
      const res = alphaGate.process({
        rawText: "Partial uncompleted string...",
        origin: "model",
        signal: controller.signal,
      });
      expect(res.approvedText).toBe("Generation stopped.");
      expect(res.status).toBe("fallback");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Origin Coverage
  // -------------------------------------------------------------------------
  describe("Origin Coverage", () => {
    const origins: AlphaGateOrigin[] = [
      "model",
      "local_intent",
      "settings",
      "proactive",
      "ambient",
      "notification",
      "system_error",
    ];

    origins.forEach((origin) => {
      it(`processes responses cleanly for origin '${origin}' without semantic deviation`, () => {
        const input = `Notification event: system status normal for origin ${origin}.`;
        const res = alphaGate.process({ rawText: input, origin });
        expect(res.approvedText).toContain(`Notification event: system status normal for origin ${origin}.`);
        expect(res.status).toBe("approved");
      });
    });
  });
});
