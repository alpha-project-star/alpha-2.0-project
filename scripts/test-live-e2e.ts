import { BoundedResearchService } from "../src/lib/research";
import { DuckDuckGoProvider } from "../src/lib/search-providers";

async function runLiveTest() {
  const service = new BoundedResearchService(new DuckDuckGoProvider());
  const query = "What are the latest major news developments in Zimbabwe today?";
  console.log("Starting live E2E test...");
  try {
    const result = await service.research(query);
    console.log("LIVE_E2E_RECEIPT_START");
    console.log(JSON.stringify(result.receipt, null, 2));
    console.log("LIVE_E2E_RECEIPT_END");
    console.log("LIVE_E2E_STATUS:", result.status);
    console.log("LIVE_E2E_RESULTS_COUNT:", result.results.length);
    console.log("LIVE_E2E_EVIDENCE_COUNT:", result.evidence.length);
  } catch (e) {
    console.error("Live E2E test failed:", e);
  }
}

runLiveTest();
