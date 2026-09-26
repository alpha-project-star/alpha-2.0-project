/**
 * Public Encyclopedia & Research Knowledge Lookup Tool
 * Uses free public REST APIs (Wikipedia and arXiv) with zero API keys required.
 */

export interface KnowledgeResult {
  success: boolean;
  source: "wikipedia" | "arxiv";
  title?: string;
  summary?: string;
  url?: string;
  results?: Array<{
    title: string;
    summary: string;
    url: string;
    authors?: string[];
    published?: string;
  }>;
  error?: string;
}

export async function lookupWikipedia(topic: string): Promise<KnowledgeResult> {
  const query = (topic || "").trim();
  if (!query) {
    return { success: false, source: "wikipedia", error: "Topic query must not be empty." };
  }

  try {
    const formattedTitle = encodeURIComponent(query.replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${formattedTitle}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Alpha-Assistant/2.0 (knowledge-tool)" },
      signal: AbortSignal.timeout(6000),
    });

    if (res.status === 404) {
      // Try search API if direct summary is not found
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(6000) });
      if (searchRes.ok) {
        const searchJson = await searchRes.json();
        const firstHit = searchJson.query?.search?.[0];
        if (firstHit && firstHit.title) {
          return await lookupWikipedia(firstHit.title);
        }
      }
      return { success: false, source: "wikipedia", error: `No Wikipedia article found for "${query}".` };
    }

    if (!res.ok) {
      return { success: false, source: "wikipedia", error: `Wikipedia API responded with status ${res.status}.` };
    }

    const data = await res.json();
    return {
      success: true,
      source: "wikipedia",
      title: data.title,
      summary: data.extract || data.description || "No extract available.",
      url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${formattedTitle}`,
    };
  } catch (err: any) {
    return {
      success: false,
      source: "wikipedia",
      error: `Failed to fetch knowledge from Wikipedia: ${err?.message || String(err)}`,
    };
  }
}

export async function lookupArxiv(topic: string): Promise<KnowledgeResult> {
  const query = (topic || "").trim();
  if (!query) {
    return { success: false, source: "arxiv", error: "Search query must not be empty." };
  }

  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return { success: false, source: "arxiv", error: `arXiv API responded with status ${res.status}.` };
    }

    const text = await res.text();
    // Parse entries from XML/Atom feed cleanly
    const entryMatches = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    if (entryMatches.length === 0) {
      return { success: false, source: "arxiv", error: `No scientific papers found on arXiv for "${query}".` };
    }

    const results = entryMatches.map((entryXml) => {
      const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
      const idMatch = entryXml.match(/<id>([\s\S]*?)<\/id>/);
      const publishedMatch = entryXml.match(/<published>([\s\S]*?)<\/published>/);

      const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "Untitled";
      const summary = summaryMatch ? summaryMatch[1].replace(/\s+/g, " ").trim() : "No abstract available.";
      const link = idMatch ? idMatch[1].trim() : "https://arxiv.org";
      const published = publishedMatch ? publishedMatch[1].trim() : undefined;

      return {
        title,
        summary,
        url: link,
        published,
      };
    });

    return {
      success: true,
      source: "arxiv",
      results,
    };
  } catch (err: any) {
    return {
      success: false,
      source: "arxiv",
      error: `Failed to query arXiv: ${err?.message || String(err)}`,
    };
  }
}
