import React from "react";
import { LoadingDots } from "./LoadingDots";

interface ClaudeLauncherProps {
  workspacePath: string;
  onLaunch: () => void;
  /** Start Claude with `--continue`: resumes the most recent conversation in
   *  this folder, or starts a new one when there is none. */
  onContinue: () => void;
  /** A ⌘K task is being set up here: show its progress instead of the
   *  launch actions, which would race the task's own Claude launch. */
  setup?: { text: string; busy: boolean; prompt?: string } | null;
  /** Re-run a stopped setup from the step that failed. */
  onRetry?: () => void;
}

function folderName(p: string): string {
  return p.split("/").pop() || p;
}

export const ClaudeLauncher = React.memo(function ClaudeLauncher({
  workspacePath,
  onLaunch,
  onContinue,
  setup,
  onRetry,
}: ClaudeLauncherProps) {
  return (
    <div style={styles.container}>
      {/* Main launch area — clicking here starts Claude */}
      <div
        className={setup ? undefined : "launch-btn"}
        style={{ ...styles.mainArea, cursor: setup ? "default" : "pointer" }}
        onClick={setup ? undefined : () => onLaunch()}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="var(--text-secondary)"
          fillRule="evenodd"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
        </svg>
        <span style={styles.name}>Claude</span>
        <span style={styles.path}>{folderName(workspacePath)}</span>
      </div>

      <div style={styles.secondary}>
        {setup ? (
          <div style={styles.setup}>
            {setup.busy && <LoadingDots />}
            <span style={styles.setupText}>{setup.text}</span>
            {setup.prompt && <span style={styles.setupPrompt}>{setup.prompt}</span>}
            {!setup.busy && onRetry && (
              <span style={styles.trigger} onClick={onRetry}>
                Retry
              </span>
            )}
          </div>
        ) : (
          <span
            style={styles.trigger}
            title="Resume the most recent Claude conversation in this folder"
            onClick={onContinue}
          >
            or continue last session
          </span>
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
    paddingBottom: "5%",
    background: "var(--bg-app)",
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
    color: "var(--text-primary)",
    letterSpacing: "0.01em",
    lineHeight: 1,
  },
  path: {
    fontSize: 12,
    color: "var(--text-secondary)",
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  secondary: {
    marginTop: 2,
    textAlign: "center",
  },
  setup: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
  },
  setupText: {
    maxWidth: 360,
    textAlign: "center",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-dim)",
    letterSpacing: "0.02em",
  },
  setupPrompt: {
    maxWidth: 420,
    maxHeight: 160,
    overflowY: "auto",
    textAlign: "center",
    whiteSpace: "pre-wrap",
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-secondary)",
    lineHeight: 1.45,
    // The prompt is the one thing here worth copying.
    userSelect: "text",
    WebkitUserSelect: "text",
    cursor: "text",
  },
  trigger: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-dim)",
    cursor: "pointer",
    letterSpacing: "0.02em",
  },
};
