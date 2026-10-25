import React from "react";

const actionButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  padding: 0,
  margin: 0,
  background: "none",
  border: "none",
  // Inherit the container's color, which carries the fade.
  color: "inherit",
  cursor: "pointer",
  borderRadius: 3,
  flexShrink: 0,
  lineHeight: 0,
  appearance: "none",
  WebkitAppearance: "none",
};

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <rect x="2" y="2" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path d="M1.5 6a4.5 4.5 0 0 1 8.18-2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.5 6a4.5 4.5 0 0 1-8.18 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.2 1v2.4H7.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.8 11v-2.4h2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Stop/restart icons beside a footer script, revealed on hover.
 *
 * The fade animates `color`, not `opacity`. WebKit runs opacity transitions
 * on a temporary compositing layer and paints the icons back into the parent
 * when the transition ends; at fractional positions (UI zoom, Flight canvas
 * pan/zoom) the two snap to different device pixels, so the icons hopped a
 * pixel right after the reveal. A color fade never leaves normal painting.
 */
export function ScriptActions({
  show,
  canStop,
  onStop,
  onRestart,
}: {
  show: boolean;
  /** Stop is offered while the script runs. Keyed on run state, not `show`,
   *  so the restart icon doesn't jump left while the group fades out. */
  canStop: boolean;
  onStop: () => void;
  onRestart: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        color: show ? "var(--text-secondary)" : "transparent",
        width: show ? (canStop ? 36 : 18) : 0,
        overflow: "hidden",
        transition: "color 0.15s ease, width 0.15s ease",
        pointerEvents: show ? "auto" : "none",
        flexShrink: 0,
        margin: 0,
        padding: 0,
      }}
    >
      {canStop && (
        <button
          className="tab-action"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onStop();
          }}
          title="Stop"
          style={{ ...actionButtonStyle, opacity: 0.88 }}
        >
          <StopIcon />
        </button>
      )}
      <button
        className="tab-action"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRestart();
        }}
        title="Restart"
        style={actionButtonStyle}
      >
        <RestartIcon />
      </button>
    </div>
  );
}
