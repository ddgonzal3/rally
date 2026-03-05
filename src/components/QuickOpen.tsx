import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../lib/tauri";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FileIcon } from "./FileIcon";

interface QuickOpenBaseProps {
  visible: boolean;
  onClose: () => void;
}

interface FileQuickOpenProps extends QuickOpenBaseProps {
  mode?: "files";
}

interface CwdQuickOpenProps extends QuickOpenBaseProps {
  mode: "cwd";
  cwdOptions: string[];
  onSelectCwd: (cwd: string) => void;
  placeholder?: string;
}

type QuickOpenProps = FileQuickOpenProps | CwdQuickOpenProps;

// --- Fuzzy matching ---

interface FuzzyResult {
  score: number;
  indices: number[];
}

function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;

  for (let ti = 0; ti < target.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) {
      indices.push(ti);
      if (lastMatchIndex === ti - 1) score += 10;
      if (ti === 0 || "/\\-_ .".includes(target[ti - 1])) score += 5;
      if (target[ti] === query[qi]) score += 3;
      if (lastMatchIndex >= 0) {
        const gap = ti - lastMatchIndex - 1;
        if (gap > 0) score -= gap;
      }
      lastMatchIndex = ti;
      qi++;
    }
  }

  if (qi < lowerQuery.length) return null;
  return { score, indices };
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

// --- Highlighted text with VS Code-style blue highlights ---

function HighlightedText({
  text,
  indices,
}: {
  text: string;
  indices: Set<number>;
}) {
  const spans: React.ReactNode[] = [];
  let run = "";
  let runHighlighted = false;

  for (let i = 0; i <= text.length; i++) {
    const isHighlighted = indices.has(i);
    if (i === text.length || isHighlighted !== runHighlighted) {
      if (run) {
        spans.push(
          runHighlighted ? (
            <span key={i} style={{ color: "#2aaaff", fontWeight: 700 }}>
              {run}
            </span>
          ) : (
            <span key={i}>{run}</span>
          ),
        );
      }
      run = i < text.length ? text[i] : "";
      runHighlighted = isHighlighted;
    } else {
      run += text[i];
    }
  }

  return <>{spans}</>;
}

function FolderRowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M2 4.5C2 3.67 2.67 3 3.5 3H6.4L7.5 4.3H12.5C13.33 4.3 14 4.97 14 5.8V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
        stroke="#8aa9d6"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Component ---

const MAX_RESULTS = 50;

interface QuickOpenResult {
  key: string;
  primaryText: string;
  secondaryText: string;
  score: number;
  matchIndices: Set<number>;
  icon: "file" | "folder";
  onSelect: () => void;
}

