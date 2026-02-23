import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** Inline styles for rendered markdown content */
export const markdownStyles = `
.md-body {
  font-size: 13px;
  line-height: 1.6;
  color: #ccc;
  word-break: break-word;
}
.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
  color: #e6edf3;
  margin: 16px 0 8px;
  font-weight: 600;
  line-height: 1.3;
}
.md-body h1 { font-size: 18px; border-bottom: 1px solid #2a2a2a; padding-bottom: 6px; }
.md-body h2 { font-size: 16px; border-bottom: 1px solid #2a2a2a; padding-bottom: 4px; }
.md-body h3 { font-size: 14px; }
.md-body h4, .md-body h5, .md-body h6 { font-size: 13px; }
.md-body p { margin: 8px 0; }
.md-body a { color: #58a6ff; text-decoration: none; }
.md-body a:hover { text-decoration: underline; }
.md-body code {
  background: #2a2a2a;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-family: 'SF Mono', 'Menlo', monospace;
  color: #e6edf3;
}
.md-body pre {
  background: #1e1e1e;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
}
.md-body pre code {
  background: none;
  padding: 0;
  border-radius: 0;
}
.md-body ul, .md-body ol {
  padding-left: 20px;
  margin: 8px 0;
}
.md-body li { margin: 4px 0; }
.md-body blockquote {
  border-left: 3px solid #444;
  padding-left: 12px;
  margin: 8px 0;
  color: #999;
}
.md-body img { max-width: 100%; border-radius: 6px; }
.md-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}
.md-body th, .md-body td {
  border: 1px solid #2a2a2a;
  padding: 6px 10px;
  text-align: left;
  font-size: 12px;
}
.md-body th {
  background: #222;
  font-weight: 600;
  color: #e6edf3;
}
.md-body hr {
  border: none;
  border-top: 1px solid #2a2a2a;
  margin: 12px 0;
}
.md-body input[type="checkbox"] {
  margin-right: 6px;
}
`;
