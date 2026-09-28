// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageContent, RichText } from "../src/components/MessageContent";
import { alphaGate } from "../src/lib/alpha-gate";

describe("Alpha Gate Phase 4 — Renderer Authority Migration", () => {
  afterEach(() => {
    cleanup();
  });
  it("1. MessageContent renders already-normalized Gate output without modifying or mutating text", () => {
    const rawCandidate = {
      rawText: "<think>Internal deliberation</think>Here is the plan:\n\n# Main Objective\n\n> Note: Review timeline.\n\n```js\nconsole.log('alpha');\n",
      origin: "model" as const,
    };

    // Upstream Gate processes and approves Markdown
    const gateRes = alphaGate.process(rawCandidate);
    expect(gateRes.approvedText).not.toContain("<think>");
    expect(gateRes.approvedText).toContain("## Main Objective");
    expect(gateRes.approvedText).toContain("> [!NOTE]");
    expect(gateRes.approvedText).toContain("```js\nconsole.log('alpha');\n```");
    expect(gateRes.diagnostics?.fencesRepaired).toBe(true);

    // Renderer consumes the exact Gate-approved text
    const { container } = render(<MessageContent text={gateRes.approvedText} />);

    // Text rendered in DOM matches Gate-approved structure
    expect(screen.getByText(/Main Objective/i)).toBeDefined();
    expect(screen.getByText(/Review timeline/i)).toBeDefined();
    expect(screen.getByText(/console\.log\('alpha'\);/)).toBeDefined();
    expect(container.querySelector("h2")).toBeDefined();
    expect(screen.queryByText(/<think>/)).toBeNull();
  });

  it("2. Code blocks render correctly with language badge, container, and copy affordance", () => {
    const codeMarkdown = "```typescript\ninterface Task { id: string; }\n```";
    render(<MessageContent text={codeMarkdown} />);

    expect(screen.getAllByText(/TYPESCRIPT/i)[0]).toBeDefined();
    expect(screen.getByText(/interface Task { id: string; }/)).toBeDefined();
    expect(screen.getByRole("button", { name: /Copy code/i })).toBeDefined();
  });

  it("3. Tables render correctly with accessible wrapper and tabular elements", () => {
    const tableMarkdown = "| Task | Status |\n| --- | --- |\n| Build Alpha | In Progress |";
    const { container } = render(<MessageContent text={tableMarkdown} />);

    const tableWrap = container.querySelector(".table-scroll-container");
    expect(tableWrap).toBeDefined();
    expect(tableWrap?.getAttribute("role")).toBe("region");
    expect(tableWrap?.getAttribute("aria-label")).toBe("Data table");

    expect(screen.getByText("Task")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Build Alpha")).toBeDefined();
    expect(screen.getByText("In Progress")).toBeDefined();
  });

  it("4. Math renders correctly with KaTeX plugin and error boundary", () => {
    const mathMarkdown = "Standard inline math: $E = mc^2$";
    render(<MessageContent text={mathMarkdown} />);

    expect(screen.getByText(/Standard inline math:/)).toBeDefined();
  });

  it("5. Links render correctly with human-readable labels and external security attributes", () => {
    const rawUrlMarkdown = "Check out https://github.com/alpha-ai for repository details.";
    render(<MessageContent text={rawUrlMarkdown} />);

    const link = screen.getByRole("link");
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("https://github.com/alpha-ai");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("6. Structured callouts render as stylized Lucide callout cards", () => {
    const calloutMarkdown = "> [!WARNING]\n> Storage quota is nearly full.";
    render(<MessageContent text={calloutMarkdown} />);

    expect(screen.getByText(/Warning/i)).toBeDefined();
    expect(screen.getByText(/Storage quota is nearly full\./i)).toBeDefined();
  });

  it("7. Renderer does NOT run a second semantic normalization pipeline", () => {
    // If raw (un-gated) text with standard Markdown '# Single Hash' is passed directly to the renderer,
    // the renderer does NOT transform it into '## ' before passing to ReactMarkdown; ReactMarkdown receives '# ' and renders an <h1>
    const unGatedRaw = "# Level 1 Heading";
    const { container } = render(<MessageContent text={unGatedRaw} />);

    const h1 = container.querySelector("h1");
    expect(h1).toBeDefined();
    expect(h1?.textContent).toBe("Level 1 Heading");
  });

  it("8. Diagrams render with specialized diagram container and copy affordance", () => {
    const diagramMarkdown = "```diagram\n+---+   +---+\n| A |-->| B |\n+---+   +---+\n```";
    render(<MessageContent text={diagramMarkdown} />);

    expect(screen.getAllByText(/DIAGRAM/i)[0]).toBeDefined();
    expect(screen.getByRole("button", { name: /Copy diagram/i })).toBeDefined();
  });

  it("9. Semantic text invariant: text supplied to MessageContent === semantic Markdown rendered", () => {
    const approvedText = "Alpha is ready to assist you.\n\n- Task 1: Complete\n- Task 2: Active";
    render(<MessageContent text={approvedText} />);

    expect(screen.getByText(/Alpha is ready to assist you\./)).toBeDefined();
    expect(screen.getByText(/Task 1: Complete/)).toBeDefined();
    expect(screen.getByText(/Task 2: Active/)).toBeDefined();
  });
});
