import { SearchProvider, SearchResult } from "./web-search";

export class DuckDuckGoProvider implements SearchProvider {
  private combineSignal(timeoutMs: number, userSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!userSignal) return timeoutSignal;
    if (typeof (AbortSignal as any).any === "function") {
      return (AbortSignal as any).any([userSignal, timeoutSignal]);
    }
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (userSignal.aborted || timeoutSignal.aborted) {
      ctrl.abort();
    } else {
      userSignal.addEventListener("abort", onAbort, { once: true });
      timeoutSignal.addEventListener("abort", onAbort, { once: true });
    }
    return ctrl.signal;
  }

  async search(query: string, limit = 5, opts?: { signal?: AbortSignal }): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    try {
      const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;
      const readableUrl = `https://r.jina.ai/${ddgUrl}`;
      const signal = this.combineSignal(8000, opts?.signal);

      const text = await fetch(readableUrl, {
        headers: { "X-No-Cache": "true", "User-Agent": "Mozilla/5.0" },
        signal,
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

  async readPage(url: string, opts?: { signal?: AbortSignal }): Promise<{ title: string; content: string; status: string }> {
    try {
      const readableUrl = `https://r.jina.ai/${url}`;
      const signal = this.combineSignal(10000, opts?.signal);
      const text = await fetch(readableUrl, {
        headers: { "X-No-Cache": "true", "User-Agent": "Mozilla/5.0" },
        signal,
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
