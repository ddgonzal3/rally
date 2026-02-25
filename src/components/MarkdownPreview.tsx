import React, { useMemo, forwardRef } from "react";
import { renderMarkdown, markdownStyles } from "../lib/markdown";

interface MarkdownPreviewProps {
  content: string;
  onScroll?: (scrollTop: number, scrollHeight: number, clientHeight: number) => void;
}

export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  function MarkdownPreview({ content, onScroll }, ref) {
    const html = useMemo(() => renderMarkdown(content), [content]);

    return (
      <div
        ref={ref}
        style={styles.container}
        onScroll={
          onScroll
            ? (e) => {
                const el = e.currentTarget;
                onScroll(el.scrollTop, el.scrollHeight, el.clientHeight);
              }
            : undefined
        }
      >
        <style>{markdownStyles}</style>
        <div
          className="md-body"
          style={styles.body}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  },
);

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflow: "auto",
    background: "#1e1e1e",
    minWidth: 0,
    minHeight: 0,
  },
  body: {
    padding: "16px 26px",
  },
};
