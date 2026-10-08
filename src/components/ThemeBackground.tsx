import { useThemeStore } from "../stores/themeStore";
import { useThemeImageUrl } from "../lib/theme/images";

/**
 * The theme's background image, behind everything in the window. Renders
 * nothing without an image, so the native frost shows the desktop as before.
 */
export function ThemeBackground() {
  const image = useThemeStore((s) => String(s.values["background-image"] ?? ""));
  const fit = useThemeStore((s) => String(s.values["background-fit"]));
  const dim = useThemeStore((s) => Number(s.values["background-dim"]));
  const blur = useThemeStore((s) => Number(s.values["background-blur"]));
  const url = useThemeImageUrl(image);
  if (!url) return null;

  const tile = fit === "tile";
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: -1, overflow: "hidden", pointerEvents: "none" }}>
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
        }}
      />
      {dim > 0 && <div style={{ position: "absolute", inset: 0, background: `rgba(0, 0, 0, ${dim / 100})` }} />}
    </div>
  );
}
