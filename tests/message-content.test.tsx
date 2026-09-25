// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageContent, RichText } from "../src/components/MessageContent";

describe("MessageContent & RichText Renderer Component", () => {
  it("renders code blocks with language badge and pre container", () => {
    render(<MessageContent text={"```typescript\nconst x = 42;\n```"} />);
    expect(screen.getAllByText(/TYPESCRIPT/i)[0]).toBeDefined();
    expect(screen.getByText(/const x = 42;/)).toBeDefined();
  });

  it("renders diagrams with visual diagram badge", () => {
    render(<MessageContent text={"```diagram\n┌─────┐\n│ Box │\n└─────┘\n```"} />);
    expect(screen.getAllByText(/DIAGRAM/i)[0]).toBeDefined();
    expect(screen.getByText(/Box/)).toBeDefined();
  });

  it("renders callout notices with title badge and body", () => {
    render(<MessageContent text={"> [!WARNING]\n> High latency detected on server."} />);
    expect(screen.getAllByText(/Warning/i)[0]).toBeDefined();
    expect(screen.getByText(/High latency detected on server/i)).toBeDefined();
  });

  it("renders external links with target=_blank and rel=noopener noreferrer", () => {
    render(<MessageContent text="Visit [GitHub](https://github.com) for details." />);
    const link = screen.getByRole("link", { name: /GitHub/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders compact size mode when requested via RichText", () => {
    const { container } = render(<RichText text="Compact text" size="compact" />);
    expect((container.firstChild as HTMLElement).classList.contains("alpha-prose-compact")).toBe(true);
  });
});
