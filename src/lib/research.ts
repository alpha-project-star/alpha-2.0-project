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
}

export interface NewsArticle {
  headline: string;
  publisher: string;
  url: string;
  publishedDate?: string;
  summary: string;
}

export interface ResearchResult {
  query: string;
  results: SearchResult[];
  articles: NewsArticle[];
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

export function isHomepageOrPortalUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    if (!path || path === "" || path === "/" || path === "/index.html" || path === "/index.php" || path === "/home" || path === "/homepage") {
      return true;
    }
    const genericSections = new Set([
      "/news", "/world", "/us", "/uk", "/politics", "/business",
      "/tech", "/technology", "/sport", "/sports", "/opinion", "/entertainment",
      "/lifestyle", "/science", "/health", "/culture", "/features", "/markets"
    ]);
    if (genericSections.has(path)) {
      return true;
    }
  } catch {}
  return false;
}

export function isGenericPortalHeadline(headline: string, publisher?: string): boolean {
  const normHead = (headline || "").trim().toLowerCase();
  const normPub = (publisher || "").trim().toLowerCase();

  if (!normHead || normHead.length < 12) {
    return true;
  }

  const knownPublishers = [
    "bbc", "bbc news", "reuters", "cnn", "associated press", "ap news", "ap",
    "the guardian", "the new york times", "new york times", "nytimes",
    "the washington post", "washington post", "wall street journal", "wsj",
    "bloomberg", "fox news", "nbc news", "abc news", "cbs news", "npr",
    "al jazeera", "usa today", "time", "newsweek", "forbes", "cnbc",
    "the times", "the telegraph", "the independent", "sky news", "financial times", "ft",
    "google news", "yahoo news", "msn news", "bing news", "duckduckgo", "web source"
  ];

  for (const pub of knownPublishers) {
    if (normHead === pub || normHead === `${pub} - home` || normHead === `${pub} homepage` || normHead === `${pub} online`) {
      return true;
    }
  }

  if (normPub && (normHead === normPub || normHead === `${normPub} - home` || normHead === `${normPub} homepage`)) {
    return true;
  }

  const genericHeadlineRegexes = [
    /^(?:home|homepage|latest\s+news|top\s+stories|breaking\s+news|news\s+headlines|world\s+news|today's\s+news|daily\s+news|international\s+news|front\s+page)$/i,
    /^(?:bbc\s+news|reuters|cnn|fox\s+news|ap\s+news|the\s+guardian|the\s+new\s+york\s+times|nytimes|the\s+washington\s+post|nbc\s+news|abc\s+news|cbs\s+news)\s*[-|–—:]\s*(?:breaking\s+news|world\s+news|latest\s+news|top\s+stories|news,\s*sport|videos?|home|international\s+news|us\s+news)/i,
    /breaking\s+news,\s*latest\s+news\s+and\s+videos/i,
    /breaking\s+international\s+news\s+&\s+views/i,
    /latest\s+breaking\s+news,\s+headlines\s+&\s+top\s+stories/i,
    /news,\s*sport\s+and\s+opinion\s+from\s+the\s+guardian/i,
    /trusted\s+world\s+and\s+financial\s+news/i,
    /read\s+the\s+latest\s+stories\s+from/i,
  ];

  for (const rgx of genericHeadlineRegexes) {
    if (rgx.test(normHead)) return true;
  }

  return false;
}

export function isValidArticle(article: NewsArticle): boolean {
  if (!article || !article.headline || !article.url) return false;
  if (isHomepageOrPortalUrl(article.url)) return false;
  if (isGenericPortalHeadline(article.headline, article.publisher)) return false;
  
  const words = article.headline.trim().split(/\s+/);
  if (words.length < 3) return false;

  return true;
}

export function parseStructuredArticle(
  title: string,
  url: string,
  snippet: string,
  fallbackPublisher?: string,
  fallbackDate?: string,
): NewsArticle | null {
  let headline = (title || "").trim();
  let publisher = (fallbackPublisher || "").trim();

  // Extract publisher from "Headline - Publisher" or "Headline | Publisher" or "Headline — Publisher"
  const splitMatch = headline.match(/^(.+?)\s+[-|–—]\s+([^-|–—]+)$/);
  if (splitMatch && splitMatch[2].length < 40) {
    headline = splitMatch[1].trim();
    if (!publisher || publisher === "Unknown" || publisher === "Web Source") {
      publisher = splitMatch[2].trim();
    }
  }

  // Extract publisher from "Publisher: Headline" prefix
  const prefixMatch = headline.match(/^([A-Z][A-Za-z0-9\s.&]{2,25}):\s+(.+)$/);
  if (prefixMatch && prefixMatch[1].length < 25) {
    if (!publisher || publisher === "Unknown" || publisher === "Web Source") {
      publisher = prefixMatch[1].trim();
    }
    headline = prefixMatch[2].trim();
  }

  if (!publisher || publisher === "Unknown") {
    try {
      publisher = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      publisher = "Web Source";
    }
  }

  // Extract date from snippet prefix (e.g. "2 hours ago - ...", "March 20, 2026 ...")
  let publishedDate = fallbackDate;
  let summary = (snippet || "").trim();
  const dateMatch = summary.match(/^([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d+\s+(?:hours?|mins?|minutes?|days?|weeks?)\s+ago)\s*[-–—:]\s*(.*)$/i);
  if (dateMatch) {
    publishedDate = dateMatch[1].trim();
    summary = dateMatch[2].trim();
  }

  const article: NewsArticle = {
    headline,
    publisher,
    url: url.trim(),
    publishedDate: publishedDate?.trim() || undefined,
    summary,
  };

  if (!isValidArticle(article)) {
    return null;
  }

  return article;
}

export class BoundedResearchService {
  private provider: SearchProvider;
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
      receipt.querySent = query;
      const rawResults = await this.provider.search(query, 10);
      results = rankResults(rawResults, query);
      receipt.resultCount = results.length;
      if (results.length === 0) {
        receipt.status = "empty";
        return { query, results: [], articles: [], evidence: [], status: "failed", receipt };
      }
      receipt.status = "usable";
    } catch {
      receipt.status = "error";
      receipt.errorClass = "provider_unavailable";
      return { query, results: [], articles: [], evidence: [], status: "failed", receipt };
    }

    const evidence: ResearchResult["evidence"] = [];
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
        const extracted = extractRelevantEvidence(page.content, query);
        if (extracted && extracted.trim().length > 30) {
          let publisher = "Unknown";
          try {
            publisher = new URL(result.url).hostname.replace(/^www\./, "");
          } catch {}
          evidence.push({
            url: result.url,
            title: page.title || result.title,
            excerpt: extracted,
            status: "page-read-success",
            publisher,
            publishedDate: result.date,
            retrievedAt: new Date().toISOString(),
          });
        }

        // If it's a landing page (has many article links), extract them for deeper reading
        const links = extractArticleLinks(page.content, result.url);
        if (links.length > 2) {
          const scoredLinks = links
            .filter((link) => !processedUrls.has(link))
            .map((link) => ({ link, score: scoreCandidateLink(link, query) }))
            .sort((a, b) => b.score - a.score);

          for (const { link } of scoredLinks) {
            if (articleLinks.length >= 5) break;
            if (scoreCandidateLink(link, query) >= 0) {
              articleLinks.push(link);
              processedUrls.add(link);
            }
          }
        }
      } else {
        // Full page read failed — fallback immediately to the search snippet
        if (result.snippet && result.snippet.trim().length > 15) {
          let publisher = "Unknown";
          try {
            publisher = new URL(result.url).hostname.replace(/^www\./, "");
          } catch {}
          evidence.push({
            url: result.url,
            title: result.title,
            excerpt: result.snippet,
            status: "snippet-evidence",
            publisher: result.source || publisher,
            publishedDate: result.date,
            retrievedAt: new Date().toISOString(),
          });
        }
      }
    }

    // Pass 2: Fetch specific candidate articles if we need more depth
    if (evidence.length < 3 && articleLinks.length > 0) {
      for (const link of articleLinks) {
        if (openedPages >= 8) break;
        activity.set("reading_article");
        const page = await this.provider.readPage(link);
        openedPages++;
        if (page.status === "success") {
          const extracted = extractRelevantEvidence(page.content, query);
          if (extracted && extracted.trim().length > 30) {
            let publisher = "Unknown";
            try {
              publisher = new URL(link).hostname.replace(/^www\./, "");
            } catch {}
            evidence.push({
              url: link,
              title: page.title,
              excerpt: extracted,
              status: "page-read-success",
              publisher,
              retrievedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    // Pass 3 (Guarantee): If evidence is still empty, populate from search snippets
    if (evidence.length === 0) {
      for (const r of results) {
        if (r.snippet && r.snippet.trim().length > 10) {
          let publisher = "Unknown";
          try {
            publisher = new URL(r.url).hostname.replace(/^www\./, "");
          } catch {}
          evidence.push({
            url: r.url,
            title: r.title,
            excerpt: r.snippet,
            status: "snippet-fallback",
            publisher: r.source || publisher,
            publishedDate: r.date,
            retrievedAt: new Date().toISOString(),
          });
        }
      }
    }

    // Extract structured articles as first-class output
    const articles: NewsArticle[] = [];
    const seenUrls = new Set<string>();

    for (const ev of evidence) {
      if (!seenUrls.has(ev.url)) {
        seenUrls.add(ev.url);
        const art = parseStructuredArticle(
          ev.title,
          ev.url,
          ev.excerpt,
          ev.publisher,
          ev.publishedDate,
        );
        if (art) {
          articles.push(art);
        }
      }
    }

    for (const r of results) {
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        const art = parseStructuredArticle(
          r.title,
          r.url,
          r.snippet,
          r.source,
          r.date,
        );
        if (art) {
          articles.push(art);
        }
      }
    }

    receipt.openedCount = openedPages;

    return {
      query,
      results,
      articles,
      evidence,
      status: evidence.length > 0 || results.length > 0 ? "success" : "insufficient",
      receipt,
    };
  }
}
