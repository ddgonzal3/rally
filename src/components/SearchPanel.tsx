import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { api } from "../lib/tauri";
import type { SearchMatch, ReplaceOp } from "../lib/types";
import { ScrollArea } from "./ScrollArea";
import { FileIcon } from "./FileIcon";
import { showContextMenu } from "../lib/contextMenu";
import "./SearchPanel.css";

interface SearchPanelProps {
  onCollapse: () => void;
  flushLeft: boolean;
}

interface FileGroup {
  filePath: string;
  fileName: string;
  fileDescription: string;
  matches: SearchMatch[];
}

interface RepoGroup {
  repoPath: string;
  repoName: string;
  totalMatches: number;
  files: FileGroup[];
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(0, idx) : "";
}

function findRepoForFile(filePath: string, sortedRoots: string[]): string {
  for (const root of sortedRoots) {
    if (filePath === root || filePath.startsWith(`${root}/`)) {
      return root;
    }
  }
  return dirname(filePath) || filePath;
}

interface PerWorkspaceSearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  results: SearchMatch[];
  hasSearched: boolean;
  collapsedFiles: Set<string>;
  replaceOpen: boolean;
  replaceValue: string;
  preserveCase: boolean;
  collapsedRepos: Set<string>;
}

function defaultSearchState(): PerWorkspaceSearchState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    results: [],
    hasSearched: false,
    collapsedFiles: new Set(),
    replaceOpen: false,
    replaceValue: "",
    preserveCase: false,
    collapsedRepos: new Set(),
  };
}

