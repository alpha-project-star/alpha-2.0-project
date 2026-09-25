/**
 * Canonical Presentation Normalization Layer for Alpha 2.0.
 *
 * Pipeline: NormalizedChatResponse.finalText -> normalizePresentation() -> MessageContent
 *
 * Normalizes Markdown, math delimiters, callouts, code fences, diagrams, tables,
 * and list structures so all supported models (OpenAI, Groq, OpenRouter, Ollama)
 * render with uniform Alpha presentation semantics.
 */

export type CalloutType = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "ERROR" | "SUCCESS";

export interface TextSegment {
  type: "text";
  content: string;
}

export interface CodeSegment {
  type: "code";
  fenceChar: "`" | "~";
  fenceLen: number;
  lang: string;
  content: string;
  closed: boolean;
}

export type Segment = TextSegment | CodeSegment;

/**
 * Divides input Markdown into alternating text segments and code fence segments.
 * Supports both backtick (```) and tilde (~~~) fences.
 */
export function segmentMarkdown(input: string): Segment[] {
  const lines = input.split("\n");
  const segments: Segment[] = [];
  let currentTextLines: string[] = [];
  let inCode = false;
  let codeFenceChar = "";
  let codeFenceLen = 0;
  let codeLang = "";
  let currentCodeLines: string[] = [];

  const flushText = () => {
    if (currentTextLines.length > 0) {
      segments.push({ type: "text", content: currentTextLines.join("\n") });
      currentTextLines = [];
    }
  };

  const flushCode = (closed: boolean) => {
    segments.push({
      type: "code",
      fenceChar: (codeFenceChar || "`") as "`" | "~",
      fenceLen: codeFenceLen || 3,
      lang: codeLang,
      content: currentCodeLines.join("\n"),
      closed,
    });
    currentCodeLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);

    if (!inCode) {
      if (fenceMatch) {
        flushText();
        inCode = true;
        codeFenceChar = fenceMatch[2][0];
        codeFenceLen = fenceMatch[2].length;
        codeLang = fenceMatch[3].trim();
        currentCodeLines = [line];
      } else {
        currentTextLines.push(line);
      }
    } else {
      currentCodeLines.push(line);
      if (fenceMatch) {
        const char = fenceMatch[2][0];
        const len = fenceMatch[2].length;
        if (char === codeFenceChar && len >= codeFenceLen) {
          inCode = false;
          flushCode(true);
        }
      }
    }
  }

  if (inCode) {
    flushCode(false);
  } else {
    flushText();
  }

  return segments;
}

/**
 * Normalizes raw model response text into canonical Alpha presentation structure.
 * Preserves all substantive meaning while repairing malformed formatting.
 */
