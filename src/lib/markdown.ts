import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

function normalizeHighlightLang(lang: string): string {
  switch (lang.toLowerCase()) {
    case "shell":
      return "sh";
    case "py3":
      return "python";
    case "tsx":
    case "typescriptreact":
      return "jsx";
    case "json5":
    case "jsonc":
      return "json";
    case "c#":
    case "csharp":
      return "cs";
    default:
      return lang;
  }
}

function escapeCodeHtml(code: string): string {
  return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const marked = new Marked(
  { breaks: true, gfm: true },
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const normalizedLang = lang ? normalizeHighlightLang(lang) : undefined;
      if (normalizedLang && hljs.getLanguage(normalizedLang)) {
        try {
          return hljs.highlight(code, { language: normalizedLang, ignoreIllegals: true }).value;
        } catch { /* fall through */ }
      }
      return escapeCodeHtml(code);
    },
  }),
);

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** Inline styles for rendered markdown content — based on VS Code markdown preview */
export const markdownStyles = `
.md-body {
  --markdown-font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif;
  --markdown-font-size: 14px;
  --markdown-line-height: 22px;
  --vscode-editor-font-family: "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace;
  --vscode-editor-foreground: #D4D4D4;
  --vscode-textLink-foreground: #3794FF;
  --vscode-textLink-activeForeground: #3794FF;
  --vscode-textPreformat-foreground: #D7BA7D;
  --vscode-textPreformat-background: #FFFFFF1A;
  --vscode-textBlockQuote-background: #222222;
  --vscode-textBlockQuote-border: #007acc80;
  --vscode-textCodeBlock-background: #262626;
  --vscode-widget-border: #303031;
  --vscode-diffEditor-insertedTextBackground: #9ccc2c33;
  --vscode-diffEditor-removedTextBackground: #ff000033;
  color: var(--vscode-editor-foreground);
  font-family: var(--markdown-font-family);
  font-size: var(--markdown-font-size);
  font-weight: 400;
  line-height: var(--markdown-line-height);
  word-wrap: break-word;
  -webkit-font-smoothing: subpixel-antialiased;
}

.md-body > *:first-child {
  margin-top: 0;
}

.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6,
.md-body p, .md-body ol, .md-body ul, .md-body pre {
  margin-top: 0;
}

.md-body h1, .md-body h2, .md-body h3, .md-body h4, .md-body h5, .md-body h6 {
  color: #e6edf3;
  font-weight: 600;
  margin-top: 24px;
  margin-bottom: 16px;
  line-height: 1.25;
}
.md-body h1 {
  font-size: 2em;
  margin-top: 0;
  padding-bottom: 0.3em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18);
}
.md-body h2 {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18);
}
.md-body h3 { font-size: 1.25em; }
.md-body h4 { font-size: 1em; }
.md-body h5 { font-size: 0.875em; }
.md-body h6 { font-size: 0.85em; }

.md-body p { margin: 0 0 16px; }
.md-body a, .md-body a code {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.md-body p > a {
  text-decoration: var(--text-link-decoration, none);
}
.md-body a:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}

.md-body code {
  font-family: var(--vscode-editor-font-family);
  font-size: 1em;
  line-height: 1.357em;
  color: var(--vscode-textPreformat-foreground);
  background-color: var(--vscode-textPreformat-background);
  padding: 1px 3px;
  border-radius: 4px;
}

.md-body pre {
  background-color: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-widget-border);
  margin: 0 0 16px;
}

.md-body pre:not(.hljs),
.md-body pre.hljs code > div {
  padding: 16px;
  border-radius: 3px;
  overflow: auto;
}

.md-body pre code {
  padding: 0;
  display: inline-block;
  color: var(--vscode-editor-foreground);
  tab-size: 4;
  font-weight: 500;
  background: none;
}

.md-body ul, .md-body ol {
  padding-inline-start: 2em;
  margin-bottom: 0.7em;
}
.md-body ul ul:first-child,
.md-body ul ol:first-child,
.md-body ol ul:first-child,
.md-body ol ol:first-child {
  margin-bottom: 0;
}

.md-body img, .md-body video { max-width: 100%; max-height: 100%; }
.md-body li p { margin-bottom: 0.7em; }

.md-body blockquote {
  margin: 0;
  padding: 0 16px 0 10px;
  border-left-width: 5px;
  border-left-style: solid;
  border-radius: 2px;
  background: var(--vscode-textBlockQuote-background);
  border-color: var(--vscode-textBlockQuote-border);
}

.md-body sub, .md-body sup {
  line-height: 0;
}

.md-body table {
  border-collapse: collapse;
  margin-bottom: 0.7em;
}
.md-body th {
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.69);
  font-weight: 600;
}
.md-body th, .md-body td { padding: 5px 10px; }
.md-body table > tbody > tr + tr > td {
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}
.md-body hr {
  border: 0;
  height: 1px;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
  margin: 24px 0 16px;
}
.md-body input[type="checkbox"] {
  margin-right: 6px;
}

/* VS Code highlight.js theme */
.md-body .hljs-keyword,
.md-body .hljs-literal,
.md-body .hljs-symbol,
.md-body .hljs-name { color: #569CD6; }
.md-body .hljs-link {
  color: #569CD6;
  text-decoration: underline;
}

.md-body .hljs-built_in,
.md-body .hljs-type { color: #4EC9B0; }

.md-body .hljs-number,
.md-body .hljs-class { color: #B8D7A3; }

.md-body .hljs-string,
.md-body .hljs-meta-string { color: #D69D85; }

.md-body .hljs-regexp,
.md-body .hljs-template-tag { color: #9A5334; }

.md-body .hljs-subst,
.md-body .hljs-function,
.md-body .hljs-title,
.md-body .hljs-params,
.md-body .hljs-formula { color: #DCDCDC; }

.md-body .hljs-comment,
.md-body .hljs-quote {
  color: #57A64A;
  font-style: italic;
}

.md-body .hljs-doctag { color: #608B4E; }

.md-body .hljs-meta,
.md-body .hljs-meta-keyword,
.md-body .hljs-tag { color: #9B9B9B; }

.md-body .hljs-variable,
.md-body .hljs-template-variable { color: #BD63C5; }

.md-body .hljs-attr,
.md-body .hljs-attribute,
.md-body .hljs-builtin-name { color: #9CDCFE; }

.md-body .hljs-section { color: gold; }
.md-body .hljs-emphasis { font-style: italic; }
.md-body .hljs-strong { font-weight: bold; }

.md-body .hljs-bullet,
.md-body .hljs-selector-tag,
.md-body .hljs-selector-id,
.md-body .hljs-selector-class,
.md-body .hljs-selector-attr,
.md-body .hljs-selector-pseudo { color: #D7BA7D; }

.md-body .hljs-addition {
  background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2));
  color: rgb(155, 185, 85);
  display: inline-block;
  width: 100%;
}

.md-body .hljs-deletion {
  background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2));
  color: rgb(255, 0, 0);
  display: inline-block;
  width: 100%;
}

/* VS Code light theme overrides */
.md-body.vscode-light .hljs-function,
.md-body.vscode-light .hljs-params,
.md-body.vscode-light .hljs-number,
.md-body.vscode-light .hljs-class {
  color: inherit;
}

.md-body.vscode-light .hljs-comment,
.md-body.vscode-light .hljs-quote,
.md-body.vscode-light .hljs-number,
.md-body.vscode-light .hljs-class,
.md-body.vscode-light .hljs-variable {
  color: #008000;
}

.md-body.vscode-light .hljs-keyword,
.md-body.vscode-light .hljs-selector-tag,
.md-body.vscode-light .hljs-name,
.md-body.vscode-light .hljs-tag {
  color: #00f;
}

.md-body.vscode-light .hljs-built_in,
.md-body.vscode-light .hljs-builtin-name {
  color: #007acc;
}

.md-body.vscode-light .hljs-string,
.md-body.vscode-light .hljs-section,
.md-body.vscode-light .hljs-attribute,
.md-body.vscode-light .hljs-literal,
.md-body.vscode-light .hljs-template-tag,
.md-body.vscode-light .hljs-template-variable,
.md-body.vscode-light .hljs-type {
  color: #a31515;
}

.md-body.vscode-light .hljs-subst,
.md-body.vscode-light .hljs-selector-attr,
.md-body.vscode-light .hljs-selector-pseudo,
.md-body.vscode-light .hljs-meta,
.md-body.vscode-light .hljs-meta-keyword {
  color: #2b91af;
}

.md-body.vscode-light .hljs-title,
.md-body.vscode-light .hljs-doctag {
  color: #808080;
}

.md-body.vscode-light .hljs-attr {
  color: #f00;
}

.md-body.vscode-light .hljs-symbol,
.md-body.vscode-light .hljs-bullet,
.md-body.vscode-light .hljs-link {
  color: #00b0e8;
}
`;
