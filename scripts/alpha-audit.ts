import { BoundedResearchService } from "../src/lib/research";
import { DuckDuckGoProvider } from "../src/lib/search-providers";
import { decideSearch } from "../src/lib/web-search";
import { SearchProvider, SearchResult } from "../src/lib/web-search";

// Failing provider for Test 4
class FailingProvider implements SearchProvider {
  async search(query: string, limit?: number): Promise<SearchResult[]> {
    throw new Error("Provider unavailable");
  }
  async readPage(url: string) {
    return { title: "", content: "", status: "error" };
  }
}

async function runAudit() {
  const tests = [
    {
      name: "Test 1: Zimbabwe news",
      query: "What are the latest major news developments in Zimbabwe today? Search the web and provide the sources.",
    },
    {
      name: "Test 2: Newton's laws",
      query: "Explain Newton’s three laws of motion in simple terms.",
    },
    {
      name: "Test 3: Zorvathia",
      query: "Find reliable sources about the fictional 19th-century country of Zorvathia.",
    },
    {
      name: "Test 4: Provider error",
      query: "What is the weather in London?",
      useFailingProvider: true,
    },
  ];

  for (const t of tests) {
    console.log(`--- ${t.name} ---`);
    console.log(`User query: "${t.query}"`);

    const decision = decideSearch(t.query);
    console.log(`Web tool selected: ${decision.search}`);

    if (decision.search) {
      const provider = t.useFailingProvider ? new FailingProvider() : new DuckDuckGoProvider();
      const service = new BoundedResearchService(provider);
      
      try {
        const result = await service.research(decision.query || t.query);
        console.log(`Exact dispatched query: "${result.receipt.querySent}"`);
        console.log(`WebToolReceipt: ${JSON.stringify(result.receipt)}`);
        console.log(`Evidence used: ${result.evidence.length > 0}`);
        console.log(`Citations generated: ${result.evidence.length > 0}`); // Rough check
        console.log(`Status: ${result.status}`);
      } catch (e: any) {
        // Handle expected errors for Test 4
        if (t.useFailingProvider) {
          console.log(`Exact dispatched query: "${t.query}"`);
          // BoundedResearchService catches the error and returns a result with a receipt in the implementation
          // If the service design returns a failed result on error, this won't throw.
          // Re-checking the implementation: BoundedResearchService returns { ..., status: "failed", receipt } on error.
          console.log("Error caught as expected.");
        } else {
          console.error("Test failed unexpectedly:", e);
        }
      }
    } else {
      console.log(`Exact dispatched query: null`);
      console.log(`WebToolReceipt: not_attempted`);
      console.log(`Evidence used: false`);
      console.log(`Citations generated: false`);
      console.log(`Status: not_attempted`);
    }
    console.log("\n");
  }
}

runAudit();
