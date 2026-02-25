/**
 * File icon system based on VS Code's Seti icon theme.
 * Uses the seti.woff font (copied from vscode/extensions/theme-seti/icons/).
 *
 * Each icon is a Unicode character from the Seti font + a color.
 * Extensions and special filenames are mapped to icon definitions.
 */

interface IconDef {
  ch: string; // Unicode character
  color: string;
}

// --- Icon definitions (dark theme) ---
// Extracted from vs-seti-icon-theme.json

const ICONS: Record<string, IconDef> = {
  _default:     { ch: "\uE023", color: "#d4d7d6" },
  _typescript:  { ch: "\uE099", color: "#519aba" },
  _typescript_1:{ ch: "\uE099", color: "#e37933" }, // .spec.ts, .test.ts
  _javascript:  { ch: "\uE051", color: "#cbcb41" },
  _javascript_1:{ ch: "\uE051", color: "#e37933" }, // .spec.js, .test.js
  _javascript_2:{ ch: "\uE051", color: "#519aba" },
  _react:       { ch: "\uE07D", color: "#519aba" },
  _react_1:     { ch: "\uE07D", color: "#e37933" }, // .spec.tsx, .test.tsx
  _json:        { ch: "\uE055", color: "#cbcb41" },
  _json_1:      { ch: "\uE055", color: "#8dc149" },
  _css:         { ch: "\uE01D", color: "#519aba" },
  _sass:        { ch: "\uE084", color: "#f55385" },
  _html:        { ch: "\uE048", color: "#519aba" },
  _html_1:      { ch: "\uE048", color: "#8dc149" },
  _html_2:      { ch: "\uE048", color: "#cbcb41" },
  _html_3:      { ch: "\uE048", color: "#e37933" },
  _html_erb:    { ch: "\uE049", color: "#cc3e44" },
  _markdown:    { ch: "\uE060", color: "#519aba" },
  _rust:        { ch: "\uE082", color: "#6d8086" },
  _python:      { ch: "\uE07B", color: "#519aba" },
  _go:          { ch: "\uE039", color: "#519aba" },
  _go2:         { ch: "\uE03A", color: "#519aba" },
  _ruby:        { ch: "\uE081", color: "#cc3e44" },
  _java:        { ch: "\uE050", color: "#cc3e44" },
  _java_1:      { ch: "\uE050", color: "#519aba" },
  _c:           { ch: "\uE00C", color: "#519aba" },
  _c_1:         { ch: "\uE00C", color: "#a074c4" },
  _c_2:         { ch: "\uE00C", color: "#cbcb41" },
  _cpp:         { ch: "\uE01A", color: "#519aba" },
  _cpp_1:       { ch: "\uE01A", color: "#a074c4" },
  _csharp:      { ch: "\uE00B", color: "#519aba" },
  _shell:       { ch: "\uE089", color: "#8dc149" },
  _swift:       { ch: "\uE092", color: "#e37933" },
  _kotlin:      { ch: "\uE058", color: "#e37933" },
  _dart:        { ch: "\uE021", color: "#519aba" },
  _php:         { ch: "\uE070", color: "#a074c4" },
  _scala:       { ch: "\uE086", color: "#cc3e44" },
  _elixir:      { ch: "\uE028", color: "#a074c4" },
  _haskell:     { ch: "\uE044", color: "#a074c4" },
  _lua:         { ch: "\uE05E", color: "#519aba" },
  _perl:        { ch: "\uE06E", color: "#519aba" },
  _R:           { ch: "\uE001", color: "#519aba" },
  _sql:         { ch: "\uE022", color: "#f55385" },
  _db:          { ch: "\uE022", color: "#f55385" },
  _xml:         { ch: "\uE0A5", color: "#e37933" },
  _yml:         { ch: "\uE0A7", color: "#a074c4" },
  _toml:        { ch: "\uE019", color: "#6d8086" },
  _config:      { ch: "\uE019", color: "#6d8086" },
  _git:         { ch: "\uE034", color: "#41535b" },
  _docker:      { ch: "\uE025", color: "#519aba" },
  _docker_1:    { ch: "\uE025", color: "#4d5a5e" },
  _docker_3:    { ch: "\uE025", color: "#f55385" },
  _npm:         { ch: "\uE067", color: "#41535b" },
  _npm_1:       { ch: "\uE067", color: "#cc3e44" },
  _yarn:        { ch: "\uE0A6", color: "#519aba" },
  _eslint:      { ch: "\uE02C", color: "#a074c4" },
  _eslint_1:    { ch: "\uE02C", color: "#4d5a5e" },
  _prettier:    { ch: "\uE076", color: "#519aba" },
  _webpack:     { ch: "\uE0A0", color: "#519aba" },
  _vite:        { ch: "\uE09C", color: "#cbcb41" },
  _rollup:      { ch: "\uE080", color: "#cc3e44" },
  _svg:         { ch: "\uE091", color: "#a074c4" },
  _image:       { ch: "\uE04C", color: "#a074c4" },
  _font:        { ch: "\uE033", color: "#cc3e44" },
  _pdf:         { ch: "\uE06D", color: "#cc3e44" },
  _video:       { ch: "\uE09B", color: "#f55385" },
  _audio:       { ch: "\uE005", color: "#a074c4" },
  _lock:        { ch: "\uE05D", color: "#8dc149" },
  _zip:         { ch: "\uE0A9", color: "#cc3e44" },
  _zip_1:       { ch: "\uE0A9", color: "#6d8086" },
  _license:     { ch: "\uE05A", color: "#cbcb41" },
  _info:        { ch: "\uE04D", color: "#519aba" },
  _todo:        { ch: "\uE096", color: "#ccc" },
  _clock:       { ch: "\uE012", color: "#519aba" },
  _tsconfig:    { ch: "\uE097", color: "#519aba" },
  _firebase:    { ch: "\uE030", color: "#e37933" },
  _github:      { ch: "\uE037", color: "#d4d7d6" },
  _gitlab:      { ch: "\uE038", color: "#e37933" },
  _vue:         { ch: "\uE09D", color: "#8dc149" },
  _svelte:      { ch: "\uE090", color: "#cc3e44" },
  _elm:         { ch: "\uE02A", color: "#519aba" },
  _terraform:   { ch: "\uE093", color: "#a074c4" },
  _prisma:      { ch: "\uE075", color: "#519aba" },
  _graphql:     { ch: "\uE03E", color: "#f55385" },
  _makefile:    { ch: "\uE05F", color: "#e37933" },
  _gradle:      { ch: "\uE03C", color: "#519aba" },
  _powershell:  { ch: "\uE074", color: "#519aba" },
  _word:        { ch: "\uE0A3", color: "#519aba" },
  _xls:         { ch: "\uE0A4", color: "#8dc149" },
  _csv:         { ch: "\uE01E", color: "#8dc149" },
  _ejs:         { ch: "\uE027", color: "#cbcb41" },
  _less:        { ch: "\uE059", color: "#519aba" },
  _stylus:      { ch: "\uE08E", color: "#8dc149" },
  _pug:         { ch: "\uE078", color: "#cc3e44" },
  _mustache:    { ch: "\uE063", color: "#e37933" },
  _twig:        { ch: "\uE098", color: "#8dc149" },
  _zig:         { ch: "\uE0A8", color: "#e37933" },
  _wasm:        { ch: "\uE09E", color: "#a074c4" },
  _ignored:     { ch: "\uE04A", color: "#41535b" },
  _notebook:    { ch: "\uE066", color: "#519aba" },
  _babel:       { ch: "\uE006", color: "#cbcb41" },
  _stylelint:   { ch: "\uE08D", color: "#d4d7d6" },
};