export default function QuickOpen(props: QuickOpenProps) {
  const { visible, onClose } = props;
  const mode = props.mode ?? "files";
  const isCwdMode = mode === "cwd";
  const cwdProps: CwdQuickOpenProps | null =
    props.mode === "cwd" ? props : null;

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [allFiles, setAllFiles] = useState<string[]>([]);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspacePaths = ws?.paths ?? [];
  const cacheKey = [...workspacePaths].sort().join("\n");

  useEffect(() => {
    if (!visible || isCwdMode || workspacePaths.length === 0) return;
    let cancelled = false;
    api.listAllFiles(workspacePaths).then((files) => {
      if (cancelled) return;
      setAllFiles(files);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, isCwdMode, cacheKey, workspacePaths]);

  useEffect(() => {
    if (visible) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible, mode]);

  const rootPrefix = useMemo(() => {
    if (workspacePaths.length === 1) return workspacePaths[0];
    if (workspacePaths.length === 0) return "";
    const sorted = [...workspacePaths].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let i = 0;
    while (i < first.length && first[i] === last[i]) i++;
    return first.substring(0, first.lastIndexOf("/", i) + 1);
  }, [workspacePaths]);

  const cwdOptions: string[] = cwdProps?.cwdOptions ?? [];

  const homePrefix = useMemo(() => {
    if (!isCwdMode) return "";
    for (const cwd of cwdOptions) {
      const match = cwd.match(/^\/Users\/[^/]+/);
      if (match) return match[0];
    }
    return "";
  }, [isCwdMode, cwdOptions]);

  const results = useMemo<QuickOpenResult[]>(() => {
    const trimmedQuery = query.trim();

    if (isCwdMode) {
      if (!cwdProps) return [];

      const withMeta = cwdOptions.map((cwd, order) => {
        const name = baseName(cwd);
        const parent = parentDir(cwd);
        const secondary = homePrefix && parent.startsWith(homePrefix)
          ? `~${parent.slice(homePrefix.length)}`
          : parent;

        return {
          cwd,
          name,
          secondary,
          order,
        };
      });

      if (!trimmedQuery) {
        return withMeta.slice(0, MAX_RESULTS).map((item) => ({
          key: item.cwd,
          primaryText: item.name,
          secondaryText: item.secondary,
          score: 0,
          matchIndices: new Set<number>(),
          icon: "folder",
          onSelect: () => {
            cwdProps.onSelectCwd(item.cwd);
            onClose();
          },
        }));
      }

      const scored: Array<QuickOpenResult & { order: number }> = [];
      for (const item of withMeta) {
        const nameMatch = fuzzyMatch(trimmedQuery, item.name);
        const pathMatch = fuzzyMatch(trimmedQuery, item.cwd);
        if (!nameMatch && !pathMatch) continue;

        const score =
          (nameMatch?.score ?? 0) +
          (pathMatch && !nameMatch ? pathMatch.score - 8 : 0) +
          Math.max(0, 20 - item.name.length);

        scored.push({
          key: item.cwd,
          primaryText: item.name,
          secondaryText: item.secondary,
          score,
          matchIndices: new Set<number>(nameMatch?.indices ?? []),
          icon: "folder",
          order: item.order,
          onSelect: () => {
            cwdProps.onSelectCwd(item.cwd);
            onClose();
          },
        });
      }

      scored.sort((a, b) => b.score - a.score || a.order - b.order);
      const filtered = scored
        .slice(0, MAX_RESULTS)
        .map(({ order: _order, ...rest }) => rest);

      return filtered;
    }

    if (!trimmedQuery) {
      return allFiles.slice(0, MAX_RESULTS).map((filePath) => {
        const fileName = baseName(filePath);
        const relPath = rootPrefix
          ? filePath.substring(rootPrefix.length).replace(/^\//, "")
          : filePath;
        const dirPath = relPath.substring(0, relPath.lastIndexOf("/"));
        const pathDisplay = dirPath ? dirPath.split("/").join(" \u203A ") : "";

        return {
          key: filePath,
          primaryText: fileName,
          secondaryText: pathDisplay,
          score: 0,
          matchIndices: new Set<number>(),
          icon: "file" as const,
          onSelect: () => {
            if (activeWorkspaceId) openFile(activeWorkspaceId, filePath);
            onClose();
          },
        };
      });
    }

    const scored: QuickOpenResult[] = [];

    for (const filePath of allFiles) {
      const fileName = baseName(filePath);
      const match = fuzzyMatch(trimmedQuery, fileName);
      if (!match) continue;

      const relPath = rootPrefix
        ? filePath.substring(rootPrefix.length).replace(/^\//, "")
        : filePath;
      const dirPath = relPath.substring(0, relPath.lastIndexOf("/"));
      const pathDisplay = dirPath ? dirPath.split("/").join(" \u203A ") : "";
      const lengthBonus = Math.max(0, 20 - fileName.length);

      scored.push({
        key: filePath,
        primaryText: fileName,
        secondaryText: pathDisplay,
        score: match.score + lengthBonus,
        matchIndices: new Set(match.indices),
        icon: "file",
        onSelect: () => {
          if (activeWorkspaceId) openFile(activeWorkspaceId, filePath);
          onClose();
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [
    query,
    isCwdMode,
    cwdOptions,
    homePrefix,
    allFiles,
    rootPrefix,
    cwdProps,
    activeWorkspaceId,
    openFile,
    onClose,
  ]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!resultsRef.current) return;
    const selected = resultsRef.current.children[selectedIndex] as
      | HTMLElement
      | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback((result: QuickOpenResult) => {
    result.onSelect();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) handleSelect(results[selectedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, handleSelect, onClose],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  if (!visible) return null;

  const placeholder = isCwdMode
    ? cwdProps?.placeholder ?? "Select current working directory for new terminal"
    : "Search files by name (append : to go to line or @ to go to symbol)";

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} style={styles.overlay}>
      <div style={styles.modal} onKeyDown={handleKeyDown}>
        <div style={styles.inputRow}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={placeholder}
            style={styles.input}
          />
        </div>
        <div ref={resultsRef} style={styles.resultsList}>
          {results.length === 0 && query.trim() ? (
            <div style={styles.emptyMsg}>
              {isCwdMode ? "No matching folders" : "No matching files"}
            </div>
          ) : (
            results.map((result, i) => {
              const isFocused = i === selectedIndex;
              return (
                <div
                  key={result.key}
                  onClick={() => handleSelect(result)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  style={{
                    ...styles.resultItem,
                    background: isFocused ? "#04395e" : "transparent",
                  }}
                >
                  {result.icon === "file" ? (
                    <FileIcon fileName={result.primaryText} size={16} />
                  ) : (
                    <FolderRowIcon />
                  )}
                  <span style={styles.resultFileName}>
                    <HighlightedText
                      text={result.primaryText}
                      indices={result.matchIndices}
                    />
                  </span>
                  {result.secondaryText && (
                    <span style={styles.resultPath}>{result.secondaryText}</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 2550,
    display: "flex",
    justifyContent: "center",
    background: "transparent",
  },
  modal: {
    position: "absolute",
    top: "24%",
    width: "min(62%, 700px)",
    maxHeight: "min(36vh, 430px)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    overflow: "hidden",
    boxShadow: "0 5px 18px var(--shadow)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: 13,
  },
  inputRow: {
    padding: "6px 6px 4px",
  },
  input: {
    width: "100%",
    background: "var(--bg-input)",
    border: "1px solid #007acc",
    color: "var(--text-primary)",
    fontSize: 14,
    fontWeight: 550,
    padding: "5px 8px",
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    borderRadius: 2,
    height: 30,
  },
  resultsList: {
    overflowY: "auto",
    flex: 1,
    padding: "0 6px 7px",
  },
  resultItem: {
    padding: "0 8px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    lineHeight: "26px",
    borderRadius: 4,
    marginBottom: 1,
  },
  resultFileName: {
    fontSize: 13,
    color: "var(--text-primary)",
    fontWeight: 625,
    flexShrink: 0,
  },
  resultPath: {
    fontSize: 13,
    color: "var(--text-secondary)",
    fontWeight: 450,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    marginLeft: "0.5em",
  },
  emptyMsg: {
    padding: "16px 12px",
    textAlign: "center",
    color: "var(--text-dim)",
    fontSize: 13,
  },
};
