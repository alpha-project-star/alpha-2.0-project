/**
 * Speech sanitizer: turns Alpha's *written* answer (markdown + LaTeX + tables)
 * into natural language for TTS. The display pipeline is untouched — this is a
 * separate presentation layer.
 *
 * Rules:
 *  - remove presentation syntax (headings, bold/italic markers, list bullets,
 *    table pipes, code fences, action tags, raw URLs, emoji)
 *  - preserve meaning (negative numbers, "minus", percentages, × as times,
 *    ordinary dollar amounts)
 */

import { stripLeakedThinking } from "./openai-compat";

const MATH_DISPLAY = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
const MATH_INLINE = /\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;

/** Does this `$...$` span actually look like math (rather than "$5 to $9")? */
function looksLikeMath(s: string): boolean {
  if (/^\s*[\d.,]+\s*$/.test(s)) return false; // "$5" style money
  return /[\\^_={}]|\\frac|\\sqrt|[a-zA-Z]\s*[+\-*/=]/.test(s);
}

function speakTable(block: string): string {
  const rows = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const cells = (line: string) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const isSep = (line: string) => /^\|?[\s:-]+\|[\s|:-]*$/.test(line);
  const header = rows[0] && !isSep(rows[0]) ? cells(rows[0]) : [];
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (isSep(rows[i])) continue;
    if (i === 0 && header.length) continue;
    const c = cells(rows[i]);
    if (!c.length) continue;
    const parts = c
      .map((v, j) => {
        const cleanVal = v.replace(/^[-–—]$/, "").trim();
        if (!cleanVal) return "";
        return header[j] ? `${header[j]}: ${cleanVal}` : cleanVal;
      })
      .filter(Boolean);
    if (parts.length) out.push(parts.join(", "));
  }
  if (!out.length) return "";
  if (out.length > 5) {
    return `${out.slice(0, 4).join(". ")}. And ${out.length - 4} more rows in the table.`;
  }
  return out.join(". ") + ".";
}

export function normalizeForSpeech(input: string): string {
  let s = input || "";
  s = stripLeakedThinking(s);

  // 1. Internal syntax: Remove action tags, code blocks, raw URLs, and emojis.
  s = s.replace(/\[\[[\s\S]*?\]\]/g, " ");
  s = s.replace(/```[\s\S]*?```/g, " code block. ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " code block. ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, " ");

  // 2. Math → spoken math.
  s = s.replace(MATH_DISPLAY, (_m, a, b) => " " + latexToSpeech(a || b || "") + " ");
  s = s.replace(MATH_INLINE, (m, a, b) => {
    const body = a ?? b ?? "";
    if (a !== undefined && !looksLikeMath(a)) return m;
    return " " + latexToSpeech(body) + " ";
  });

  // 3. Tables → row-wise natural reading.
  s = s.replace(/(?:^\|.*\|[ \t]*\n?)+/gm, (block) => " " + speakTable(block) + " ");

  // 4. Remove presentation markers: headings, bullets, table pipes, blockquotes, horizontal rules.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, " ");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\|/gm, "");

  // 5. Sources / metadata footers: Strip strictly.
  s = s.replace(/\*\*Sources:?\*\*[\s\S]*$/i, " ");
  s = s.replace(/_No web sources[^.]*\./gi, " ");
  s = s.replace(/^\s*(?:✅|❌|⚠️)\s*/gm, "");

  // 6. Emphasis markers — pairs only.
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, "$1$2");
  s = s.replace(/(^|\s)__([^_]+)__/g, "$1$2");
  s = s.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1$2");

  // 7. Semantic symbols → words.
  s = s.replace(/(\d)\s*%/g, "$1 percent");
  s = s.replace(/%/g, " percent ");
  s = s.replace(/×/g, " times ");
  s = s.replace(/÷/g, " divided by ");
  s = s.replace(/(^|[\s(])-(\d)/g, "$1minus $2");
  s = s.replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2");
  s = s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars");
  s = s.replace(/(\d)\s*°C/gi, "$1 degrees Celsius");
  s = s.replace(/(\d)\s*°F/gi, "$1 degrees Fahrenheit");
  s = s.replace(/[|•▪●※]+/g, ", ");
  s = s.replace(/[#*_`~]/g, "");

  // 8. Clean up whitespace: preserve paragraph/sentence breaks.
  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, ". ");
  s = s.replace(/\s+([.,;:!?])/g, "$1").replace(/(?:\.\s*){2,}/g, ". ");
  return s.replace(/\s+/g, " ").trim();
}

function latexToSpeech(tex: string): string {
  let t = tex;
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, " ($1) over ($2) ");
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, " square root of ($1) ");
  t = t.replace(/\^\{([^{}]+)\}/g, " to the power of ($1) ");
  t = t.replace(/\^(\d+)/g, (_m, n) =>
    n === "2" ? " squared " : n === "3" ? " cubed " : ` to the ${n} `,
  );
  t = t.replace(/_\{([^{}]+)\}/g, " sub ($1) ");
  t = t.replace(/_(\w)/g, " sub $1 ");
  const greek = [
    "pi",
    "theta",
    "alpha",
    "beta",
    "gamma",
    "delta",
    "lambda",
    "mu",
    "sigma",
    "omega",
    "phi",
  ];
  for (const g of greek) t = t.replace(new RegExp(`\\\\${g}`, "g"), ` ${g} `);
  t = t.replace(/\\sum/g, " sum ");
  t = t.replace(/\\prod/g, " product ");
  t = t.replace(/\\int/g, " integral ");
  t = t.replace(/\\infty/g, " infinity ");
  t = t.replace(/\\cdot|\\times/g, " times ");
  t = t.replace(/\\div/g, " divided by ");
  t = t.replace(/\\pm/g, " plus or minus ");
  t = t.replace(/\\leq/g, " less than or equal to ");
  t = t.replace(/\\geq/g, " greater than or equal to ");
  t = t.replace(/\\neq/g, " not equal to ");
  t = t.replace(/\\approx/g, " approximately ");
  t = t.replace(/\\begin\{[a-z*]+\}|\\end\{[a-z*]+\}/g, " ");
  t = t.replace(/\\\\/g, " ; ");
  t = t.replace(/[{}\\]/g, " ");
  t = t.replace(/=/g, " equals ");
  t = t.replace(/(^|[\s(])-(\s*[\d.a-z(])/gi, "$1minus $2");
  t = t.replace(/\+/g, " plus ");
  t = t.replace(/-/g, " minus ");
  t = t.replace(/\*/g, " times ");
  t = t.replace(/\//g, " over ");
  return t.replace(/\s+/g, " ").trim();
}