// --- Extension → icon key mapping ---

const EXT_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "_typescript", tsx: "_react", mts: "_typescript", cts: "_typescript",
  js: "_javascript", jsx: "_react", mjs: "_javascript", cjs: "_javascript",
  "spec.ts": "_typescript_1", "test.ts": "_typescript_1",
  "spec.tsx": "_react_1", "test.tsx": "_react_1",
  "spec.js": "_javascript_1", "test.js": "_javascript_1",
  "spec.jsx": "_react_1", "test.jsx": "_react_1",
  // Web
  html: "_html_3", htm: "_html_3", css: "_css", scss: "_sass", sass: "_sass",
  less: "_less", styl: "_stylus", svg: "_svg", vue: "_vue", svelte: "_svelte",
  // Data / Config
  json: "_json", jsonc: "_json", jsonl: "_json",
  yaml: "_yml", yml: "_yml", toml: "_toml",
  xml: "_xml", csv: "_csv",
  // Markdown / Docs
  md: "_markdown", mdx: "_markdown", txt: "_default",
  pdf: "_pdf", doc: "_word", docx: "_word", xls: "_xls", xlsx: "_xls",
  // Rust
  rs: "_rust",
  // Go
  go: "_go2",
  // Python
  py: "_python", pyi: "_python", pyw: "_python", ipynb: "_notebook",
  // Ruby
  rb: "_ruby", erb: "_html_erb", gemspec: "_ruby",
  // Java / JVM
  java: "_java", class: "_java_1", jar: "_zip", kt: "_kotlin", kts: "_kotlin",
  scala: "_scala", gradle: "_gradle", groovy: "_gradle",
  // C / C++
  c: "_c", h: "_c_1", cpp: "_cpp", cc: "_cpp", cxx: "_cpp",
  hpp: "_cpp_1", hh: "_cpp_1", hxx: "_cpp_1",
  // C#
  cs: "_csharp",
  // Swift / Objective-C
  swift: "_swift", m: "_c_2",
  // Shell
  sh: "_shell", bash: "_shell", zsh: "_shell", fish: "_shell",
  ps1: "_powershell", bat: "_shell",
  // Elixir / Erlang
  ex: "_elixir", exs: "_elixir",
  // Haskell
  hs: "_haskell", lhs: "_haskell",
  // Other languages
  lua: "_lua", pl: "_perl", r: "_R", sql: "_sql",
  dart: "_dart", elm: "_elm", php: "_php",
  zig: "_zig", wasm: "_wasm",
  // Templates
  ejs: "_ejs", pug: "_pug", jade: "_pug",
  mustache: "_mustache", hbs: "_mustache",
  twig: "_twig", njk: "_mustache",
  // Config files
  env: "_config", ini: "_config", cfg: "_config", conf: "_config",
  editorconfig: "_config", properties: "_config",
  tf: "_terraform", tfvars: "_terraform",
  prisma: "_prisma", graphql: "_graphql", gql: "_graphql",
  // Images / Media
  png: "_image", jpg: "_image", jpeg: "_image", gif: "_image",
  ico: "_image", webp: "_image", avif: "_image", bmp: "_image", tiff: "_image",
  mp4: "_video", mov: "_video", avi: "_video", webm: "_video", mkv: "_video",
  mp3: "_audio", wav: "_audio", ogg: "_audio", flac: "_audio",
  // Fonts
  woff: "_font", woff2: "_font", ttf: "_font", otf: "_font", eot: "_font",
  // Archives
  zip: "_zip_1", tar: "_zip_1", gz: "_zip_1", bz2: "_zip_1", xz: "_zip_1",
  // Misc
  lock: "_lock", pem: "_lock", key: "_lock", cer: "_lock", crt: "_lock",
  log: "_config",
  // Make
  mk: "_makefile",
};

