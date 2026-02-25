import React, { useState, useRef, useEffect } from "react";

interface TerminalLauncherProps {
  workspacePath: string;
  workspacePaths: string[];
  onLaunch: (cwd?: string) => void;
  onLaunchClaude: (cwd?: string) => void;
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

function folderName(p: string): string {
  return p.split("/").pop() || p;
}

export const TerminalLauncher = React.memo(function TerminalLauncher({
  workspacePath,
  workspacePaths,
  onLaunch,
  onLaunchClaude,
}: TerminalLauncherProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const paths = workspacePaths.length > 0 ? workspacePaths : [workspacePath];

  return (
    <div style={styles.container}>
      <div className="launch-btn" style={styles.mainArea} onClick={() => onLaunch()}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#c5c5c5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span style={styles.name}>Terminal</span>
        <span style={styles.path}>{folderName(workspacePath)}</span>
      </div>

      <div ref={dropdownRef} style={styles.dropdownWrapper}>
        <span style={styles.trigger} onClick={() => setOpen((v) => !v)}>
          or open ▾
        </span>
        {open && (
          <div style={styles.menu}>
            {/* Terminal section */}
            <div style={styles.menuSection}>Terminal</div>
            {paths.map((p) => (
              <div
                key={`term-${p}`}
                className="sidebar-btn"
                style={styles.menuItem}
                onClick={() => { setOpen(false); onLaunch(p); }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <rect x="1" y="2" width="14" height="12" rx="2" stroke="#5ec46a" strokeWidth="1.2" />
                  <path d="M4 7l2.5 2L4 11" stroke="#5ec46a" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="8" y1="11" x2="11" y2="11" stroke="#5ec46a" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                <span style={styles.menuItemText}>{folderName(p)}</span>
                {paths.length > 1 && <span style={styles.menuItemPath}>{shortenPath(p)}</span>}
              </div>
            ))}

            <div style={styles.menuDivider} />

            {/* Claude Code section */}
            <div style={styles.menuSection}>Claude Code</div>
            {paths.map((p) => (
              <div
                key={`claude-${p}`}
                className="sidebar-btn"
                style={styles.menuItem}
                onClick={() => { setOpen(false); onLaunchClaude(p); }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="#e08a5e" style={{ flexShrink: 0 }}>
                  <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
                </svg>
                <span style={styles.menuItemText}>{folderName(p)}</span>
                {paths.length > 1 && <span style={styles.menuItemPath}>{shortenPath(p)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: "21%",
    background: "#1b1b1b",
    minHeight: 0,
    minWidth: 0,
    gap: 0,
    userSelect: "none",
  },
  mainArea: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
    padding: "16px 16px 0 16px",
  },
  name: {
    fontSize: 20,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontWeight: 400,
    color: "#ffffffff",
    letterSpacing: "0.01em",
    lineHeight: 1,
  },
  path: {
    fontSize: 12,
    color: "#ccccccff",
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  dropdownWrapper: {
    position: "relative",
    marginTop: 2,
  },
  trigger: {
    fontSize: 13,
    fontWeight: 600,
    color: "#888",
    cursor: "pointer",
    letterSpacing: "0.02em",
  },
  menu: {
    position: "absolute",
    bottom: "calc(100% + 4px)",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(36, 36, 36, 0.78)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: 6,
    padding: "4px 0",
    minWidth: 180,
    zIndex: 20,
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  },
  menuSection: {
    padding: "5px 12px 3px",
    fontSize: 10,
    fontWeight: 600,
    color: "#fff",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  menuDivider: {
    height: 1,
    background: "rgba(255, 255, 255, 0.1)",
    margin: "4px 0",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 12px",
    fontSize: 12,
    color: "#ddd",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    background: "none",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
  },
  menuItemText: {
    fontWeight: 500,
  },
  menuItemPath: {
    fontSize: 11,
    color: "#888",
    marginLeft: "auto",
    paddingLeft: 8,
  },
};
