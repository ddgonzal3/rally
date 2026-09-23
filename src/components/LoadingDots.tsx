import React from "react";

/** Three pulsing dots (the `claude-dot` keyframes in index.html). */
export function LoadingDots({ size = 8, gap = 8, stagger = 0.2 }: { size?: number; gap?: number; stagger?: number }) {
  return (
    <div style={{ display: "flex", gap }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "var(--text-dim)",
            animation: "claude-dot 1.4s ease-in-out infinite",
            animationDelay: `${i * stagger}s`,
          }}
        />
      ))}
    </div>
  );
}
