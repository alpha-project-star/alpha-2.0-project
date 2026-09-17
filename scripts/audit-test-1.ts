import { BoundedResearchService } from "../src/lib/research";
import { DuckDuckGoProvider } from "../src/lib/search-providers";
import { decideSearch } from "../src/lib/web-search";

async function runTest() {
  const query = "What are the latest major news developments in Zimbabwe today? Search the web and provide the sources.";
  const decision = decideSearch(query);
  console.log(`Web tool selected: ${decision.search}`);
  const service = new BoundedResearchService(new DuckDuckGoProvider());
  const result = await service.research(decision.query || query);
  console.log(`Exact dispatched query: "${result.receipt.querySent}"`);
  console.log(`WebToolReceipt: ${JSON.stringify(result.receipt)}`);
  console.log(`Status: ${result.status}`);
}
runTest();
