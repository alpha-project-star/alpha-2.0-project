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

export interface GitHubSourceFileItem {
  path: string;
  size?: number;
  content?: string;
  truncated?: boolean;
}

export interface GitHubInspectionResult {
  success: boolean;
  errorType?: "not_found" | "inaccessible" | "rate_limited" | "network_error" | "invalid_url" | "unknown";
  errorReason?: string;
  repo?: GitHubRepoInfo;
  files?: GitHubFileItem[];
  sourceFiles?: GitHubSourceFileItem[];
  fileContent?: string;
  commits?: GitHubCommitItem[];
  inspectionScope?: "full" | "bounded" | "subpath";
  isTruncated?: boolean;
  truncationReason?: string;
  totalFilesDiscovered?: number;
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

const RELEVANT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".css", ".scss", ".less", ".html",
  ".md", ".mdx", ".yaml", ".yml", ".toml",
  ".env.example", ".gitignore", ".editorconfig",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".cs", ".php", ".rb", ".swift", ".kt", ".sh",
  ".sql", ".graphql", ".gql", ".prisma"
]);

const RELEVANT_EXACT_NAMES = new Set([
  "dockerfile", "makefile", "readme", "readme.md", "package.json",
  "tsconfig.json", "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs", "cargo.toml",
  ".env", ".env.example", ".env.local", ".env.template",
  ".gitignore", ".editorconfig", ".eslintrc", ".prettierrc"
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".mov", ".avi", ".webm",
  ".lock", ".sqlite", ".db"
]);

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next",
  ".output", "coverage", "vendor", ".yarn", ".pnpm-store",
  ".cache", ".turbo"
]);

function isIgnoredPath(filePath: string): boolean {
  const parts = filePath.split("/");
  return parts.some((p) => IGNORED_DIRS.has(p));
}

function isRelevantSourceFile(filePath: string): boolean {
  if (isIgnoredPath(filePath)) return false;
  const fileName = filePath.split("/").pop()?.toLowerCase() || "";
  if (RELEVANT_EXACT_NAMES.has(fileName)) return true;
  if (fileName.startsWith(".env")) return true;

  for (const binExt of BINARY_EXTENSIONS) {
    if (fileName.endsWith(binExt)) return false;
  }

  for (const relExt of RELEVANT_EXTENSIONS) {
    if (fileName.endsWith(relExt)) return true;
  }

  return false;
}

