import { useState, Component, type ErrorInfo, type ReactNode, isValidElement, cloneElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import {
  Check,
  Copy,
  Info,
  Lightbulb,
  AlertTriangle,
  AlertOctagon,
  AlertCircle,
  CheckCircle2,
  Workflow,
  ImageIcon,
} from "lucide-react";
import { normalizePresentation, type CalloutType } from "../lib/presentation";

function prettyHost(url: string): string {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (h.includes("vertexaisearch") || h.includes("googleusercontent")) return "Open source";
    return h;
  } catch {
    return "Open link";
  }
}

/** Error boundary for KaTeX / Math rendering to prevent crash on malformed math */
class MathErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn("Math rendering error caught by boundary:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return <span className="font-mono text-xs opacity-70">[Math Format Error]</span>;
    }
    return this.props.children;
  }
}

/** Code block & Diagram renderer */
function CodePre({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  let codeText = "";
  let language = "";

  if (children && typeof children === "object" && "props" in (children as any)) {
    const codeProps = (children as any).props;
    codeText = String(codeProps?.children ?? "");
    const match = /language-(\w+)/.exec(codeProps?.className || "");
    if (match) language = match[1];
  } else {
    codeText = String(children ?? "");
  }

  const cleanCode = codeText.replace(/\n$/, "");
  const isDiagram = ["diagram", "ascii", "mermaid", "flowchart", "sequence"].includes(
    language.toLowerCase()
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (isDiagram) {
    return (
      <div className="alpha-diagram-container my-4 rounded-xl border border-primary/30 bg-black/80 backdrop-blur overflow-hidden shadow-lg">
        <div className="flex items-center justify-between px-3 py-1.5 bg-primary/10 border-b border-primary/20 text-xs font-mono select-none">
          <div className="flex items-center gap-1.5 text-primary font-semibold">
            <Workflow className="w-3.5 h-3.5" />
            <span className="uppercase text-[10px] tracking-wider">
              {language.toUpperCase()}
            </span>
          </div>
          <button
            type="button"
            onClick={onCopy}
            aria-label={copied ? "Copied diagram" : "Copy diagram"}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400 font-medium">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy Diagram</span>
              </>
            )}
          </button>
        </div>
        <pre className="alpha-pre alpha-diagram-pre m-0 p-4 font-mono text-xs leading-relaxed overflow-x-auto select-text text-emerald-300">
          {cleanCode}
        </pre>
      </div>
    );
  }

  return (
    <div className="alpha-code-container my-3 rounded-xl border border-primary/25 bg-black/60 backdrop-blur overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/10 text-xs font-mono text-muted-foreground select-none">
        <span className="uppercase text-[10px] tracking-wider text-primary font-semibold">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied code" : "Copy code"}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors active:scale-95 cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="alpha-pre m-0 rounded-none border-none p-3 overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

/** Processes blockquote children to strip callout header tag while retaining rich React nodes */
function processCalloutChildren(children: ReactNode): { type: CalloutType | null; content: ReactNode } {
  let foundType: CalloutType | null = null;

  const removeHeaderTag = (node: ReactNode): ReactNode => {
    if (typeof node === "string") {
      const match = node.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|ERROR|SUCCESS)\]\s*/i);
      if (match) {
        foundType = match[1].toUpperCase() as CalloutType;
        return node.slice(match[0].length);
      }
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((child, idx) => {
        if (idx === 0 && !foundType) {
          return removeHeaderTag(child);
        }
        return child;
      });
    }

    if (isValidElement(node)) {
      const props = (node as any).props;
      if (props && props.children) {
        const newChildren = removeHeaderTag(props.children);
        return cloneElement(node, { ...props, children: newChildren });
      }
    }

    return node;
  };

  const content = removeHeaderTag(children);
  return { type: foundType, content };
}

