import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../lib/tauri";
import { openUrl } from "../lib/tauri";

interface WebViewPaneProps {
  url: string;
  paneId: string;
}

/** Returns true if the URL points to a localhost server */
function isLocalhostUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url);
}

/** Returns true if the URL is a local file path (not a URL) */
function isFilePath(url: string): boolean {
  return url.startsWith("/") || url.startsWith("~");
}

const ZOOM_LEVELS = [0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function nearestZoomIndex(current: number): number {
  let best = 0;
  let bestDist = Math.abs(ZOOM_LEVELS[0] - current);
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    const dist = Math.abs(ZOOM_LEVELS[i] - current);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

export function WebViewPane({ url, paneId }: WebViewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  // For localhost URLs: track whether the server is reachable
  const [serverUp, setServerUp] = useState<boolean | null>(null); // null = checking
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Normalize URL: if user typed "localhost:3000", prepend http://
  const iframeSrc = isFilePath(url) ? undefined
    : url.startsWith("http") ? url
    : `http://${url}`;

  const isLocalhost = isLocalhostUrl(iframeSrc ?? url);

  // Poll localhost to check if server is up
  useEffect(() => {
    if (!isLocalhost || !iframeSrc) return;
    let cancelled = false;

    const check = async () => {
      try {
        await fetch(iframeSrc, { mode: "no-cors", cache: "no-store" });
        if (!cancelled) {
          setServerUp(true);
          // Stop polling once server is confirmed up
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch {
        if (!cancelled) setServerUp(false);
      }
    };

    check();
    // Keep polling while server is down so we auto-recover when it starts
    pollRef.current = setInterval(check, 3000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isLocalhost, iframeSrc, refreshKey]);

  // For local HTML files, read the content via Tauri
  useEffect(() => {
    if (!isFilePath(url)) return;
    let cancelled = false;
    api.readFileContent(url).then((content) => {
      if (!cancelled) setSrcdoc(content);
    }).catch((err) => {
      if (!cancelled) setError(`Failed to read file: ${err}`);
    });
    return () => { cancelled = true; };
  }, [url, refreshKey]);

  const handleRefresh = useCallback(() => {
    if (isFilePath(url)) {
      setRefreshKey((k) => k + 1);
    } else if (isLocalhost) {
      setServerUp(null);
      setRefreshKey((k) => k + 1);
    } else if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  }, [url, isLocalhost]);

  const handleOpenInBrowser = useCallback(() => {
    if (isLocalhostUrl(url)) {
      openUrl(url);
    }
  }, [url]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => {
      const idx = nearestZoomIndex(z);
      return ZOOM_LEVELS[Math.min(idx + 1, ZOOM_LEVELS.length - 1)];
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => {
      const idx = nearestZoomIndex(z);
      return ZOOM_LEVELS[Math.max(idx - 1, 0)];
    });
  }, []);

  const handleZoomReset = useCallback(() => {
    setZoom(1);
  }, []);

  // Execute search in iframe using window.find() — a non-standard but
  // widely-supported API. TypeScript doesn't include it in its DOM types.
  const executeSearch = useCallback((query: string) => {
    if (!iframeRef.current) return;
    try {
      const w = iframeRef.current.contentWindow as any;
      if (w) {
        w.getSelection()?.removeAllRanges();
        if (query) {
          w.find(query, false, false, true);
        }
      }
    } catch {
      // Cross-origin iframe — can't search
    }
  }, []);

  const handleSearchNext = useCallback(() => {
    if (!searchQuery || !iframeRef.current) return;
    try {
      const w = iframeRef.current.contentWindow as any;
      if (w) w.find(searchQuery, false, false, true);
    } catch {}
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    if (!searchQuery || !iframeRef.current) return;
    try {
      const w = iframeRef.current.contentWindow as any;
      if (w) w.find(searchQuery, false, true, true);
    } catch {}
  }, [searchQuery]);

  // Keyboard shortcuts: Cmd+R (reload), Cmd+F (find), Cmd+=/- (zoom)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle when this pane is focused
      const el = containerRef.current;
      if (!el) return;
      if (!el.contains(document.activeElement) && document.activeElement !== document.body) return;

      if (!e.metaKey) return;

      if (e.key === "r") {
        e.preventDefault();
        e.stopPropagation();
        handleRefresh();
      } else if (e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        e.stopPropagation();
        handleZoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        handleZoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        handleZoomReset();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleRefresh, handleZoomIn, handleZoomOut, handleZoomReset]);

  const showPlaceholder = isLocalhost && !serverUp;

  return (
    <div ref={containerRef} style={styles.container} tabIndex={-1}>
      <div style={styles.toolbar}>
        <span style={styles.url} title={url}>
          {url}
        </span>
        <div style={styles.actions}>
          {/* Zoom controls */}
          <button style={styles.toolbarBtn} onClick={handleZoomOut} title="Zoom out (Cmd+-)">
            <ZoomOutIcon />
          </button>
          <button
            style={{ ...styles.toolbarBtn, fontSize: 10, color: "var(--text-dim)", width: "auto", padding: "0 2px", minWidth: 32, cursor: "pointer" }}
            onClick={handleZoomReset}
            title="Reset zoom (Cmd+0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button style={styles.toolbarBtn} onClick={handleZoomIn} title="Zoom in (Cmd+=)">
            <ZoomInIcon />
          </button>
          <div style={{ width: 1, height: 14, background: "var(--border)", margin: "0 2px" }} />
          {/* Search */}
          <button style={styles.toolbarBtn} onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50); }} title="Find (Cmd+F)">
            <SearchIcon />
          </button>
          <button
            style={styles.toolbarBtn}
            onClick={handleRefresh}
            title="Refresh (Cmd+R)"
          >
            <RefreshIcon />
          </button>
          {isLocalhost && (
            <button
              style={styles.toolbarBtn}
              onClick={handleOpenInBrowser}
              title="Open in Browser"
            >
              <ExternalLinkIcon />
            </button>
          )}
        </div>
      </div>
      {/* Search bar */}
      {searchOpen && (
        <div style={styles.searchBar}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              executeSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) handleSearchPrev();
                else handleSearchNext();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder="Find in page..."
            style={styles.searchInput}
          />
          <button style={styles.searchBtn} onClick={handleSearchPrev} title="Previous (Shift+Enter)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button style={styles.searchBtn} onClick={handleSearchNext} title="Next (Enter)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button style={styles.searchBtn} onClick={() => { setSearchOpen(false); setSearchQuery(""); }} title="Close">
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round"/></svg>
          </button>
        </div>
      )}
      {error ? (
        <div style={styles.error}>{error}</div>
      ) : showPlaceholder ? (
        <div style={styles.placeholder}>
          <div style={styles.placeholderIcon}>
            <GlobeOffIcon />
          </div>
          <div style={styles.placeholderText}>
            {serverUp === null ? "Connecting..." : "No server running"}
          </div>
          <div style={styles.placeholderUrl}>{iframeSrc}</div>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
          <iframe
            ref={iframeRef}
            key={refreshKey}
            src={iframeSrc}
            srcDoc={srcdoc ?? undefined}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{
              ...styles.iframe,
              transform: `scale(${zoom})`,
              transformOrigin: "0 0",
              width: `${100 / zoom}%`,
              height: `${100 / zoom}%`,
            }}
            title={`WebView: ${url}`}
          />
        </div>
      )}
    </div>
  );
}