async function fetchSingleFileText(owner: string, repo: string, filePath: string, maxBytes: number = 20000): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${filePath}`;
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.type !== "file") return null;

    let contentStr = "";
    if (json.content && json.encoding === "base64") {
      try {
        contentStr = atob(json.content.replace(/\n/g, ""));
      } catch {
        contentStr = json.content;
      }
    } else if (json.download_url) {
      const rawRes = await fetch(json.download_url);
      if (rawRes.ok) {
        contentStr = await rawRes.text();
      }
    }

    if (!contentStr) return null;

    if (contentStr.length > maxBytes) {
      return { text: contentStr.substring(0, maxBytes) + "\n... [File content truncated due to size]", truncated: true };
    }
    return { text: contentStr, truncated: false };
  } catch {
    return null;
  }
}

async function recursiveEnumerateFiles(
  owner: string,
  repo: string,
  currentPath: string = "",
  depth: number = 0,
  maxDepth: number = 3,
  collected: GitHubFileItem[] = []
): Promise<GitHubFileItem[]> {
  if (depth > maxDepth || collected.length >= 100) return collected;
  try {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${currentPath}`;
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) return collected;
    const json = await res.json();
    if (!Array.isArray(json)) return collected;

    for (const item of json) {
      if (isIgnoredPath(item.path || item.name)) continue;
      const fileItem: GitHubFileItem = {
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        downloadUrl: item.download_url,
        htmlUrl: item.html_url,
      };
      collected.push(fileItem);
      if (item.type === "dir" && depth < maxDepth && collected.length < 100) {
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
    let files: GitHubFileItem[] = [];
    const sourceFiles: GitHubSourceFileItem[] = [];
    let fileContent: string | undefined;
    let inspectionScope: "full" | "bounded" | "subpath" = "full";
    let isTruncated = false;
    let truncationReason: string | undefined;
    let totalFilesDiscovered = 0;

    if (cleanPath) {
      // Subpath-specific inspection
      inspectionScope = "subpath";
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
          totalFilesDiscovered = files.length;
          // Fetch top source files in subpath
          const candidateSourcePaths = files.filter(f => f.type === "file" && isRelevantSourceFile(f.path)).slice(0, 5);
          for (const candidate of candidateSourcePaths) {
            const fetched = await fetchSingleFileText(owner, repo, candidate.path, 15000);
            if (fetched) {
              sourceFiles.push({
                path: candidate.path,
                size: candidate.size,
                content: fetched.text,
                truncated: fetched.truncated,
              });
            }
          }
        } else if (contentsJson && contentsJson.type === "file") {
          const fetched = await fetchSingleFileText(owner, repo, cleanPath, 25000);
          if (fetched) {
            fileContent = fetched.text;
            sourceFiles.push({
              path: cleanPath,
              size: contentsJson.size,
              content: fetched.text,
              truncated: fetched.truncated,
            });
          }
        }
      }
    } else {
      // Systematic Repository-Wide Inspection using Git Trees API
      const defaultBranch = repoInfo.defaultBranch;
      const treeUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
      const treeRes = await fetch(treeUrl, { headers: getHeaders() });

      if (treeRes.ok) {
        const treeJson = await treeRes.json();
        const rawTree: any[] = Array.isArray(treeJson.tree) ? treeJson.tree : [];
        const isTreeTruncated = Boolean(treeJson.truncated);

        // Filter ignored paths
        const validItems = rawTree.filter((item) => !isIgnoredPath(item.path));
        totalFilesDiscovered = validItems.length;

        files = validItems.slice(0, 150).map((item) => ({
          name: item.path.split("/").pop() || item.path,
          path: item.path,
          type: item.type === "tree" ? "dir" : "file",
          size: item.size,
          htmlUrl: `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${item.path}`,
        }));

        // Identify key source files to retrieve contents for
        const candidateSourcePaths = validItems
          .filter((item) => item.type === "blob" && isRelevantSourceFile(item.path) && (!item.size || item.size <= 30000))
          .sort((a, b) => {
            // Prioritize root configs and entry points
            const nameA = a.path.toLowerCase();
            const nameB = b.path.toLowerCase();
            if (nameA === "package.json" || nameA === "readme.md") return -1;
            if (nameB === "package.json" || nameB === "readme.md") return 1;
            if (nameA.startsWith("src/app.") || nameA.startsWith("src/index.")) return -1;
            if (nameB.startsWith("src/app.") || nameB.startsWith("src/index.")) return 1;
            return (a.size || 0) - (b.size || 0);
          });

        let totalContentBytes = 0;
        const maxTotalBytes = 100000; // 100KB character budget for model context
        const maxSourceFiles = 12;

        for (const candidate of candidateSourcePaths) {
          if (sourceFiles.length >= maxSourceFiles || totalContentBytes >= maxTotalBytes) break;
          const fetched = await fetchSingleFileText(owner, repo, candidate.path, 15000);
          if (fetched) {
            sourceFiles.push({
              path: candidate.path,
              size: candidate.size,
              content: fetched.text,
              truncated: fetched.truncated,
            });
            totalContentBytes += fetched.text.length;
          }
        }

        if (isTreeTruncated || validItems.length > 150 || candidateSourcePaths.length > sourceFiles.length) {
          inspectionScope = "bounded";
          isTruncated = true;
          truncationReason = `Inspection bounded to top ${sourceFiles.length} key source file contents (${Math.round(totalContentBytes / 1024)}KB) out of ${totalFilesDiscovered} total files discovered in repository tree.`;
        } else {
          inspectionScope = "full";
          isTruncated = false;
        }
      } else {
        // Fallback: Recursive Contents API Enumeration
        files = await recursiveEnumerateFiles(owner, repo, "", 0, 3, []);
        totalFilesDiscovered = files.length;
        const candidateSourcePaths = files.filter(f => f.type === "file" && isRelevantSourceFile(f.path)).slice(0, 8);
        for (const candidate of candidateSourcePaths) {
          const fetched = await fetchSingleFileText(owner, repo, candidate.path, 15000);
          if (fetched) {
            sourceFiles.push({
              path: candidate.path,
              size: candidate.size,
              content: fetched.text,
              truncated: fetched.truncated,
            });
          }
        }
        inspectionScope = "bounded";
        isTruncated = true;
        truncationReason = `Fallback directory enumeration bounded to ${files.length} files and ${sourceFiles.length} key source file contents.`;
      }
    }

    // Fetch commit history
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
      sourceFiles,
      fileContent,
      commits,
      inspectionScope,
      isTruncated,
      truncationReason,
      totalFilesDiscovered,
    };
  } catch (err: any) {
    return {
      success: false,
      errorType: "network_error",
      errorReason: `Network error connecting to GitHub API: ${err?.message || String(err)}`,
    };
  }
}
