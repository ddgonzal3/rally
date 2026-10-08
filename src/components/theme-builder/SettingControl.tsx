import { useEffect, useState } from "react";
import type { SettingDef, ThemeValue } from "../../lib/theme/schema";
import { formatColor, parseColor, rgbHex } from "../../lib/theme/color";
import { s } from "./styles";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/tauri";
import { useThemeImageUrl } from "../../lib/theme/images";

interface Props {
  def: SettingDef;
  value: ThemeValue;
  /** Installed font families, for font pickers. */
  fonts: string[];
  onChange: (value: ThemeValue) => void;
}

export function SettingControl({ def, value, fonts, onChange }: Props) {
  switch (def.kind) {
    case "color":
      return <ColorControl value={String(value)} onChange={onChange} />;
    case "number":
      return <NumberControl def={def} value={Number(value)} onChange={onChange} />;
    case "toggle":
      return <Toggle value={value === true} onChange={onChange} />;
    case "choice":
      return <Choice def={def} value={String(value)} onChange={onChange} />;
    case "font":
      return <FontControl def={def} value={String(value)} fonts={fonts} onChange={onChange} />;
    case "image":
      return <ImageControl value={String(value ?? "")} onChange={onChange} />;
  }
}

/** Thumbnail + pick/remove. Picked files are copied into ~/.rally/themes/images. */
function ImageControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const url = useThemeImageUrl(value);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof picked !== "string") return;
    try {
      onChange(await api.importThemeImage(picked));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ ...s.control, flexDirection: "column", alignItems: "flex-end" }}>
      <div style={s.control}>
        <span
          style={{
            width: 64,
            height: 40,
            borderRadius: 5,
            border: "1px solid var(--border-subtle)",
            background: url ? `center / cover no-repeat url("${url}")` : "var(--bg-input)",
            flexShrink: 0,
          }}
        />
        <button style={s.button} onClick={choose}>
          {value ? "Change…" : "Choose…"}
        </button>
        {value && (
          <button style={s.button} onClick={() => onChange("")}>
            Remove
          </button>
        )}
      </div>
      {error && <span style={{ ...s.rowHint, color: "var(--status-red)" }}>{error}</span>}
    </div>
  );
}

/**
 * Swatch (native picker for the color) + text field (any hex or rgba) +
 * opacity slider. The native picker has no alpha, so opacity is separate.
 */
function ColorControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseColor(value);
  const [text, setText] = useState(value);
  // Follow outside changes (reset, theme switch) unless the field holds an unfinished edit.
  useEffect(() => setText(value), [value]);
  const valid = parseColor(text) !== null;

  return (
    <div style={s.control}>
      <label style={s.swatch} title="Pick a color">
        <span style={{ position: "absolute", inset: 0, background: value }} />
        <input
          type="color"
          value={parsed ? rgbHex(parsed) : "#000000"}
          onChange={(e) => {
            const picked = parseColor(e.target.value);
            if (picked) onChange(formatColor({ ...picked, a: parsed?.a ?? 1 }));
          }}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
        />
      </label>
      <input
        style={{ ...s.input, width: 168, fontFamily: "var(--font-mono)", borderColor: valid ? undefined : "var(--status-red)" }}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const c = parseColor(e.target.value);
          if (c) onChange(formatColor(c));
        }}
        onBlur={() => setText(value)}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round((parsed?.a ?? 1) * 100)}
        disabled={!parsed}
        title="Opacity"
        onChange={(e) => parsed && onChange(formatColor({ ...parsed, a: Number(e.target.value) / 100 }))}
        style={{ width: 64 }}
      />
      <span style={{ ...s.rowHint, width: 32, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {Math.round((parsed?.a ?? 1) * 100)}%
      </span>
    </div>
  );
}

function NumberControl({ def, value, onChange }: { def: SettingDef; value: number; onChange: (v: number) => void }) {
  const step = def.step ?? 1;
  const decimals = step < 1 ? String(step).split(".")[1]?.length ?? 2 : 0;
  return (
    <div style={s.control}>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 180 }}
      />
      <span style={{ ...s.rowHint, width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {value.toFixed(decimals)}
        {def.unit ?? ""}
      </span>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      style={{ ...s.switch, background: value ? "var(--bg-active)" : "var(--bg-input)" }}
    >
      <span style={{ ...s.switchThumb, opacity: value ? 1 : 0.5, transform: value ? "translateX(14px)" : "translateX(0)" }} />
    </button>
  );
}

function Choice({ def, value, onChange }: { def: SettingDef; value: string; onChange: (v: string) => void }) {
  return (
    <div style={s.segment}>
      {def.options?.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            ...s.segmentBtn,
            background: o.value === value ? "var(--bg-active)" : "transparent",
            color: o.value === value ? "var(--text-primary)" : "var(--text-secondary)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Free-text CSS font list, with installed families suggested. Picking a
 * suggestion keeps a generic fallback so a missing font degrades gracefully.
 */
function FontControl({ def, value, fonts, onChange }: { def: SettingDef; value: string; fonts: string[]; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const listId = `fonts-${def.key}`;
  const fallback = def.mono ? "monospace" : "sans-serif";

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // A bare family picked from the list gets quoted and a fallback appended.
    const font = fonts.includes(trimmed) ? `'${trimmed}', ${fallback}` : trimmed;
    onChange(font);
  };

  return (
    <div style={s.control}>
      <input
        list={listId}
        style={{ ...s.input, width: 280, fontFamily: value }}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (fonts.includes(e.target.value.trim())) commit(e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && commit(text)}
        onBlur={() => commit(text)}
      />
      <datalist id={listId}>
        {fonts.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </div>
  );
}