export function SearchPanel({ onCollapse, flushLeft }: SearchPanelProps) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const paths = ws?.paths ?? [];

  // Per-workspace search state cache
  const stateMapRef = useRef<Map<string, PerWorkspaceSearchState>>(new Map());
  const prevWorkspaceRef = useRef<string | null>(null);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [inputFocused, setInputFocused] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceValue, setReplaceValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replaceInputFocused, setReplaceInputFocused] = useState(false);
  const [preserveCase, setPreserveCase] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());

  // Save/restore search state when switching workspaces
  useEffect(() => {
    const wsId = activeWorkspaceId ?? "";
    const prevId = prevWorkspaceRef.current;

    // Save current state for the previous workspace
    if (prevId && prevId !== wsId) {
      stateMapRef.current.set(prevId, {
        query, caseSensitive, wholeWord, useRegex, results,
        hasSearched, collapsedFiles, replaceOpen, replaceValue,
        preserveCase, collapsedRepos,
      });
    }

    // Restore state for the new workspace (or reset to defaults)
    if (prevId !== wsId) {
      const saved = stateMapRef.current.get(wsId) ?? defaultSearchState();
      setQuery(saved.query);
      setCaseSensitive(saved.caseSensitive);
      setWholeWord(saved.wholeWord);
      setUseRegex(saved.useRegex);
      setResults(saved.results);
      setHasSearched(saved.hasSearched);
      setCollapsedFiles(saved.collapsedFiles);
      setReplaceOpen(saved.replaceOpen);
      setReplaceValue(saved.replaceValue);
      setPreserveCase(saved.preserveCase);
      setCollapsedRepos(saved.collapsedRepos);
      setSearching(false);
      setReplacing(false);
      prevWorkspaceRef.current = wsId;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    async (q: string, cs: boolean, ww: boolean, re: boolean) => {
      if (!q.trim() || paths.length === 0) {
        setResults([]);
        setHasSearched(false);
        setSearching(false);
        return;
      }
      const id = ++searchIdRef.current;
      setSearching(true);
      try {
        const matches = await api.searchInFiles(paths, q, cs, ww, re);
        if (id === searchIdRef.current) {
          setResults(matches);
          setHasSearched(true);
        }
      } catch (e) {
        console.error("Search failed:", e);
        if (id === searchIdRef.current) {
          setResults([]);
          setHasSearched(true);
        }
      } finally {
        if (id === searchIdRef.current) {
          setSearching(false);
        }
      }
    },
    [paths],
  );

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setHasSearched(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      doSearch(query, caseSensitive, wholeWord, useRegex);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, caseSensitive, wholeWord, useRegex, doSearch]);

  // Re-run search when files are modified (detected via git watcher)
  useEffect(() => {
    if (!query.trim() || !hasSearched) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen("git-changes-updated", () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        doSearch(query, caseSensitive, wholeWord, useRegex);
      }, 500);
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [query, caseSensitive, wholeWord, useRegex, hasSearched, doSearch]);

  const repoGroups = useMemo((): RepoGroup[] => {
    const rootsBySpecificity = [...paths].sort((a, b) => b.length - a.length);
    const repoMap = new Map<string, Map<string, SearchMatch[]>>();

    for (const m of results) {
      const repoPath = findRepoForFile(m.file_path, rootsBySpecificity);
      let repoFiles = repoMap.get(repoPath);
      if (!repoFiles) {
        repoFiles = new Map<string, SearchMatch[]>();
        repoMap.set(repoPath, repoFiles);
      }

      let arr = repoFiles.get(m.file_path);
      if (!arr) {
        arr = [];
        repoFiles.set(m.file_path, arr);
      }
      arr.push(m);
    }

    const pathOrder = new Map(paths.map((p, index) => [p, index]));

    return Array.from(repoMap.entries())
      .sort(([a], [b]) => {
        const ai = pathOrder.get(a);
        const bi = pathOrder.get(b);
        if (ai !== undefined && bi !== undefined) return ai - bi;
        if (ai !== undefined) return -1;
        if (bi !== undefined) return 1;
        return a.localeCompare(b);
      })
      .map(([repoPath, files]) => {
        const repoName = basename(repoPath);

        const fileGroups = Array.from(files.entries()).map(([filePath, matches]) => {
          let relativePath = filePath;
          let workspaceRootLabel = repoName;

          const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
          if (filePath.startsWith(prefix)) {
            relativePath = filePath.slice(prefix.length);
          }

          const lastSlash = relativePath.lastIndexOf("/");
          const fileName = lastSlash >= 0 ? relativePath.slice(lastSlash + 1) : relativePath;
          const dirPath = lastSlash >= 0 ? relativePath.slice(0, lastSlash) : "";
          const fileDescription = dirPath ? `${workspaceRootLabel} \u00b7 ${dirPath}` : workspaceRootLabel;

          return {
            filePath,
            fileName,
            fileDescription,
            matches,
          };
        });

        const totalMatches = fileGroups.reduce((sum, file) => sum + file.matches.length, 0);
        return {
          repoPath,
          repoName,
          totalMatches,
          files: fileGroups,
        };
      });
  }, [results, paths]);

  const totalResults = results.length;
  const totalFiles = repoGroups.reduce((sum, repo) => sum + repo.files.length, 0);
  const replaceDisabled = replacing || !query.trim() || results.length === 0;
  const allCollapsed = repoGroups.length > 0 && repoGroups.every((repo) => collapsedRepos.has(repo.repoPath));

  const toggleFileCollapse = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const toggleCollapseAll = useCallback(() => {
    if (repoGroups.length === 0) return;
    if (allCollapsed) {
      setCollapsedRepos(new Set());
      return;
    }
    setCollapsedRepos(new Set(repoGroups.map((repo) => repo.repoPath)));
  }, [allCollapsed, repoGroups]);

  const toggleRepoCollapse = useCallback((repoPath: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoPath)) {
        next.delete(repoPath);
      } else {
        next.add(repoPath);
      }
      return next;
    });
  }, []);

  const handleResultClick = useCallback(
    (filePath: string, lineNumber: number) => {
      if (!activeWorkspaceId) return;
      openFile(activeWorkspaceId, filePath, { line: lineNumber });
    },
    [activeWorkspaceId, openFile],
  );

  const handleReplaceAll = useCallback(async () => {
    if (!query.trim() || results.length === 0) return;
    setReplacing(true);
    try {
      const uniqueFiles = [...new Set(results.map((r) => r.file_path))];
      const ops: ReplaceOp[] = uniqueFiles.map((fp) => ({
        file_path: fp,
        search: query,
        replace: replaceValue,
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        use_regex: useRegex,
      }));
      const result = await api.replaceInFiles(ops);
      console.log(`Replaced ${result.replacements} occurrence(s) in ${result.files_changed} file(s)`);
      doSearch(query, caseSensitive, wholeWord, useRegex);
    } catch (e) {
      console.error("Replace failed:", e);
    } finally {
      setReplacing(false);
    }
  }, [query, replaceValue, results, caseSensitive, wholeWord, useRegex, doSearch]);

  return (
    <div className={`search-view no-select ${flushLeft ? "search-view-flush-left" : ""}`}>
      <div className="search-view-header">
        <span className="search-view-title">Code Search</span>
        <div className="search-view-header-actions">
          <button
            className="search-icon-action"
            onClick={toggleCollapseAll}
            title={allCollapsed ? "Expand all results" : "Collapse all results"}
            disabled={repoGroups.length === 0}
          >
            <span className={`codicon ${allCollapsed ? "codicon-expand-all" : "codicon-collapse-all"}`} />
          </button>
        </div>
      </div>

      <div className="search-widgets-container">
        <div className="search-widget">
          <button
            className="toggle-replace-button"
            onClick={() => {
              setReplaceOpen((value) => !value);
            }}
            title={replaceOpen ? "Hide Replace" : "Show Replace"}
            aria-expanded={replaceOpen}
          >
            <span className={`codicon ${replaceOpen ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
          </button>

          <div className="search-container">
            <div className={`search-input-wrapper ${inputFocused ? "focused" : ""}`}>
              <input
                ref={inputRef}
                type="text"
                placeholder="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onCollapse();
                  }
                }}
                className="search-input"
              />
              <div className="search-input-controls">
                <button
                  className={`monaco-custom-toggle ${caseSensitive ? "checked" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setCaseSensitive((value) => !value)}
                  title={caseSensitive ? "Match Case (on)" : "Match Case"}
                >
                  <span className="codicon codicon-case-sensitive" />
                </button>
                <button
                  className={`monaco-custom-toggle ${wholeWord ? "checked" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setWholeWord((value) => !value)}
                  title={wholeWord ? "Match Whole Word (on)" : "Match Whole Word"}
                >
                  <span className="codicon codicon-whole-word" />
                </button>
                <button
                  className={`monaco-custom-toggle ${useRegex ? "checked" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setUseRegex((value) => !value)}
                  title={useRegex ? "Use Regular Expression (on)" : "Use Regular Expression"}
                >
                  <span className="codicon codicon-regex" />
                </button>
              </div>
            </div>
          </div>

          <div className={`replace-container ${replaceOpen ? "" : "disabled"}`}>
            <div className={`replace-input-wrapper ${replaceInputFocused ? "focused" : ""}`}>
              <input
                type="text"
                placeholder="Replace"
                value={replaceValue}
                onChange={(e) => setReplaceValue(e.target.value)}
                onFocus={() => setReplaceInputFocused(true)}
                onBlur={() => setReplaceInputFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onCollapse();
                  }
                }}
                className="search-input"
              />
              <div className="search-input-controls">
                <button
                  className={`monaco-custom-toggle ${preserveCase ? "checked" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setPreserveCase((value) => !value)}
                  title="Preserve Case (visual only)"
                >
                  <span className="codicon codicon-preserve-case" />
                </button>
              </div>
            </div>

            <div className="replace-actions">
              <button
                className="search-icon-action replace-action"
                onClick={() => void handleReplaceAll()}
                title="Replace All"
                disabled={replaceDisabled}
              >
                <span className="codicon codicon-replace-all" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {hasSearched && query.trim() && (
        <div className="search-results-info">
          {searching
            ? "Searching..."
            : totalResults === 0
              ? "No results found"
              : `${totalResults} result${totalResults !== 1 ? "s" : ""} in ${totalFiles} file${totalFiles !== 1 ? "s" : ""}`}
        </div>
      )}

      <ScrollArea className="search-results">
        {!query.trim() && !hasSearched && (
          <div className="search-empty-message">Type to search across workspace files</div>
        )}
        {hasSearched && !searching && query.trim() && totalResults === 0 && (
          <div className="search-empty-message">No results found</div>
        )}
        {repoGroups.map((repo) => {
          const repoCollapsed = collapsedRepos.has(repo.repoPath);
          return (
            <div key={repo.repoPath}>
              <div className="search-repo-row foldermatch" onClick={() => toggleRepoCollapse(repo.repoPath)}>
                <span className={`search-tree-twistie codicon codicon-chevron-right ${repoCollapsed ? "" : "expanded"}`} />
                <span className="search-repo-icon codicon codicon-folder" />
                <span className="search-repo-name">{repo.repoName}</span>
                <span className="monaco-count-badge search-count-badge">{repo.totalMatches}</span>
              </div>

              {!repoCollapsed && repo.files.map((group) => {
                const isCollapsed = collapsedFiles.has(group.filePath);
                return (
                  <div key={group.filePath}>
                    <div
                      className="search-file-row filematch repo-file-row"
                      onClick={() => toggleFileCollapse(group.filePath)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const prefix = repo.repoPath.endsWith("/") ? repo.repoPath : `${repo.repoPath}/`;
                        const rel = group.filePath.startsWith(prefix)
                          ? group.filePath.slice(prefix.length)
                          : group.filePath;
                        showContextMenu([
                          { label: "Copy Relative Path", action: () => navigator.clipboard.writeText(rel) },
                          { label: "Copy Path", action: () => navigator.clipboard.writeText(group.filePath) },
                        ], { x: e.clientX, y: e.clientY });
                      }}
                    >
                      <span className={`search-tree-twistie codicon codicon-chevron-right ${isCollapsed ? "" : "expanded"}`} />
                      <FileIcon fileName={group.fileName} size={16} style={{ marginRight: 6 }} />
                      <span className="search-file-name">{group.fileName}</span>
                      <span className="search-file-description">{group.fileDescription}</span>
                      <span className="monaco-count-badge search-count-badge">{group.matches.length}</span>
                    </div>
                    {!isCollapsed && group.matches.map((m, index) => (
                      <MatchLine
                        key={`${m.line_number}-${index}`}
                        match={m}
                        onClick={() => handleResultClick(m.file_path, m.line_number)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}

const MatchLine = React.memo(function MatchLine({
  match,
  onClick,
}: {
  match: SearchMatch;
  onClick: () => void;
}) {
  const { line_content, match_start, match_end } = match;
  const hasHighlight = match_end > match_start;

  const before = hasHighlight ? line_content.slice(0, match_start) : line_content;
  const highlighted = hasHighlight ? line_content.slice(match_start, match_end) : "";
  const after = hasHighlight ? line_content.slice(match_end) : "";

  return (
    <div className="search-match-row textsearchresult linematch" onClick={onClick}>
      <a className="plain match">
        <span>{before}</span>
        {hasHighlight && <span className="findInFileMatch">{highlighted}</span>}
        <span>{after}</span>
      </a>
    </div>
  );
});