/** Callout Card Renderer */
function CalloutBlock({ children }: { children?: React.ReactNode }) {
  const { type, content } = processCalloutChildren(children);

  if (!type) {
    return <blockquote className="alpha-blockquote">{children}</blockquote>;
  }

  const configMap: Record<
    CalloutType,
    { icon: any; title: string; containerCls: string; iconCls: string; titleCls: string }
  > = {
    NOTE: {
      icon: Info,
      title: "Note",
      containerCls: "bg-blue-950/30 border-blue-500/40 text-blue-200",
      iconCls: "text-blue-400",
      titleCls: "text-blue-300 font-semibold",
    },
    TIP: {
      icon: Lightbulb,
      title: "Tip",
      containerCls: "bg-emerald-950/30 border-emerald-500/40 text-emerald-200",
      iconCls: "text-emerald-400",
      titleCls: "text-emerald-300 font-semibold",
    },
    IMPORTANT: {
      icon: AlertCircle,
      title: "Important",
      containerCls: "bg-purple-950/30 border-purple-500/40 text-purple-200",
      iconCls: "text-purple-400",
      titleCls: "text-purple-300 font-semibold",
    },
    WARNING: {
      icon: AlertTriangle,
      title: "Warning",
      containerCls: "bg-amber-950/30 border-amber-500/40 text-amber-200",
      iconCls: "text-amber-400",
      titleCls: "text-amber-300 font-semibold",
    },
    ERROR: {
      icon: AlertOctagon,
      title: "Error",
      containerCls: "bg-rose-950/30 border-rose-500/40 text-rose-200",
      iconCls: "text-rose-400",
      titleCls: "text-rose-300 font-semibold",
    },
    SUCCESS: {
      icon: CheckCircle2,
      title: "Success",
      containerCls: "bg-teal-950/30 border-teal-500/40 text-teal-200",
      iconCls: "text-teal-400",
      titleCls: "text-teal-300 font-semibold",
    },
  };

  const cfg = configMap[type] || configMap.NOTE;
  const IconComp = cfg.icon;

  return (
    <div
      className={`alpha-callout my-4 p-3.5 rounded-xl border-l-4 border shadow-md flex gap-3 items-start ${cfg.containerCls}`}
    >
      <IconComp className={`w-5 h-5 shrink-0 mt-0.5 ${cfg.iconCls}`} />
      <div className="flex-1 min-w-0 text-sm leading-relaxed">
        <div className={`text-xs uppercase tracking-wider mb-1 ${cfg.titleCls}`}>
          {cfg.title}
        </div>
        <div className="callout-body">{content}</div>
      </div>
    </div>
  );
}

/** Image Component with Zero Broken Image Policy */
function SafeImage({ src, alt }: { src?: string; alt?: string }) {
  const [error, setError] = useState(false);

  if (error || !src) {
    return (
      <div className="my-4 p-4 rounded-xl border border-muted/40 bg-card flex items-center gap-3 text-muted-foreground text-xs">
        <ImageIcon className="w-5 h-5 shrink-0" />
        <span>[Image unavailable: {alt || "visual asset"}]</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt || "Generated visual asset"}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setError(true)}
      className="alpha-img rounded-xl border border-border/50 my-4 max-w-full h-auto shadow-md"
    />
  );
}

/**
 * The single rich-text renderer for ALL Alpha-generated content: chat replies,
 * notes, memories, reminders, plans, bills, tool results and search summaries.
 */
export function RichText({ text, size = "base" }: { text: string; size?: "base" | "compact" }) {
  const normalizedText = normalizePresentation(text || "");

  return (
    <MathErrorBoundary>
      <div className={`alpha-prose${size === "compact" ? " alpha-prose-compact" : ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkMath, remarkGfm]}
          rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
          components={{
            a: ({ href, children }) => {
              const url = String(href || "");
              const txt = String(Array.isArray(children) ? children.join("") : (children ?? ""));
              const isRawUrl = /^https?:\/\//i.test(txt);
              const label = isRawUrl || !txt.trim() ? prettyHost(url) : txt;
              return (
                <a href={url} target="_blank" rel="noopener noreferrer" className="alpha-link">
                  {label}
                </a>
              );
            },
            blockquote: (props) => <CalloutBlock {...props} />,
            table: ({ children }) => (
              <div
                className="table-scroll-container alpha-table-wrap"
                role="region"
                aria-label="Data table"
                tabIndex={0}
              >
                <table className="alpha-table">{children}</table>
              </div>
            ),
            thead: ({ children }) => <thead className="alpha-thead">{children}</thead>,
            tbody: ({ children }) => <tbody className="alpha-tbody">{children}</tbody>,
            tr: ({ children }) => <tr className="alpha-tr">{children}</tr>,
            th: ({ children }) => <th className="alpha-th">{children}</th>,
            td: ({ children }) => <td className="alpha-td">{children}</td>,
            pre: (props) => <CodePre {...props} />,
            img: ({ src, alt }) => <SafeImage src={String(src || "")} alt={String(alt || "")} />,
          }}
        >
          {normalizedText}
        </ReactMarkdown>
      </div>
    </MathErrorBoundary>
  );
}

/** Backwards-compatible alias — chat surfaces import this name. */
export function MessageContent({ text }: { text: string }) {
  return <RichText text={text} />;
}
