import React from "react";
import type { DetectedPort } from "../lib/types";

interface PortPillProps {
  port: DetectedPort;
  onClick: (url: string) => void;
}

export function PortPill({ port: p, onClick }: PortPillProps) {
  return (
    <span
      key={p.port}
      onClick={(e) => {
        e.stopPropagation();
        onClick(p.url);
      }}
      title={`Open ${p.url}`}
      style={pillStyle}
    >
      :{p.port}
    </span>
  );
}

const pillStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--status-green)",
  cursor: "pointer",
  marginLeft: 4,
  flexShrink: 0,
  lineHeight: 1,
};