export function normalizePresentation(input: string): string {
  if (!input) return "";

  const segments = segmentMarkdown(input);
  const normalizedSegments: string[] = [];

  for (const seg of segments) {
    if (seg.type === "code") {
      let codeText = seg.content;
      if (!seg.closed) {
        // Auto-close unclosed code fence for streaming / truncation safety
        const closeFence = seg.fenceChar.repeat(seg.fenceLen);
        codeText += `\n${closeFence}`;
      }
      normalizedSegments.push(codeText);
    } else {
      let text = seg.content;

      // 1. Normalize LaTeX math delimiters to KaTeX-compatible standard
      text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n$$\n${math.trim()}\n$$\n`);
      text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);

      // Repair unclosed display math in text segment
      const displayMathCount = (text.match(/\$\$/g) || []).length;
      if (displayMathCount % 2 !== 0) {
        text += "\n$$\n";
      }

      // 2. Normalize Callouts / Notices into GFM blockquote callouts (> [!TYPE])
      text = normalizeCallouts(text);

      // 3. Normalize Un-fenced Diagrams & Visual ASCII / Box-Drawing Art
      text = normalizeDiagrams(text);

      // 4. Normalize Tables (Ensure delimiter rows and blank line separation)
      text = normalizeTables(text);

      // 5. Normalize Heading hierarchy (Convert single '# ' to '## ' for Alpha style)
      text = text.replace(/^#\s+(?![#\s])/gm, "## ");

      // 6. Ensure blank lines before lists, blockquotes, and headings for reliable parsing
      text = ensureBlockSpacing(text);

      normalizedSegments.push(text);
    }
  }

  return normalizedSegments.join("\n");
}

/**
 * Normalizes callout notices in text segments into GFM blockquote syntax (> [!NOTE], > [!WARNING], etc.)
 */
function normalizeCallouts(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match blockquotes with informal notice headers e.g. > **Note:** or > Note:
    const bqMatch = line.match(/^>\s*(?:\*\*)?(Note|Tip|Important|Warning|Error|Caution|Success|Alert)\b(?:\*\*)?:\s*(.*)$/i);
    if (bqMatch) {
      const type = mapCalloutType(bqMatch[1]);
      const content = bqMatch[2].replace(/^\*\*\s*/, "").trim();
      result.push(`> [!${type}]`);
      if (content) {
        result.push(`> ${content}`);
      }
      continue;
    }

    // Match standalone bold headers e.g. **Note:** ... or **Warning:** ... at line start
    const boldMatch = line.match(/^(?:\*\*)?(Note|Tip|Important|Warning|Error|Caution|Success|Alert)\b(?:\*\*)?:\s*(.*)$/i);
    const isIsolatedNotice = boldMatch && (i === 0 || lines[i - 1].trim() === "");
    if (isIsolatedNotice && boldMatch) {
      const type = mapCalloutType(boldMatch[1]);
      const content = boldMatch[2].trim();
      result.push(`> [!${type}]`);
      if (content) {
        result.push(`> ${content}`);
      }
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

function mapCalloutType(raw: string): CalloutType {
  const u = raw.toUpperCase();
  if (u.includes("WARN") || u.includes("CAUTION")) return "WARNING";
  if (u.includes("ERR") || u.includes("ALERT")) return "ERROR";
  if (u.includes("TIP")) return "TIP";
  if (u.includes("IMPORT")) return "IMPORTANT";
  if (u.includes("SUCC")) return "SUCCESS";
  return "NOTE";
}

/**
 * Detects un-fenced multi-line ASCII art, box drawing, or structured flowcharts and wraps them in ```diagram fences.
 * Does NOT wrap single lines or ordinary prose containing arrows ("A -> B").
 */
function normalizeDiagrams(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let diagramBuffer: string[] = [];

  const isStrongDiagramLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed.length < 3) return false;
    // Box drawing characters
    if (/[┌┐└┘├┤┬┴┼│─═║╔╗╚╝╠╣╦╩╬▲▼►◄▶◀]/.test(trimmed)) return true;
    // Flowchart box or ASCII connector shapes e.g. +---+ or +===+
    if (/^\+[-=]+\+$|^\|.*\|$/.test(trimmed) && trimmed.includes("-")) return true;
    if (/(?:\|-->|\+-->|\+==>|\|==>)/.test(trimmed)) return true;
    return false;
  };

  const flushDiagram = () => {
    if (diagramBuffer.length > 0) {
      if (diagramBuffer.length >= 2) {
        result.push("```diagram");
        result.push(...diagramBuffer);
        result.push("```");
      } else {
        result.push(...diagramBuffer);
      }
      diagramBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isStrongDiagramLine(line)) {
      diagramBuffer.push(line);
    } else {
      flushDiagram();
      result.push(line);
    }
  }

  flushDiagram();
  return result.join("\n");
}

/**
 * Ensures Markdown tables are validly formatted with header separators and surrounding blank lines.
 * Requires at least 2 consecutive pipe-delimited lines before treating as a table.
 */
function normalizeTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isPipeLine = (l: string) => {
      const t = l.trim();
      return t.startsWith("|") && t.endsWith("|") && t.split("|").length >= 3;
    };

    if (isPipeLine(line)) {
      const tableBlock: string[] = [];
      let j = i;
      while (j < lines.length && isPipeLine(lines[j])) {
        tableBlock.push(lines[j]);
        j++;
      }

      if (tableBlock.length >= 2) {
        if (result.length > 0 && result[result.length - 1].trim() !== "") {
          result.push("");
        }

        const hasSeparator = tableBlock.some((l) =>
          /^\|(?:\s*:?-+:?\s*\|)+$/.test(l.trim())
        );

        if (hasSeparator) {
          result.push(...tableBlock);
        } else {
          const header = tableBlock[0];
          const colCount = header.split("|").length - 2;
          const sepRow = "|" + Array(colCount).fill("---").join("|") + "|";
          result.push(header, sepRow, ...tableBlock.slice(1));
        }

        i = j;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

/**
 * Ensures adequate blank lines before block-level elements for stable Markdown rendering.
 */
function ensureBlockSpacing(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const isHeader = /^#{1,6}\s+/.test(line);
    const isCallout = /^>\s*\[!/.test(line);

    const prevLine = result.length > 0 ? result[result.length - 1] : "";
    const prevIsEmpty = prevLine.trim() === "";

    if ((isHeader || isCallout) && !prevIsEmpty && result.length > 0) {
      result.push("");
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Backwards-compatible alias for fence repair.
 */
export function repairUnclosedFences(text: string): string {
  const segments = segmentMarkdown(text);
  const result: string[] = [];

  for (const seg of segments) {
    if (seg.type === "code") {
      let codeText = seg.content;
      if (!seg.closed) {
        const closeFence = seg.fenceChar.repeat(seg.fenceLen);
        codeText += `\n${closeFence}`;
      }
      result.push(codeText);
    } else {
      result.push(seg.content);
    }
  }

  return result.join("\n");
}
