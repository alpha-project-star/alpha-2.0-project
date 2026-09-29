import { describe, it, expect } from "vitest";
import { alphaGate, ALPHA_GATE_FALLBACK_TEXT } from "../src/lib/alpha-gate";
import { finalizeReply } from "../src/lib/alpha.functions";
import { RequestActionLifecycle } from "../src/lib/request-lifecycle";

describe("Pass A — Action Lifecycle & Action-Only Response Repair", () => {
  it("1. Successful action-only response (Auto Speak) produces verified confirmation instead of empty fallback", async () => {
    const rawModelOutput = "[[SET_SETTING: autoSpeak | false]]";
    const lifecycle = new RequestActionLifecycle();

    const approved = await finalizeReply(rawModelOutput, "", undefined, { lifecycle });

    expect(approved).not.toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(approved.toLowerCase()).toContain("autospeak");
    expect(approved.toLowerCase()).toContain("disabled");
  });

  it("2. Failed action-only response produces truthful failure report", async () => {
    const gateRes = alphaGate.process({
      rawText: "",
      actionResults: [
        {
          tag: "ADD_NOTE",
          status: "error" as any,
          message: "Failed to add note: Storage capacity exceeded.",
          logicalKeys: ["note:1"],
        },
      ],
    });

    expect(gateRes.approvedText).not.toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(gateRes.approvedText).toContain("Failed to add note");
    expect(gateRes.actionStatus).toBe("all_failed");
  });

  it("3. Partial/mixed action result produces truthful partial status", async () => {
    const gateRes = alphaGate.process({
      rawText: "",
      actionResults: [
        {
          tag: "SET_SETTING",
          status: "success",
          message: "Voice replies enabled.",
          logicalKeys: ["setting:1"],
        },
        {
          tag: "ADD_NOTE",
          status: "error" as any,
          message: "Failed to save note.",
          logicalKeys: ["note:2"],
        },
      ],
    });

    expect(gateRes.approvedText).not.toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(gateRes.approvedText).toContain("Voice replies enabled");
    expect(gateRes.approvedText).toContain("Failed to save note");
    expect(gateRes.actionStatus).toBe("partial_failure");
  });

  it("4. Action + normal prose retains prose and reconciles action report correctly without duplication", async () => {
    const rawModelOutput = "Here is your note. [[ADD_NOTE: Test Note | Body content]]";
    const lifecycle = new RequestActionLifecycle();

    const approved = await finalizeReply(rawModelOutput, "", undefined, { lifecycle });

    expect(approved).toContain("Here is your note.");
    expect(approved).toContain("Note saved");
    expect(approved).not.toContain(ALPHA_GATE_FALLBACK_TEXT);
  });

  it("5. Genuinely empty non-action response returns fallback", () => {
    const gateRes = alphaGate.process({
      rawText: "   ",
      origin: "model",
    });

    expect(gateRes.approvedText).toBe(ALPHA_GATE_FALLBACK_TEXT);
    expect(gateRes.status).toBe("fallback");
  });

  it("6. Auto Speak action via real finalizeReply path produces correct confirmation", async () => {
    const raw = "[[SET_SETTING: autoSpeak | true]]";
    const res = await finalizeReply(raw, "");
    expect(res.toLowerCase()).toContain("autospeak");
    expect(res.toLowerCase()).toContain("enabled");
  });

  it("8. Two-turn cross-turn isolation: Turn 1 action confirmation is stored correctly and Turn 2 has fresh lifecycle without stale action results", async () => {
    // Turn 1
    const turn1Raw = "[[SET_SETTING: autoSpeak | false]]";
    const lifecycle1 = new RequestActionLifecycle();
    const turn1Approved = await finalizeReply(turn1Raw, "", undefined, { lifecycle: lifecycle1 });

    expect(turn1Approved.toLowerCase()).toContain("autospeak");
    expect(turn1Approved.toLowerCase()).toContain("disabled");
    expect(lifecycle1.getState()).toBe("completed");

    // Turn 2 (unrelated request)
    const turn2Raw = "Here is your requested formatting output.";
    const lifecycle2 = new RequestActionLifecycle();
    const turn2Approved = await finalizeReply(turn2Raw, "", undefined, { lifecycle: lifecycle2 });

    expect(turn2Approved).toBe("Here is your requested formatting output.");
    expect(lifecycle2.getState()).not.toBe("executing");
    // Ensure no action results from Turn 1 leaked into Turn 2's execution lifecycle
    expect(lifecycle2.getAllOperations()).toHaveLength(0);
  });
});
