import { DuckDuckGoProvider } from "./search-providers";
import { SearchResult, SearchProvider } from "./web-search";
import { activity } from "./activity";
import { extractRelevantEvidence, extractArticleLinks } from "./research-utils";
import { rankResults, scoreCandidateLink } from "./research-ranking";

export interface WebToolReceipt {
  toolSelected: boolean;
  querySent: string | null;
  status: "usable" | "empty" | "error" | "not_attempted";
  resultCount: number;
  openedCount: number;
  errorClass:
    | null
    | "permission_denied"
    | "provider_unavailable"
    | "transport_error"
    | "malformed_response"
    | "unknown";
};

export interface ResearchResult {
  query: string;
  results: SearchResult[];
  evidence: {
    url: string;
    title: string;
    excerpt: string;
    status: string;
    publisher?: string;
    publishedDate?: string;
    retrievedAt: string;
  }[];
  status: "success" | "insufficient" | "failed";
  receipt: WebToolReceipt;
}

export class BoundedResearchService {
  private provider: SearchProvider;
  private maxSearches = 1;
  private maxPages = 5;

  constructor(provider: SearchProvider = new DuckDuckGoProvider()) {
    this.provider = provider;
  }

  async research(query: string): Promise<ResearchResult> {
    const receipt: WebToolReceipt = {
      toolSelected: true,
      querySent: null,
      status: "not_attempted",
      resultCount: 0,
      openedCount: 0,
      errorClass: null,
    };

    activity.set("searching");
    let results: SearchResult[] = [];
    try {
      receipt.querySent = query; // confirmed dispatched here
      const rawResults = await this.provider.search(query, 10);
      results = rankResults(rawResults, query);
      receipt.resultCount = results.length;
      if (results.length === 0) {
        receipt.status = "empty";
        return { query, results: [], evidence: [], status: "failed", receipt };
      }
      receipt.status = "usable";
    } catch (e) {
      receipt.status = "error";
      receipt.errorClass = "provider_unavailable";
      return { query, results: [], evidence: [], status: "failed", receipt };
    }

    const evidence = [];
    let openedPages = 0;
    
    const articleLinks: string[] = [];
    const processedUrls = new Set<string>();

    // Pass 1: Fetch and identify
    for (const result of results) {
      if (openedPages >= this.maxPages) {
        break;
      }
      
      const page = await this.provider.readPage(result.url);
      openedPages++;
      processedUrls.add(result.url);

      if (page.status === "success") {
        // If it's a landing page (has many article links), extract them
        const links = extractArticleLinks(page.content, result.url);
        
        if (links.length > 2) {
            // It's a landing page! Add links to candidates
            const scoredLinks = links
                .filter(link => !processedUrls.has(link))
                .map(link => ({ link, score: scoreCandidateLink(link, query) }))
                .sort((a, b) => b.score - a.score);
            
            for (const { link } of scoredLinks) {
                if (articleLinks.length >= 5) break;
                // Only take links with positive or neutral scores
                if (scoreCandidateLink(link, query) >= 0) {
                    articleLinks.push(link);
                    processedUrls.add(link);
                }
            }
        } else {
           evidence.push({
             url: result.url,
             title: page.title,
             excerpt: extractRelevantEvidence(page.content, query),
             status: "page-read-success",
             publisher: new URL(result.url).hostname,
             retrievedAt: new Date().toISOString(),
           });
        }
      } else {
        evidence.push({
          url: result.url,
          title: result.title,
          excerpt: "",
          status: "page-read-failed",
          retrievedAt: new Date().toISOString(),
        });
      }
    }

    // Pass 2: Fetch articles
    for (const link of articleLinks) {
       if (openedPages >= this.maxPages) {
         break;
       }
       
       activity.set("reading_article");
       const page = await this.provider.readPage(link);
       openedPages++;
       
       if (page.status === "success") {
        evidence.push({
          url: link,
          title: page.title,
          excerpt: extractRelevantEvidence(page.content, query),
          status: "page-read-success",
          publisher: new URL(link).hostname,
          retrievedAt: new Date().toISOString(),
        });
       }
    }
    receipt.openedCount = openedPages;

    return {
      query,
      results,
      evidence,
      status: evidence.length > 0 ? "success" : "insufficient",
      receipt,
    };
  }
}