// --- Special filename → icon key mapping ---

const NAME_MAP: Record<string, string> = {
  "tsconfig.json": "_tsconfig",
  "package.json": "_npm_1",
  "package-lock.json": "_npm",
  ".npmrc": "_npm_1",
  ".npmignore": "_npm_1",
  "yarn.lock": "_yarn",
  ".yarnrc": "_yarn",
  ".gitignore": "_git",
  ".gitattributes": "_git",
  ".gitmodules": "_git",
  ".gitconfig": "_git",
  ".gitkeep": "_git",
  "dockerfile": "_docker",
  "docker-compose.yml": "_docker_3",
  "docker-compose.yaml": "_docker_3",
  ".dockerignore": "_docker_1",
  ".eslintrc": "_eslint",
  ".eslintrc.js": "_eslint",
  ".eslintrc.json": "_eslint",
  ".eslintrc.yml": "_eslint",
  ".eslintrc.yaml": "_eslint",
  ".eslintignore": "_eslint_1",
  "eslint.config.js": "_eslint",
  "eslint.config.mjs": "_eslint",
  "eslint.config.ts": "_eslint",
  ".prettierrc": "_prettier",
  ".prettierignore": "_config",
  "vite.config.ts": "_vite",
  "vite.config.js": "_vite",
  "vite.config.mjs": "_vite",
  "webpack.config.js": "_webpack",
  "webpack.config.ts": "_webpack",
  "rollup.config.js": "_rollup",
  "rollup.config.ts": "_rollup",
  "babel.config.js": "_babel",
  "babel.config.json": "_babel",
  ".babelrc": "_babel",
  "makefile": "_makefile",
  "cmakelists.txt": "_makefile",
  "license": "_license",
  "license.md": "_license",
  "licence": "_license",
  "licence.md": "_license",
  "readme": "_info",
  "readme.md": "_info",
  "readme.txt": "_info",
  "changelog": "_clock",
  "changelog.md": "_clock",
  "todo": "_todo",
  "todo.md": "_todo",
  "firebase.json": "_firebase",
  ".firebaserc": "_firebase",
  ".gitlab-ci.yml": "_gitlab",
  "stylelint.config.js": "_stylelint",
  ".stylelintrc": "_stylelint",
  ".ds_store": "_ignored",
};

/**
 * Get the icon character and color for a given filename.
 */
export function getFileIcon(fileName: string): IconDef {
  const lower = fileName.toLowerCase();

  // Check exact filename match first
  const nameIcon = NAME_MAP[lower];
  if (nameIcon && ICONS[nameIcon]) return ICONS[nameIcon];

  // Check multi-part extensions (e.g., spec.ts, test.tsx)
  const parts = lower.split(".");
  if (parts.length >= 3) {
    const multiExt = parts.slice(-2).join(".");
    const multiIcon = EXT_MAP[multiExt];
    if (multiIcon && ICONS[multiIcon]) return ICONS[multiIcon];
  }

  // Check single extension
  const ext = parts.length > 1 ? parts[parts.length - 1] : "";
  if (ext) {
    const extIcon = EXT_MAP[ext];
    if (extIcon && ICONS[extIcon]) return ICONS[extIcon];
  }

  return ICONS._default;
}

/**
 * Inject the @font-face CSS for the Seti icon font.
 * Call once at app startup.
 */
let injected = false;
export function injectSetiFont() {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.textContent = `
@font-face {
  font-family: "seti";
  src: url("/seti.woff") format("woff");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}
`;
  document.head.appendChild(style);
}
