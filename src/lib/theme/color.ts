/** Minimal color parsing for theme values: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(). */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255) : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) {
    return {
      r: clamp(Number(fn[1]), 0, 255),
      g: clamp(Number(fn[2]), 0, 255),
      b: clamp(Number(fn[3]), 0, 255),
      a: fn[4] === undefined ? 1 : clamp(Number(fn[4]), 0, 1),
    };
  }
  return null;
}

/** `#rrggbb` when opaque, else `rgba(...)`: the form people read most easily. */
export function formatColor(c: Rgba): string {
  if (c.a >= 1) return rgbHex(c);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${round(c.a)})`;
}

/** `#rrggbb`, ignoring alpha. Native color inputs only take this form. */
export function rgbHex(c: Rgba): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** `#rrggbbaa`, for consumers (Monaco) that don't take rgba(). */
export function hex8(c: Rgba): string {
  return rgbHex(c) + Math.round(c.a * 255).toString(16).padStart(2, "0");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
