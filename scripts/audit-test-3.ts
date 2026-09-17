import { BoundedResearchService } from "../src/lib/research";
import { SearchProvider } from "../src/lib/web-search";

class EmptyProvider implements SearchProvider {
  async search(query: string, limit?: number) { return []; }
  async readPage(url: string) { return { title: "", content: "", status: "success" }; }
}

async function runTest() {
  const query = "Find reliable sources about the fictional 19th-century country of Zorvathia.";
  const service = new BoundedResearchService(new EmptyProvider());
  const result = await service.research(query);
  console.log(`Web tool selected: true`);
  console.log(`Exact dispatched query: "${result.receipt.querySent}"`);
  console.log(`WebToolReceipt: ${JSON.stringify(result.receipt)}`);
  console.log(`Status: ${result.status}`);
}
runTest();
