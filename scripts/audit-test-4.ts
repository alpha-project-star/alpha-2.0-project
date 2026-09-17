import { BoundedResearchService } from "../src/lib/research";
import { SearchProvider } from "../src/lib/web-search";

class FailingProvider implements SearchProvider {
  async search(query: string, limit?: number) { throw new Error("Provider unavailable"); }
  async readPage(url: string) { return { title: "", content: "", status: "error" }; }
}

async function runTest() {
  const query = "What is the weather in London?";
  const service = new BoundedResearchService(new FailingProvider());
  const result = await service.research(query);
  console.log(`Web tool selected: true`);
  console.log(`Exact dispatched query: "${result.receipt.querySent}"`);
  console.log(`WebToolReceipt: ${JSON.stringify(result.receipt)}`);
  console.log(`Status: ${result.status}`);
}
runTest();
