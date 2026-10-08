import { useThemeStore } from "../stores/themeStore";
import { useThemeImageUrl } from "../lib/theme/images";

/**
 * Rally's own background, behind everything in the window: an optional
 * gradient, an optional image on top of it, then dim and grain. Renders
 * nothing when neither is set, so the native frost shows the desktop.
 */
export function ThemeBackground() {
  const v = useThemeStore((s) => s.values);
  const url = useThemeImageUrl(String(v["background-image"] ?? ""));
  const gradient = v["background-gradient"] === true;
  if (!url && !gradient) return null;

  const fit = String(v["background-fit"]);
  const tile = fit === "tile";
  const dim = Number(v["background-dim"]);
  const blur = Number(v["background-blur"]);
  const rotated = String(v["image-rotation"]) === "180";

  return (
    // isolation: blend modes mix the image with the gradient only, never the window behind.
    <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: -1, overflow: "hidden", pointerEvents: "none", isolation: "isolate" }}>
      {gradient && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse 70% 60% at 15% 15%, ${v["gradient-glow"]}, transparent 70%), linear-gradient(${Number(v["gradient-angle"])}deg, ${v["gradient-start"]}, ${v["gradient-middle"]} 50%, ${v["gradient-end"]})`,
          }}
        />
      )}
      {url && (
        <div
          style={{
            position: "absolute",
            // Blur pulls transparent pixels in at the edges; overscan hides that.
            inset: blur > 0 ? -blur * 2 : 0,
            backgroundImage: `url("${url}")`,
            backgroundSize: tile ? "auto" : fit,
            backgroundRepeat: tile ? "repeat" : "no-repeat",
            backgroundPosition: "center",
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            opacity: Number(v["image-opacity"]) / 100,
            mixBlendMode: String(v["image-blend"]) as React.CSSProperties["mixBlendMode"],
            transform: rotated ? "rotate(180deg)" : undefined,
          }}
        />
      )}
      {dim > 0 && <div style={{ position: "absolute", inset: 0, background: `rgba(0, 0, 0, ${dim / 100})` }} />}
      {/* "none" when grain is 0; see grainImage in lib/theme/apply.ts. */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: "var(--surface-grain)" }} />
    </div>
  );
}
