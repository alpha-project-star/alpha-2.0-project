import { BoundedResearchService } from "../src/lib/research";
import { DuckDuckGoProvider } from "../src/lib/search-providers";

async function runDiagnostic() {
  const provider = new DuckDuckGoProvider();
  const service = new BoundedResearchService(provider);
  
  // Custom wrapper to log the pipeline execution
  const query = "What are today's Zimbabwe headlines?";
  console.log(`--- Starting Live Diagnostic for: "${query}" ---`);

  // 1. Exact query plan
  console.log("Query Plan: Searching DuckDuckGo for Zimbabwe headlines.");
  
  // Execute research (this triggers the 2-pass traversal)
  // We need to instrument the service or analyze its state.
  // Since I can't easily instrument the existing service without changing it,
  // I will add log statements inside it temporarily.
  
  const research = await service.research(query);

  console.log("\n--- Diagnostic Report ---");
  console.log("1. Evidence count:", research.evidence.length);
  research.evidence.forEach((e, i) => {
    console.log(`${i+1}. Title: ${e.title} | URL: ${e.url} | Status: ${e.status}`);
  });

  console.log("\n--- Final Context for Model ---");
  // Log the final context logic from alpha.functions.ts equivalent
  const lines = research.evidence.map((e, i) => `[${i + 1}] ${e.title} (URL: ${e.url}, Publisher: ${e.publisher || 'Unknown'}, Retrieved: ${e.retrievedAt}): ${e.excerpt}`);
  console.log(lines.join("\n"));
}

runDiagnostic();
