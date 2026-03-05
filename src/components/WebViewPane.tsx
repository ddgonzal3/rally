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

export function WebViewPane({ url, paneId }: WebViewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // For localhost URLs: track whether the server is reachable
  const [serverUp, setServerUp] = useState<boolean | null>(null); // null = checking
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        if (!cancelled) setServerUp(true);
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

  const showPlaceholder = isLocalhost && !serverUp;

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.url} title={url}>
          {url}
        </span>
        <div style={styles.actions}>
          <button
            style={styles.toolbarBtn}
            onClick={handleRefresh}
            title="Refresh"
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
        <iframe
          ref={iframeRef}
          key={refreshKey}
          src={iframeSrc}
          srcDoc={srcdoc ?? undefined}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          style={styles.iframe}
          title={`WebView: ${url}`}
        />
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

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    overflow: "hidden",
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
};