// --- Icons (14×14, neutral color matching neighboring icons) ---

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.28-3.52"
        stroke="var(--text-dim)"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M13.5 3v1.5H12"
        stroke="var(--text-dim)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M6.5 3.5H3.5v9h9v-3"
        stroke="var(--text-dim)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M10 2.5h3.5V6M13.5 2.5 7.5 8.5"
        stroke="var(--text-dim)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GlobeOffIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9.5" stroke="var(--text-dim)" strokeWidth="1.5" />
      <ellipse cx="12" cy="12" rx="4" ry="9.5" stroke="var(--text-dim)" strokeWidth="1.5" />
      <line x1="2.5" y1="12" x2="21.5" y2="12" stroke="var(--text-dim)" strokeWidth="1.5" />
      <line x1="4" y1="4" x2="20" y2="20" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="var(--text-dim)" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 7h4M7 5v4" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="var(--text-dim)" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 7h4" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="var(--text-dim)" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    outline: "none",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-secondary)",
    flexShrink: 0,
    minHeight: 28,
  },
  url: {
    flex: 1,
    fontSize: 12,
    fontFamily: "var(--font-mono, monospace)",
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 2,
  },
  toolbarBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    border: "none",
    background: "transparent",
    borderRadius: 4,
    cursor: "pointer",
    padding: 0,
  },
  iframe: {
    flex: 1,
    width: "100%",
    height: "100%",
    border: "none",
    background: "#fff",
  },
  placeholder: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: "var(--bg-primary)",
  },
  placeholderIcon: {
    opacity: 0.4,
    marginBottom: 4,
  },
  placeholderText: {
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-secondary)",
  },
  placeholderUrl: {
    fontSize: 12,
    fontFamily: "var(--font-mono, monospace)",
    color: "var(--text-dim)",
  },
  error: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-secondary)",
    fontSize: 13,
    padding: 20,
    background: "var(--bg-primary)",
  },
  searchBar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid var(--border-subtle)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    outline: "none",
    fontFamily: "inherit",
  },
  searchBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    border: "none",
    background: "transparent",
    borderRadius: 4,
    cursor: "pointer",
    padding: 0,
  },
};
