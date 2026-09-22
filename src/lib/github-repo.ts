/**
 * GitHub Repository Inspection Tool for Alpha
 * Supports:
 * - URL normalization (stripping trailing .git, extracting owner/repo from github.com URLs)
 * - Public repository metadata retrieval
 * - Directory / file enumeration
 * - Fetching source file content
 * - Commit history inspection
 * - Robust error handling (not-found, rate-limit, network failure)
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

/**
 * Normalize a GitHub URL or owner/repo string into { owner, repo }
 */
export function parseGitHubRepoInput(input: string): { owner: string; repo: string } | null {
  const cleaned = input.trim().replace(/\.git\/?$/, "");
  // Matches github.com/owner/repo or owner/repo
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
  // If a server-side or public token is available in env (without exposing client secrets), use it
  const token = typeof process !== "undefined" && process.env?.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

export async function inspectGitHubRepository(inputUrlOrSlug: string, subpath: string = ""): Promise<GitHubInspectionResult> {
  const parsed = parseGitHubRepoInput(inputUrlOrSlug);
  if (!parsed) {
    return { success: false, errorType: "invalid_url", errorReason: `Could not parse valid GitHub repository from: "${inputUrlOrSlug}"` };
  }

  const { owner, repo } = parsed;

  try {
    // 1. Fetch repository metadata
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
      return { success: false, errorType: "inaccessible", errorReason: `GitHub repository inaccessible (HTTP ${repoRes.status}).` };
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

    // 2. If subpath points to a file or directory, fetch contents
    const cleanPath = subpath.replace(/^\/+/, "");
    const contentsUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}`;
    const contentsRes = await fetch(contentsUrl, { headers: getHeaders() });

    let files: GitHubFileItem[] | undefined;
    let fileContent: string | undefined;

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
        // It's a file
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

    // 3. Fetch recent commits
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
