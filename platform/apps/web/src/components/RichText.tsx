import { useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";
import { Check, Copy, Maximize2 } from "lucide-react";
import { safeContentUrl } from "../conversation-state";
import { sourcePathFromContentUrl } from "../source-preview";
import { useWorkspace } from "../workspace";
import { Icon } from "./controls";
import { Modal } from "./ui";
import { useCopyFeedback } from "./useCopyFeedback";

function textOf(node?: Element | ElementContent): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
}
function tableText(node?: Element) {
  const rows: string[][] = [];
  const visit = (current: Element | ElementContent) => {
    if (current.type !== "element") return;
    if (current.tagName === "tr")
      rows.push(
        current.children
          .filter(
            (cell): cell is Element =>
              cell.type === "element" && /^t[hd]$/.test(cell.tagName),
          )
          .map((cell) => textOf(cell).trim()),
      );
    else current.children.forEach(visit);
  };
  if (node) visit(node);
  return rows.map((row) => row.join("\t")).join("\n");
}

/** Plain-text copy for code and tables; never executes or fetches content. */
function CopyText({ label, text }: { label: string; text: string }) {
  const { copyState: state, copy } = useCopyFeedback(text);
  return (
    <button
      type="button"
      className="utility-button"
      aria-label={label}
      onClick={() => {
        void copy(() => navigator.clipboard.writeText(text));
      }}
    >
      <Icon icon={state === "Copied" ? Check : Copy} size={12} weight="control" />
      <span aria-live="polite">{state || "Copy"}</span>
    </button>
  );
}
function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node?.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  const classes = code?.properties?.className;
  const language = Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length)
    : undefined;
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || "Code"}</span>
        <CopyText label="Copy code" text={textOf(code ?? node).replace(/\n$/, "")} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}
function MarkdownTable({ node, children }: { node?: Element; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="markdown-table">
      <div className="table-scroll">
        <table>{children}</table>
      </div>
      <div className="markdown-table-footer">
        <CopyText label="Copy table" text={tableText(node)} />
        <button
          type="button"
          className="utility-button"
          onClick={() => setExpanded(true)}
        >
          <Icon icon={Maximize2} size={12} weight="control" />
          <span>Expand</span>
        </button>
      </div>
      {expanded ? (
        <Modal title="Table" wide onClose={() => setExpanded(false)}>
          <div className="markdown expanded-table">
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export function ContentLink({ href, children, page }: { href?: string; children?: ReactNode; page?: number }) {
  const { orgBase } = useWorkspace();
  const path = href ? sourcePathFromContentUrl(href, page) : undefined;
  if (path) return (
    <Link to={`${orgBase}${path}`} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : <span>{children}</span>;
}

// Renderer identities must survive parent/canonical refreshes. Inline component
// factories remount stateful blocks, closing expanded tables and losing feedback.
const markdownComponents: Components = {
  a: ContentLink,
  img: ({ alt }) => (
    <span className="muted">{alt ? `[Image: ${alt}]` : "[Image]"}</span>
  ),
  pre: CodeBlock,
  table: MarkdownTable,
  // Task-list markers are document content: drawn, never interactive.
  input: ({ type, checked }) => type === "checkbox" ? (
    <span className={`task-marker${checked ? " checked" : ""}`} role="img"
      aria-label={checked ? "Completed" : "Not completed"} />
  ) : null,
};

export function RichText({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeContentUrl(url) ?? ""}
        components={markdownComponents}
      >
        {children}
      </Markdown>
    </div>
  );
}
