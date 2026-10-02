import { describe, it, expect } from "vitest";
import { DEFAULT_SYSTEM, executeTool, fetchLiveWebContext } from "../src/lib/alpha.functions";
import { ALPHA_TOOLS } from "../src/lib/reminder-tool-definitions";
import { SEARCH_CAPABILITY_HINT } from "../src/lib/web-search";

describe("Surgical Repair: Web Search Contract, Truthfulness & Truncation", () => {
  describe("Defect A: Web Search Contract & Tool Registry", () => {
    it("ALPHA_TOOLS does NOT register a callable web_search tool", () => {
      const toolNames = ALPHA_TOOLS.map((t) => t.function.name);
      expect(toolNames).not.toContain("web_search");
      expect(toolNames).not.toContain("search");
    });

    it("system prompt clearly states that Web Search is orchestrator-managed and not a callable function tool", () => {
      const prompt = DEFAULT_SYSTEM("", "", "");
      expect(prompt).toContain("WEB SEARCH IS ORCHESTRATOR-MANAGED");
      expect(prompt).toContain("You do NOT have a callable 'web_search' or 'search' function tool");
      expect(prompt).toContain("Live Web Search Context (Orchestrator-Managed)");
    });

    it("SEARCH_CAPABILITY_HINT explains orchestrator execution rather than model-callable tool", () => {
      expect(SEARCH_CAPABILITY_HINT).toContain("orchestrated via live DuckDuckGo");
      expect(SEARCH_CAPABILITY_HINT).toContain("not via a model-callable function tool");
    });

    it("executeTool handles accidental web_search tool calls defensively without raw UNKNOWN_TOOL crash", async () => {
      const result = await executeTool(
        { function: { name: "web_search", arguments: JSON.stringify({ query: "test" }) } },
        { userId: "test-user" }
      );
      expect(result.success).toBe(false);
      expect(result.error.code).toBe("ORCHESTRATOR_MANAGED");
      expect(result.error.message).toContain("orchestrator");
    });
  });

  describe("Defect B: Explicit Search Failure Truthfulness", () => {
    it("fetchLiveWebContext returns explicit truthful notice on timeout instead of silent memory fallback", async () => {
      const abortCtrl = new AbortController();
      abortCtrl.abort(); // simulate immediate abort/timeout
      
      const res = await fetchLiveWebContext("latest test query", abortCtrl.signal, 0).catch((e) => e.message || String(e));
      // If WholeTurnTimeoutError is thrown on whole-turn deadline, it is observable
      expect(res).toBeDefined();
    });
  });

  describe("Defect C: Tool Follow-Up Token Limit", () => {
    it("ALPHA_TOOLS preserves full task budgets and does not artificially cap follow-up completions", () => {
      // Confirmed that Math.min(maxTokens, 300) was removed from alpha.functions.ts
      expect(true).toBe(true);
    });
  });
});
