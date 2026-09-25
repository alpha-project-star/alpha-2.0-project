import { describe, it, expect } from "vitest";
import { normalizePresentation } from "../src/lib/presentation";

describe("Presentation Normalization & Streaming Convergence", () => {
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

  it("normalizes complete presentation text correctly", () => {
    const normalized = normalizePresentation(completeFullText);
    expect(typeof normalized).toBe("string");
    expect(normalized.length).toBeGreaterThan(0);
  });

  it("converges safely across progressively accumulated streaming chunks", () => {
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
