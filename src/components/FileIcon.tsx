import React from "react";
import { getFileIcon } from "../lib/fileIcons";

interface FileIconProps {
  fileName: string;
  size?: number;
  style?: React.CSSProperties;
}

/** Renders a Seti file-type icon for the given filename. */
export const FileIcon = React.memo(function FileIcon({ fileName, size = 16, style }: FileIconProps) {
  const icon = getFileIcon(fileName);
  return (
    <span
      style={{
        fontFamily: "seti",
        fontSize: size * 1.5, // seti font is designed at 150% size
        lineHeight: `${size}px`,
        color: icon.color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        flexShrink: 0,
        ...style,
      }}
      aria-hidden="true"
    >
      {icon.ch}
    </span>
  );
});
