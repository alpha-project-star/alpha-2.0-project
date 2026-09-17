import { BoundedResearchService } from "../src/lib/research";
import { SearchProvider, SearchResult } from "../src/lib/web-search";
import { extractArticleLinks } from "../src/lib/research-utils";

// Mock Provider for deterministic testing
class MockProvider implements SearchProvider {
  async search(query: string, limit = 5): Promise<SearchResult[]> {
    return [
      { title: "Landing Page", url: "https://site.com/home", snippet: "Home page", source: "D" },
      { title: "News Index", url: "https://site.com/news/index", snippet: "All news", source: "D" }
    ];
  }
  async readPage(url: string): Promise<{ title: string; content: string; status: string }> {
    if (url === "https://site.com/home") {
      return { title: "Home", content: "Go to [News](/news/1) or [Sports](/sports/2)", status: "success" };
    }
    if (url === "https://site.com/news/index") {
      return { title: "News", content: "Read [Article 1](/news/art1) and [Article 2](/news/art2)", status: "success" };
    }
    if (url.includes("/news/")) {
      return { title: "Article", content: "This is article content for " + url, status: "success" };
    }
    return { title: "", content: "", status: "failed" };
  }
}

async function testPipeline() {
  const provider = new MockProvider();
  const service = new BoundedResearchService(provider);
  const query = "Test query";
  
  console.log("--- Starting Fixture-based Pipeline Test ---");
  const research = await service.research(query);

  console.log("\nEvidence fetched count:", research.evidence.length);
  research.evidence.forEach(e => console.log(`- ${e.title} (${e.url})`));
  
  const hasLeakage = /LIVE WEB SEARCH|EVIDENCE:|RETRIEVED EVIDENCE/i.test(JSON.stringify(research));
  console.log("\nLeakage detected:", hasLeakage);
}

testPipeline();
