export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

export function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  
  return results.map(r => {
    let score = 0;
    const title = (r.title || "").toLowerCase();
    const url = (r.url || "").toLowerCase();
    
    // Positive signals
    for (const term of queryTerms) {
      if (title.includes(term)) score += 3;
      if (url.includes(term)) score += 2;
    }
    if (/\/(news|article|post|story|analysis)\//.test(url)) score += 5;
    if (r.date) score += 2;
    
    // Negative signals
    const negative = ["index", "category", "portal", "login", "dashboard", "home"];
    for (const neg of negative) {
      if (url.includes(neg) || title.includes(neg)) score -= 4;
    }
    
    return { ...r, score };
  }).sort((a, b) => b.score - a.score);
}

export function scoreCandidateLink(url: string, query: string): number {
  let score = 0;
  const lowerUrl = url.toLowerCase();
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  // Positive signals
  for (const term of queryTerms) {
    if (lowerUrl.includes(term)) score += 2;
  }

  const positivePatterns = [
    "/article/", "/news/", "/stories/", "/research/", "/paper/",
    "/publication/", "/report/", "/docs/", "/documentation/", "/api/",
    "/product/", "/products/", "/specs/", "/data/", "/dataset/",
    "/law/", "/policy/", "/document/"
  ];
  for (const pattern of positivePatterns) {
    if (lowerUrl.includes(pattern)) score += 5;
  }

  // Negative signals
  const negativePatterns = [
    "/login", "/signup", "/search", "/tag", "/category",
    "/author", "/account", "/share", "/index"
  ];
  for (const neg of negativePatterns) {
    if (lowerUrl.includes(neg)) score -= 5;
  }

  // Penalty for homepage or root path
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname === "/" || urlObj.pathname === "") {
      score -= 5;
    }
  } catch (e) {
    // If not a valid URL, heavily penalize
    score -= 10;
  }

  return score;
}
