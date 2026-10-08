import { useEffect, useMemo, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useThemeStore } from "../../stores/themeStore";
import { BUILTIN_IDS, BUILTIN_THEMES } from "../../lib/theme/builtins";
import { SETTINGS, SETTING_GROUPS, type SettingDef, type Theme } from "../../lib/theme/schema";
import { showContextMenu } from "../../lib/contextMenu";
import { api } from "../../lib/tauri";
import { SettingControl } from "./SettingControl";
import { s } from "./styles";

/**
 * Theme builder window (opened from the tool rail). Edits apply live to every
 * Rally window; the active user theme saves to ~/.rally/themes as you go.
 */
export function ThemeBuilder() {
  const themes = useThemeStore((st) => st.themes);
  const activeId = useThemeStore((st) => st.activeId);
  const values = useThemeStore((st) => st.values);
  const setValue = useThemeStore((st) => st.setValue);
  const [query, setQuery] = useState("");
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    api.listFontFamilies().then(setFonts, (e) => console.error("[rally] listing fonts failed:", e));
  }, []);

  const active = themes.find((t) => t.id === activeId);
  const builtin = BUILTIN_IDS.has(activeId);
  // "Reset" goes back to the built-in this theme's appearance is based on.
  const baseValues = useMemo(
    () => (BUILTIN_THEMES.find((t) => t.id === activeId) ?? BUILTIN_THEMES.find((t) => t.id === (values.appearance === "light" ? "light" : "dark"))!).values,
    [activeId, values.appearance],
  );

  const q = query.trim().toLowerCase();
  const visible = q ? SETTINGS.filter((d) => `${d.group} ${d.label} ${d.key}`.toLowerCase().includes(q)) : SETTINGS;
  const groups = SETTING_GROUPS.map((g) => [g, visible.filter((d) => d.group === g)] as const).filter(([, defs]) => defs.length > 0);

  return (
    <div style={s.window}>
      <div
        data-tauri-drag-region
        style={s.titlebar}
        onMouseDown={(e) => {
          if (e.button === 0 && !(e.target as HTMLElement).closest("button, input")) void getCurrentWebviewWindow().startDragging();
        }}
      >
        <span style={s.titleText}>Theme Builder</span>
      </div>
      <div style={s.columns}>
        <ThemeList themes={themes} activeId={activeId} />
        <div style={s.main}>
          <div style={s.mainHeader}>
            <NameField theme={active} builtin={builtin} />
            <input style={{ ...s.input, width: "100%" }} placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div style={s.mainBody}>
            {groups.length === 0 && <div style={s.empty}>No settings match “{query}”.</div>}
            {groups.map(([group, defs]) => (
              <section key={group}>
                <div style={s.groupLabel}>{group}</div>
                {defs.map((def) => (
                  <SettingRow
                    key={def.key}
                    def={def}
                    value={values[def.key]}
                    baseValue={baseValues[def.key]}
                    fonts={fonts}
                    onChange={(v) => setValue(def.key, v)}
                  />
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ def, value, baseValue, fonts, onChange }: { def: SettingDef; value: Theme["values"][string]; baseValue: Theme["values"][string]; fonts: string[]; onChange: (v: Theme["values"][string]) => void }) {
  const changed = baseValue !== undefined && value !== baseValue;
  return (
    <div style={s.row}>
      <div style={s.rowText}>
        <span style={s.rowLabel}>{def.label}</span>
        {def.hint && <span style={s.rowHint}>{def.hint}</span>}
      </div>
      <SettingControl def={def} value={value} fonts={fonts} onChange={onChange} />
      {/* Fixed slot so controls don't shift when the reset button appears. */}
      <button
        style={{ ...s.iconButton, visibility: changed ? "visible" : "hidden" }}
        onClick={() => onChange(baseValue)}
        title={`Reset to ${String(baseValue)}`}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
          <path d="M2.5 6a3.5 3.5 0 1 0 1-2.45M2.5 1.75v2h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function NameField({ theme, builtin }: { theme: Theme | undefined; builtin: boolean }) {
  const rename = useThemeStore((st) => st.rename);
  const [name, setName] = useState(theme?.name ?? "");
  useEffect(() => setName(theme?.name ?? ""), [theme?.id, theme?.name]);
  if (!theme) return null;
  if (builtin) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{theme.name}</span>
        <span style={s.note}>Built-in theme. Changing any setting makes your own copy to edit.</span>
      </div>
    );
  }
  return (
    <input
      style={{ ...s.input, height: 30, fontSize: 15, fontWeight: 600, width: "100%" }}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => (name.trim() ? rename(theme.id, name) : setName(theme.name))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Theme name"
    />
  );
}

function ThemeList({ themes, activeId }: { themes: Theme[]; activeId: string }) {
  const setActive = useThemeStore((st) => st.setActive);
  const duplicate = useThemeStore((st) => st.duplicate);
  const remove = useThemeStore((st) => st.remove);
  const builtins = themes.filter((t) => BUILTIN_IDS.has(t.id));
  const mine = themes.filter((t) => !BUILTIN_IDS.has(t.id));

  const menu = (e: React.MouseEvent, t: Theme) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu([
      { label: "Duplicate", action: () => duplicate(t.id) },
      ...(BUILTIN_IDS.has(t.id) ? [] : ["separator" as const, { label: `Delete “${t.name}”`, action: () => remove(t.id) }]),
    ]);
  };

  const row = (t: Theme) => (
    <ThemeRow key={t.id} theme={t} active={t.id === activeId} onClick={() => setActive(t.id)} onContextMenu={(e) => menu(e, t)} />
  );

  return (
    <div style={s.list}>
      <div style={s.listBody}>
        <div style={s.listLabel}>Built-in</div>
        {builtins.map(row)}
        <div style={s.listLabel}>Yours</div>
        {mine.length === 0 ? <div style={{ ...s.note, padding: "2px 8px" }}>Edit any setting, or duplicate a theme, to make one.</div> : mine.map(row)}
      </div>
      <div style={s.listFooter}>
        <button style={s.button} onClick={() => duplicate(activeId)}>
          Duplicate theme
        </button>
        <button style={s.button} onClick={() => api.themesDirPath().then((p) => api.revealInFinder(p))}>
          Show themes folder
        </button>
      </div>
    </div>
  );
}

function ThemeRow({ theme, active, onClick, onContextMenu }: { theme: Theme; active: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        ...s.themeRow,
        background: active ? "var(--bg-active)" : hovered ? "var(--bg-hover)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <ThemeSwatch theme={theme} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{theme.name}</span>
    </div>
  );
}

/** Tiny preview: app background with the terminal color and text color inside. */
function ThemeSwatch({ theme }: { theme: Theme }) {
  const v = theme.values;
  return (
    <span
      style={{
        width: 16,
        height: 12,
        flexShrink: 0,
        borderRadius: 3,
        border: "1px solid var(--border-subtle)",
        background: String(v["bg-app"] ?? "transparent"),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span style={{ width: 8, height: 4, borderRadius: 1, background: String(v["text-primary"] ?? "transparent") }} />
    </span>
  );
}
