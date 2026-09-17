import { SearchProvider, SearchResult } from "./web-search";

export class DuckDuckGoProvider implements SearchProvider {
  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    try {
      const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;
      const readableUrl = `https://r.jina.ai/${ddgUrl}`;
      const text = await fetch(readableUrl, {
        headers: { "X-No-Cache": "true", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000),
      })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");

      if (text) {
        const regex = /#{1,3}\s+\[([^\]]+)\]\(([^)]+)\)([\s\S]*?)(?=#{1,3}\s+\[|$)/g;
        let m;
        while ((m = regex.exec(text)) !== null && results.length < limit) {
          const title = m[1].trim();
          const rawUrl = m[2].trim();
          const block = m[3] || "";
          const cleanSnippet = block
            .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/https?:\/\/\S+/g, "")
            .replace(/^\s*(?:[\w.-]+\.[a-z]{2,}\S*|\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*/i, "")
            .replace(/\s+/g, " ")
            .trim();
          results.push({
            title,
            url: rawUrl,
            snippet: cleanSnippet.slice(0, 260),
            source: "DuckDuckGo",
          });
        }
      }
    } catch (e) {
      console.error("DDG search failed", e);
    }
    return results;
  }

  async readPage(url: string): Promise<{ title: string; content: string; status: string }> {
    try {
      const readableUrl = `https://r.jina.ai/${url}`;
      const text = await fetch(readableUrl, {
        headers: { "X-No-Cache": "true", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      
      if (!text) return { title: "", content: "", status: "failed" };

      // Basic extraction from Jina text
      const titleMatch = text.match(/^#+\s+(.*)$/m);
      const title = titleMatch ? titleMatch[1] : "Page content";
      return { title, content: text, status: "success" };
    } catch {
      return { title: "", content: "", status: "failed" };
    }
  }
}
