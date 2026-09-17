import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";

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

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="alpha-code-container my-3 rounded-xl border border-primary/25 bg-black/60 backdrop-blur overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/10 text-xs font-mono text-muted-foreground select-none">
        <span className="uppercase text-[10px] tracking-wider text-primary font-semibold">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy code"}
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

/**
 * The single rich-text renderer for ALL Alpha-generated content: chat replies,
 * notes, memories, reminders, plans, bills, tool results and search summaries.
 *
 * The model decides the structure (paragraph / heading / list / table / code);
 * this component plus the `.alpha-prose` rules in styles.css decide exactly how
 * that structure looks. Typography and spacing are never left to the model.
 */
export function RichText({ text, size = "base" }: { text: string; size?: "base" | "compact" }) {
  return (
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
          table: ({ children }) => (
            <div className="table-scroll-container alpha-table-wrap" role="region" aria-label="Data table" tabIndex={0}>
              <table className="alpha-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="alpha-thead">{children}</thead>,
          tbody: ({ children }) => <tbody className="alpha-tbody">{children}</tbody>,
          tr: ({ children }) => <tr className="alpha-tr">{children}</tr>,
          th: ({ children }) => <th className="alpha-th">{children}</th>,
          td: ({ children }) => <td className="alpha-td">{children}</td>,
          pre: (props) => <CodePre {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Backwards-compatible alias — chat surfaces import this name. */
export function MessageContent({ text }: { text: string }) {
  return <RichText text={text} />;
}
