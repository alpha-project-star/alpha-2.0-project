import { describe, it, expect } from "vitest";
import {
  normalizePresentation,
  segmentMarkdown,
  repairUnclosedFences,
} from "../src/lib/presentation";

describe("Presentation Normalization Layer (src/lib/presentation.ts)", () => {
  it("preserves ordinary paragraphs cleanly", () => {
    const input = "This is a simple paragraph explaining how Alpha works.\n\nHere is a second paragraph.";
    const output = normalizePresentation(input);
    expect(output).toBe(input);
  });

  it("normalizes single-hash headings (#) to double-hash (##)", () => {
    const input = "# Main Title\n\nSome text under title.";
    const output = normalizePresentation(input);
    expect(output).toMatch(/^## Main Title/m);
  });

  it("preserves lists and nested lists", () => {
    const input = "- Item 1\n- Item 2\n  - Nested Item A\n  - Nested Item B\n\n1. Step 1\n2. Step 2";
    const output = normalizePresentation(input);
    expect(output).toContain("- Item 1");
    expect(output).toContain("  - Nested Item A");
    expect(output).toContain("1. Step 1");
  });

  it("handles backtick code fences cleanly without modifying internal text", () => {
    const codeContent = "const x = 10;\n// > Note: this is inside code\nconst table = '| a | b |';\nconst arrow = 'A -> B';";
    const input = "Here is code:\n\n```typescript\n" + codeContent + "\n```";
    const output = normalizePresentation(input);

    expect(output).toContain("```typescript\n" + codeContent + "\n```");
    expect(output).not.toContain("> [!NOTE]");
    expect(output).not.toContain("```diagram");
  });

  it("handles tilde code fences cleanly", () => {
    const input = "~~~python\ndef hello():\n    print('Hello World')\n~~~";
    const output = normalizePresentation(input);
    expect(output).toContain("~~~python\ndef hello():\n    print('Hello World')\n~~~");
  });

  it("auto-closes unclosed code fences for streaming safety", () => {
    const input = "Here is streaming code:\n\n```javascript\nconst a = 5;";
    const output = normalizePresentation(input);
    expect(output).toContain("```javascript\nconst a = 5;\n```");
  });

  it("ignores pipe characters in ordinary prose and does NOT mistake them for tables", () => {
    const input = "Please choose between Option A | Option B | Option C in your preferences.";
    const output = normalizePresentation(input);
    expect(output).toBe(input);
    expect(output).not.toContain("|---|");
  });

  it("validates and normalizes Markdown tables with header separators", () => {
    const input = "| Feature | Status |\n| Speed | Fast |\n| Price | Free |";
    const output = normalizePresentation(input);
    expect(output).toContain("| Feature | Status |");
    expect(output).toContain("|---|---|");
    expect(output).toContain("| Speed | Fast |");
  });

  it("preserves validly formatted Markdown tables without duplicating separators", () => {
    const input = "| Header 1 | Header 2 |\n|---|---|\n| Value 1 | Value 2 |";
    const output = normalizePresentation(input);
    expect(output).toBe(input);
  });

  it("normalizes informal callout notices to canonical GFM syntax", () => {
    const input = "> **Warning:** Please review your settings before proceeding.";
    const output = normalizePresentation(input);
    expect(output).toContain("> [!WARNING]");
    expect(output).toContain("> Please review your settings before proceeding.");
  });

  it("preserves explicit GFM callouts (> [!NOTE])", () => {
    const input = "> [!NOTE]\n> This is an important note.";
    const output = normalizePresentation(input);
    expect(output).toContain("> [!NOTE]");
    expect(output).toContain("> This is an important note.");
  });

  it("does NOT turn ordinary prose with arrows ('A -> B') into a diagram", () => {
    const input = "To navigate, go from Screen A -> Screen B -> Settings.";
    const output = normalizePresentation(input);
    expect(output).toBe(input);
    expect(output).not.toContain("```diagram");
  });

  it("promotes multi-line box-drawing art into a ```diagram block", () => {
    const input = "┌─────────┐\n│ Box A   │\n└─────────┘";
    const output = normalizePresentation(input);
    expect(output).toContain("```diagram");
    expect(output).toContain("┌─────────┐");
  });

  it("preserves explicit diagram fences (```diagram, ```ascii, ```mermaid)", () => {
    const input = "```mermaid\ngraph TD\n  A --> B\n```";
    const output = normalizePresentation(input);
    expect(output).toContain("```mermaid\ngraph TD\n  A --> B\n```");
  });

  it("normalizes LaTeX math delimiters \\[...\\] and \\(...\\) to KaTeX standard", () => {
    const input = "The formula is \\(E = mc^2\\) and display is:\n\\[a^2 + b^2 = c^2\\]";
    const output = normalizePresentation(input);
    expect(output).toContain("$E = mc^2$");
    expect(output).toContain("$$\na^2 + b^2 = c^2\n$$");
  });

  it("auto-closes unclosed display math delimiters for streaming safety", () => {
    const input = "Here is a display equation:\n\n$$\nf(x) = x^2";
    const output = normalizePresentation(input);
    expect(output).toContain("$$\nf(x) = x^2\n$$");
  });

  it("segmentMarkdown separates code blocks from text segments accurately", () => {
    const markdown = "Hello\n```\ncode\n```\nWorld";
    const segments = segmentMarkdown(markdown);
    expect(segments.length).toBe(3);
    expect(segments[0].type).toBe("text");
    expect(segments[1].type).toBe("code");
    expect(segments[2].type).toBe("text");
  });
});
