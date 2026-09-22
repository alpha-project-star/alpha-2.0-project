/**
 * Server-only GitHub Repository Inspection Module (.server.ts)
 * GITHUB_TOKEN is accessed strictly server-side and never reaches the browser.
 */

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  stars: number;
  forks: number;
  language: string | null;
  htmlUrl: string;
}

export interface GitHubFileItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
  downloadUrl?: string | null;
  htmlUrl?: string;
}

export interface GitHubCommitItem {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface GitHubInspectionResult {
  success: boolean;
  errorType?: "not_found" | "inaccessible" | "rate_limited" | "network_error" | "invalid_url" | "unknown";
  errorReason?: string;
  repo?: GitHubRepoInfo;
  files?: GitHubFileItem[];
  fileContent?: string;
  commits?: GitHubCommitItem[];
}

export function parseGitHubRepoInput(input: string): { owner: string; repo: string } | null {
  const cleaned = (input || "").trim().replace(/\.git\/?$/, "");
  const matchUrl = cleaned.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (matchUrl) {
    return { owner: matchUrl[1], repo: matchUrl[2] };
  }
  const matchShort = cleaned.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (matchShort) {
    return { owner: matchShort[1], repo: matchShort[2] };
  }
  return null;
}

const GITHUB_API_BASE = "https://api.github.com";

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Alpha-AI-Agent",
  };
  const token = typeof process !== "undefined" && process.env?.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

async function recursiveEnumerateFiles(
  owner: string,
  repo: string,
  currentPath: string = "",
  depth: number = 0,
  maxDepth: number = 2,
  collected: GitHubFileItem[] = []
): Promise<GitHubFileItem[]> {
  if (depth > maxDepth || collected.length > 150) return collected;
  try {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${currentPath}`;
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return collected;
    const json = await res.json();
    if (!Array.isArray(json)) return collected;

    for (const item of json) {
      if (item.name === ".git" || item.name === "node_modules" || item.name === "dist" || item.name === "build" || item.name === ".next") {
        continue;
      }
      const fileItem: GitHubFileItem = {
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        downloadUrl: item.download_url,
        htmlUrl: item.html_url,
      };
      collected.push(fileItem);
      if (item.type === "dir" && depth < maxDepth) {
        await recursiveEnumerateFiles(owner, repo, item.path, depth + 1, maxDepth, collected);
      }
    }
  } catch {}
  return collected;
}

export async function inspectGitHubRepository(inputUrlOrSlug: string, subpath: string = ""): Promise<GitHubInspectionResult> {
  const parsed = parseGitHubRepoInput(inputUrlOrSlug);
  if (!parsed) {
    return { success: false, errorType: "invalid_url", errorReason: `Could not parse valid GitHub repository from: "${inputUrlOrSlug}"` };
  }

  const { owner, repo } = parsed;

  try {
    const repoRes = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
      headers: getHeaders(),
    });

    if (repoRes.status === 404) {
      return { success: false, errorType: "not_found", errorReason: `GitHub repository '${owner}/${repo}' was not found (404).` };
    }
    if (repoRes.status === 403 || repoRes.status === 429) {
      return { success: false, errorType: "rate_limited", errorReason: `GitHub API rate limit exceeded or access forbidden (HTTP ${repoRes.status}).` };
    }
    if (!repoRes.ok) {
      return { success: false, errorType: "inaccessible", errorReason: `GitHub repository inaccessible or private (HTTP ${repoRes.status}).` };
    }

    const repoJson = await repoRes.json();
    const repoInfo: GitHubRepoInfo = {
      owner,
      repo,
      fullName: repoJson.full_name || `${owner}/${repo}`,
      description: repoJson.description || null,
      defaultBranch: repoJson.default_branch || "main",
      stars: repoJson.stargazers_count || 0,
      forks: repoJson.forks_count || 0,
      language: repoJson.language || null,
      htmlUrl: repoJson.html_url || `https://github.com/${owner}/${repo}`,
    };

    const cleanPath = (subpath || "").replace(/^\/+/, "");
    let files: GitHubFileItem[] | undefined;
    let fileContent: string | undefined;

    if (cleanPath) {
      // Fetch specific subpath (file or directory)
      const contentsUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}`;
      const contentsRes = await fetch(contentsUrl, { headers: getHeaders() });

      if (contentsRes.ok) {
        const contentsJson = await contentsRes.json();
        if (Array.isArray(contentsJson)) {
          files = contentsJson.map((item: any) => ({
            name: item.name,
            path: item.path,
            type: item.type,
            size: item.size,
            downloadUrl: item.download_url,
            htmlUrl: item.html_url,
          }));
        } else if (contentsJson && contentsJson.type === "file") {
          if (contentsJson.download_url) {
            const fileRes = await fetch(contentsJson.download_url);
            if (fileRes.ok) {
              fileContent = await fileRes.text();
            }
          } else if (contentsJson.content && contentsJson.encoding === "base64") {
            try {
              fileContent = atob(contentsJson.content.replace(/\n/g, ""));
            } catch {
              fileContent = contentsJson.content;
            }
          }
        }
      }
    } else {
      // Systematic recursive repository traversal (depth up to 2)
      files = await recursiveEnumerateFiles(owner, repo, "", 0, 2, []);
    }

    const commitsRes = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?per_page=5`, { headers: getHeaders() });
    let commits: GitHubCommitItem[] = [];
    if (commitsRes.ok) {
      const commitsJson = await commitsRes.json();
      if (Array.isArray(commitsJson)) {
        commits = commitsJson.map((c: any) => ({
          sha: c.sha?.substring(0, 7) || "",
          message: c.commit?.message?.split("\n")[0] || "",
          author: c.commit?.author?.name || c.author?.login || "Unknown",
          date: c.commit?.author?.date || "",
          url: c.html_url || "",
        }));
      }
    }

    return {
      success: true,
      repo: repoInfo,
      files,
      fileContent,
      commits,
    };
  } catch (err: any) {
    return {
      success: false,
      errorType: "network_error",
      errorReason: `Network error connecting to GitHub API: ${err?.message || String(err)}`,
    };
  }
}
