import { BoundedResearchService } from "../src/lib/research";
import { DuckDuckGoProvider } from "../src/lib/search-providers";
import { extractArticleLinks } from "../src/lib/research-utils";

async function testPipeline() {
  const provider = new DuckDuckGoProvider();
  const service = new BoundedResearchService(provider);
  const query = "What are today's Zimbabwe headlines?";
  
  console.log(`--- Starting Pipeline Test for: "${query}" ---`);

  // Step 1 & 2: Run Research
  // This internally calls provider.search() (with ranking) and handles 2-pass fetching
  const research = await service.research(query);

  // Step 3: Diagnostic Output
  console.log("\n--- 1. Discovery Results (with Ranking Scores) ---");
  research.results.forEach((r, i) => {
    // Note: BoundedResearchService adds score via rankResults
    console.log(`${i+1}. Title: ${r.title} | URL: ${r.url} | Score: ${(r as any).score}`);
  });

  console.log("\n--- 2. Final Evidence Fetched ---");
  research.evidence.forEach((e, i) => {
    console.log(`${i+1}. Title: ${e.title} | URL: ${e.url} | Status: ${e.status}`);
  });

  // Step 4: Verification of Final Context
  // We need to re-generate the final string context to check for leakage
  // As per fetchLiveWebContext in alpha.functions.ts
  const lines = [
    `Context for: "${query}".`,
    `---`,
    `Sources:`,
  ];
  research.results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title} (${r.source}) - ${r.url}`);
  });
  
  if (research.evidence.length > 0) {
    lines.push(`---`, `Verified content details:`);
    research.evidence.forEach((e, i) => {
      lines.push(`[${i + 1}] ${e.title}: ${e.excerpt ? e.excerpt.slice(0, 100) : "No content"}`);
    });
  }

  const finalContext = lines.join("\n");
  console.log("\n--- 3. Final Clean Research Context (User-facing model context) ---");
  console.log(finalContext);
  console.log("\n--- End of Context Check ---");
}

testPipeline();
