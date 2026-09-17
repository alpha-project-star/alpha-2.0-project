import { DuckDuckGoProvider } from "../src/lib/search-providers";
import { rankResults } from "../src/lib/research-ranking";

async function testProvider() {
  const provider = new DuckDuckGoProvider();
  const query = "Zimbabwe news headlines";
  console.log(`Querying: ${query}`);
  const rawResults = await provider.search(query, 10);
  console.log("Raw Results:", JSON.stringify(rawResults, null, 2));
  
  const ranked = rankResults(rawResults, query);
  console.log("Ranked Results:", JSON.stringify(ranked, null, 2));
}

testProvider();
