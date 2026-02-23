export interface TokenRule {
  pattern: RegExp;
  className: string;
}

interface Token {
  start: number;
  end: number;
  className: string;
}

// --- Language rule definitions ---

const jsKeywords =
  "const|let|var|function|return|if|else|for|while|class|import|export|from|default|async|await|new|this|typeof|instanceof|throw|try|catch|finally|switch|case|break|continue|do|in|of|yield";
const jsLiterals = "true|false|null|undefined|NaN|Infinity";

const rustKeywords =
  "fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|async|await|self|Self|super|crate|where|type|as|in|ref|move|unsafe|extern|dyn|static|macro_rules";
const rustLiterals = "true|false|None|Some|Ok|Err";

const pythonKeywords =
  "def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|and|or|not|is|in|True|False|None|async|await|global|nonlocal";

const goKeywords =
  "func|var|const|type|struct|interface|map|chan|go|select|switch|case|default|if|else|for|range|return|break|continue|defer|package|import|fallthrough";
const goLiterals = "true|false|nil|iota";

const shellKeywords =
  "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|local|readonly|declare|set|unset|cd|ls|rm|cp|mv|mkdir|cat|grep|sed|awk|find|xargs";

function wordBoundary(words: string): RegExp {
  return new RegExp(`\\b(${words})\\b`, "g");
}

export const LANG_RULES: Record<string, TokenRule[]> = {
  js: [
    { pattern: /\/\/.*$/gm, className: "syn-comment" },
    { pattern: /\/\*[\s\S]*?\*\//g, className: "syn-comment" },
    { pattern: /(["'`])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: wordBoundary(jsKeywords), className: "syn-keyword" },
    { pattern: wordBoundary(jsLiterals), className: "syn-literal" },
    { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, className: "syn-number" },
  ],

  rust: [
    { pattern: /\/\/.*$/gm, className: "syn-comment" },
    { pattern: /\/\*[\s\S]*?\*\//g, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: wordBoundary(rustKeywords), className: "syn-keyword" },
    { pattern: wordBoundary(rustLiterals), className: "syn-literal" },
    { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:_\d+)*(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)?\b/g, className: "syn-number" },
  ],

  python: [
    { pattern: /#.*$/gm, className: "syn-comment" },
    { pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/g, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: wordBoundary(pythonKeywords), className: "syn-keyword" },
    { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, className: "syn-number" },
  ],

  json: [
    { pattern: /"(?:[^"\\]|\\.)*"\s*(?=:)/g, className: "syn-keyword" },
    { pattern: /"(?:[^"\\]|\\.)*"/g, className: "syn-string" },
    { pattern: /\b(?:true|false|null)\b/g, className: "syn-literal" },
    { pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, className: "syn-number" },
  ],

  css: [
    { pattern: /\/\*[\s\S]*?\*\//g, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/g, className: "syn-number" },
    { pattern: /#[0-9a-fA-F]{3,8}\b/g, className: "syn-number" },
  ],

  shell: [
    { pattern: /#.*$/gm, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: wordBoundary(shellKeywords), className: "syn-keyword" },
    { pattern: /\$[A-Za-z_]\w*|\$\{[^}]+\}/g, className: "syn-literal" },
  ],

  go: [
    { pattern: /\/\/.*$/gm, className: "syn-comment" },
    { pattern: /\/\*[\s\S]*?\*\//g, className: "syn-comment" },
    { pattern: /(["'`])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: wordBoundary(goKeywords), className: "syn-keyword" },
    { pattern: wordBoundary(goLiterals), className: "syn-literal" },
    { pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, className: "syn-number" },
  ],

  yaml: [
    { pattern: /#.*$/gm, className: "syn-comment" },
    { pattern: /^[\w./-]+(?=\s*:)/gm, className: "syn-keyword" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: /\b(?:true|false|null|yes|no|on|off)\b/gi, className: "syn-literal" },
    { pattern: /\b\d+(?:\.\d+)?\b/g, className: "syn-number" },
  ],

  html: [
    { pattern: /<!--[\s\S]*?-->/g, className: "syn-comment" },
    { pattern: /(["'])(?:(?!\1|\\).|\\.)*?\1/g, className: "syn-string" },
    { pattern: /<\/?[a-zA-Z][\w-]*[^>]*>/g, className: "syn-keyword" },
  ],

  md: [
    { pattern: /^#{1,6}\s.+$/gm, className: "syn-keyword" },
    { pattern: /`[^`]+`/g, className: "syn-string" },
    { pattern: /\*\*[^*]+\*\*/g, className: "syn-literal" },
  ],
};

// --- Extension to language mapping ---

export const EXT_MAP: Record<string, string> = {
  js: "js",
  jsx: "js",
  ts: "js",
  tsx: "js",
  mjs: "js",
  cjs: "js",
  rs: "rust",
  py: "python",
  json: "json",
  css: "css",
  scss: "css",
  less: "css",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  md: "md",
  mdx: "md",
  toml: "yaml",
  rb: "python",
};

/**
 * Extract a file extension from a path and return the matching language key,
 * or null if the extension is not recognized.
 */
export function getLangForPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? null;
}

/**
 * Escape HTML special characters so raw code can be safely inserted into innerHTML.
 */
export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Apply regex-based syntax highlighting to a single line of code.
 *
 * Returns an HTML string with `<span class="syn-*">` wrappers around tokens.
 * Tokens are non-overlapping; earlier rules win when ranges conflict.
 */
export function highlightLine(code: string, lang: string | null): string {
  if (!lang || !LANG_RULES[lang]) {
    return escapeHtml(code);
  }

  const rules = LANG_RULES[lang];
  const tokens: Token[] = [];

  // Collect all matches from all rules
  for (const rule of rules) {
    // Reset lastIndex for global regexes before each use
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(code)) !== null) {
      tokens.push({
        start: match.index,
        end: match.index + match[0].length,
        className: rule.className,
      });
      // Guard against zero-length matches causing infinite loops
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
      }
    }
  }

  if (tokens.length === 0) {
    return escapeHtml(code);
  }

  // Sort by start position; for ties, longer match wins (earlier rule takes precedence via stable sort)
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);

  // Remove overlapping tokens — earlier (by position), longer matches win
  const kept: Token[] = [];
  let lastEnd = 0;
  for (const tok of tokens) {
    if (tok.start >= lastEnd) {
      kept.push(tok);
      lastEnd = tok.end;
    }
  }

  // Build the final HTML by interleaving plain text with highlighted spans
  const parts: string[] = [];
  let cursor = 0;

  for (const tok of kept) {
    // Plain text before this token
    if (tok.start > cursor) {
      parts.push(escapeHtml(code.slice(cursor, tok.start)));
    }
    parts.push(
      `<span class="${tok.className}">${escapeHtml(code.slice(tok.start, tok.end))}</span>`
    );
    cursor = tok.end;
  }

  // Trailing plain text
  if (cursor < code.length) {
    parts.push(escapeHtml(code.slice(cursor)));
  }

  return parts.join("");
}
