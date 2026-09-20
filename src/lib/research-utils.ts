export function extractRelevantEvidence(content: string, query: string, budget: number = 4000): string {
  if (content.length <= budget) return content;

  // 1. Keep the start (summary/intro)
  const headSize = Math.min(budget / 4, 1000);
  const head = content.slice(0, headSize);

  // 2. Score paragraphs
  const paragraphs = content.split(/\n\n+|\r\n\r\n+/);
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const isNewsQuery = /news|headline|breaking|today|latest|current|update|report|world|politics|market/i.test(query);

  const boilerplateRegex = /cookie|privacy\s+policy|terms\s+of\s+(?:use|service)|sign\s+in|subscribe|advertisement|copyright\s+©/i;

  const scored = paragraphs.map((p) => {
    let score = 0;
    const trimmed = p.trim();
    if (trimmed.length < 25 || boilerplateRegex.test(trimmed)) {
      return { p, score: -10 };
    }

    const lowerP = trimmed.toLowerCase();
    for (const term of queryTerms) {
      if (lowerP.includes(term)) score += 2;
    }

    // Boost paragraphs with headings (#) or list items (-)
    if (trimmed.startsWith("#") || trimmed.startsWith("- ") || trimmed.startsWith("* ")) score += 3;

    // For news queries or general informative paragraphs, boost substantive text
    if (isNewsQuery && trimmed.length > 40 && trimmed.length < 500) {
      score += 2;
    }

    return { p, score };
  });

  // 3. Select top paragraphs
  scored.sort((a, b) => b.score - a.score);

  let result = head;
  let remainingBudget = budget - head.length;

  for (const { p, score } of scored) {
    if (score >= 0 && p.length < remainingBudget) {
      result += "\n\n" + p;
      remainingBudget -= p.length + 2;
    }
    if (remainingBudget < 200) break;
  }

  return result;
}

export function extractArticleLinks(content: string, baseUrl: string): string[] {
  const links: string[] = [];
  
  // Markdown links: [text](url)
  const mdRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  // HTML links: <a href="url">
  const htmlRegex = /href="([^"]+)"/g;
  
  let m;
  while ((m = mdRegex.exec(content)) !== null) {
    let url = m[2];
    if (!url.startsWith('http')) {
       url = new URL(url, baseUrl).toString();
    }
    links.push(url);
  }
  
  while ((m = htmlRegex.exec(content)) !== null) {
    let url = m[1];
    if (!url.startsWith('http')) {
       url = new URL(url, baseUrl).toString();
    }
    links.push(url);
  }

  // Deduplicate and return all found links
  return [...new Set(links)];
}
