import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeContentUrl } from "../conversation-state";
import { sourcePathFromContentUrl } from "../source-preview";
import { useWorkspace } from "../workspace";

export function RichText({ children }: { children: string }) {
  const { orgBase } = useWorkspace();
  const localSource = (href: string) => {
    const path = sourcePathFromContentUrl(href);
    return path ? `${orgBase}${path}` : href;
  };
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeContentUrl(url) ?? ""}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={localSource(href)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => (
            <span className="muted">{alt ? `[Image: ${alt}]` : "[Image]"}</span>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
