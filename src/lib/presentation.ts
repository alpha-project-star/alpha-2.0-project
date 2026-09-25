/**
 * Canonical Presentation Normalization Layer for Alpha 2.0.
 *
 * Pipeline: NormalizedChatResponse.finalText -> normalizePresentation() -> MessageContent
 *
 * Normalizes Markdown, math delimiters, callouts, code fences, diagrams, tables,
 * and list structures so all supported models (OpenAI, Groq, OpenRouter, Ollama)
 * render with uniform Alpha presentation semantics.
 */

/** Supported callout types */
export type CalloutType = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "ERROR" | "SUCCESS";

/**
 * Normalizes raw model response text into canonical Alpha presentation structure.
 * Preserves all substantive meaning while repairing malformed formatting.
 */
export function normalizePresentation(input: string): string {
  if (!input) return "";

  let text = input;

  // 1. Normalize LaTeX math delimiters to KaTeX-compatible standard
  // Convert \[ ... \] -> $$ ... $$ and \( ... \) -> $ ... $
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n$$\n${math.trim()}\n$$\n`);
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);

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

  // 7. Repair Unclosed Code Fences & Display Math (Resilience for streaming & truncation)
  text = repairUnclosedFences(text);

  return text;
}

/**
 * Normalizes callout notices into GFM blockquote syntax (> [!NOTE], > [!WARNING], etc.)
 */
function normalizeCallouts(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      inCode = !inCode;
      result.push(line);
      continue;
    }

    if (inCode) {
      result.push(line);
      continue;
    }

    // Match blockquotes with informal notice headers e.g. > **Note:** or > Note:
    const bqMatch = line.match(/^>\s*(?:\*\*)?(Note|Tip|Important|Warning|Error|Caution|Success|Alert)(?:\*\*)?:\s*(.*)$/i);
    if (bqMatch) {
      const type = mapCalloutType(bqMatch[1]);
      const content = bqMatch[2].trim();
      result.push(`> [!${type}]`);
      if (content) {
        result.push(`> ${content}`);
      }
      continue;
    }

    // Match standalone bold headers e.g. **Note:** ... or **Warning:** ... at line start
    const boldMatch = line.match(/^(?:\*\*)?(Note|Tip|Important|Warning|Error|Caution|Success|Alert)(?:\*\*)?:\s*(.*)$/i);
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
 * Detects un-fenced ASCII art, box drawing, or arrow flowcharts and wraps them in ```diagram fences
 */
function normalizeDiagrams(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCode = false;
  let diagramBuffer: string[] = [];

  const DIAGRAM_CHARS = /[┌┐└┘├┤┬┴┼│─═║╔╗╚╝╠╣╦╩╬▲▼►◄▶◀]|(?:-->|==>|->|<-|<==|\|-->|\+--\+|\+==\+)/;

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

    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      flushDiagram();
      inCode = !inCode;
      result.push(line);
      continue;
    }

    if (inCode) {
      result.push(line);
      continue;
    }

    const isDiagramLine = DIAGRAM_CHARS.test(line) && line.trim().length > 3;

    if (isDiagramLine) {
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
 * Ensures Markdown tables are validly formatted with header separators and surrounding blank lines
 */
function normalizeTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      inCode = !inCode;
      result.push(line);
      continue;
    }

    if (inCode) {
      result.push(line);
      continue;
    }

    const isTableLine = line.trim().startsWith("|") && line.trim().endsWith("|");

    if (isTableLine) {
      // Ensure blank line before table if previous line was non-empty non-table text
      if (result.length > 0 && result[result.length - 1].trim() !== "" && !result[result.length - 1].trim().startsWith("|")) {
        result.push("");
      }

      result.push(line);

      // If this is header line and next line is not a separator, insert delimiter row
      const isNextSeparator = i + 1 < lines.length && /^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[i + 1].trim());
      const isSeparator = /^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim());

      if (!isSeparator && !isNextSeparator && i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) {
        // Count columns in header
        const colCount = line.split("|").length - 2;
        if (colCount > 0) {
          const sepRow = "|" + Array(colCount).fill("---").join("|") + "|";
          result.push(sepRow);
        }
      }
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Ensures adequate blank lines before block-level elements for stable Markdown rendering
 */
function ensureBlockSpacing(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      inCode = !inCode;
      result.push(line);
      continue;
    }

    if (inCode) {
      result.push(line);
      continue;
    }

    const isHeader = /^#{1,6}\s+/.test(line);
    const isListStart = /^[*+-]\s+/.test(line) || /^\d+\.\s+/.test(line);
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
 * Repairs unclosed code fences and math blocks caused by streaming or truncation
 */
function repairUnclosedFences(text: string): string {
  // Count fences
  const fenceMatches = text.match(/^```/gm);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    text += "\n```\n";
  }

  // Count display math
  const mathMatches = text.match(/\$\$/g);
  if (mathMatches && mathMatches.length % 2 !== 0) {
    text += "\n$$\n";
  }

  return text;
}
