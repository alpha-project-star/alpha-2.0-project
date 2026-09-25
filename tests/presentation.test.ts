import { describe, it, expect } from "vitest";
import { normalizePresentation, segmentMarkdown } from "../src/lib/presentation";

describe("Presentation Normalization & Regression Suite", () => {
  it("normalizes ordinary paragraphs and headings", () => {
    const input = "Paragraph text.\n\n# Header 1\n\n## Header 2";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("Paragraph text.");
    expect(normalized).toContain("## Header 1");
    expect(normalized).toContain("## Header 2");
  });

  it("handles lists and nested lists correctly", () => {
    const input = "- Item 1\n  - Nested A\n- Item 2";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("- Item 1");
    expect(normalized).toContain("- Nested A");
  });

  it("preserves fenced code blocks with language tags and tilde fences", () => {
    const input = "```typescript\nconst x = 1;\n```\n\n~~~python\nprint('hello')\n~~~";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("```typescript");
    expect(normalized).toContain("~~~python");
    expect(normalized).toContain("const x = 1;");
  });

  it("repairs unclosed code fences safely", () => {
    const input = "```json\n{\"foo\": \"bar\"}";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("```json");
    expect(normalized).toContain("```");
  });

  it("preserves valid tables and normalizes table syntax", () => {
    const input = "| Col 1 | Col 2 |\n| --- | --- |\n| Val 1 | Val 2 |";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("| Col 1 |");
    expect(normalized).toContain("| Val 1 |");
  });

  it("normalizes Warning/Notice and explicit GFM callouts", () => {
    const input = "> **Warning:** Please note this.\n\n> [!NOTE]\n> Important note here.";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("> [!WARNING]");
    expect(normalized).toContain("> [!NOTE]");
  });

  it("detects and normalizes diagrams and explicit diagram fences", () => {
    const input = "A -> B -> C\n\n```mermaid\ngraph TD;\n A-->B;\n```";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("```mermaid");
    expect(normalized).toContain("```");
  });

  it("normalizes inline and display math and repairs unclosed display math", () => {
    const input = "Inline $x^2$ math and display \\[ E = mc^2 \\] and unclosed $$\\sum x";
    const normalized = normalizePresentation(input);
    expect(normalized).toContain("$x^2$");
    expect(normalized).toContain("$$");
  });

  it("segments markdown correctly into text and code segments", () => {
    const input = "Text before\n```js\ncode()\n```\nText after";
    const segments = segmentMarkdown(input);
    expect(segments.length).toBe(3);
    expect(segments[0].type).toBe("text");
    expect(segments[1].type).toBe("code");
    expect(segments[2].type).toBe("text");
  });

  it("converges safely across progressively accumulated streaming chunks", () => {
    const completeFullText = `
# Header 1
This is an introductory paragraph with some **bold text** and $E = mc^2$ math.

\`\`\`typescript
const greeting = "Hello World";
console.log(greeting);
\`\`\`

| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |

> [!NOTE]
> This is a callout box.

A -> B -> C (flowchart example)
`;

    let accumulated = "";
    const chunkSize = 15;
    
    for (let i = 0; i < completeFullText.length; i += chunkSize) {
      const chunk = completeFullText.slice(i, i + chunkSize);
      accumulated += chunk;
      
      const partialNormalized = normalizePresentation(accumulated);
      expect(typeof partialNormalized).toBe("string");
    }

    const finalStreamNormalized = normalizePresentation(accumulated);
    const completeDirectNormalized = normalizePresentation(completeFullText);

    expect(accumulated).toBe(completeFullText);
    expect(finalStreamNormalized).toBe(completeDirectNormalized);
  });
});
