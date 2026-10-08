import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "../lib/tauri";
import { BUILTIN_IDS, BUILTIN_THEMES } from "../lib/theme/builtins";
import type { Theme, ThemeValue, ThemeValues } from "../lib/theme/schema";
import { applyTheme, repaintBackdropFilters, syncBackdrop } from "../lib/theme/apply";

/**
 * Themes: built-ins (read-only) plus user themes from ~/.rally/themes.
 * Every window keeps its own copy of this store; edits broadcast over a Tauri
 * event so the theme builder window restyles the main window live.
 */

const ACTIVE_KEY = "rally:themeId";
const LEGACY_KEY = "rally:theme";
/** Last active theme, so a user theme paints on launch before the disk read finishes. */
const CACHE_KEY = "rally:themeCache";
const EVENT = "rally-theme-changed";
const SAVE_DELAY_MS = 300;
/** First launch, unknown ids, and the dark fallback all land on Dimmed. */
const DEFAULT_THEME_ID = "dimmed";

type ThemeEvent = { from: string; activeId: string } & (
  | { kind: "upsert"; theme: Theme }
  | { kind: "remove"; id: string }
  | { kind: "activate" }
);

interface ThemeState {
  userThemes: Theme[];
  /** Built-ins then user themes. Rebuilt only when the list changes. */
  themes: Theme[];
  activeId: string;
  /** The active theme with every setting filled in. */
  values: ThemeValues;
  setActive: (id: string) => void;
  /** Editing a built-in first makes a copy and switches to it. */
  setValue: (key: string, value: ThemeValue) => void;
  /** Copy a theme, switch to the copy, and return its id. */
  duplicate: (id: string) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
}

const windowLabel = getCurrentWebviewWindow().label;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function isTheme(v: unknown): v is Theme {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<Theme>;
  return typeof t.id === "string" && typeof t.name === "string" && !!t.values && typeof t.values === "object";
}

function findTheme(themes: Theme[], id: string): Theme {
  return themes.find((t) => t.id === id) ?? themes.find((t) => t.id === DEFAULT_THEME_ID)!;
}

/** The built-in a theme falls back to: Light for light themes, else the default. */
function builtinFor(theme: Theme): string {
  return theme.values.appearance === "light" ? "light" : DEFAULT_THEME_ID;
}

/** Fill settings a user theme doesn't have (added after it was saved) from its fallback built-in. */
function resolve(theme: Theme): ThemeValues {
  if (BUILTIN_IDS.has(theme.id)) return theme.values;
  const base = findTheme(BUILTIN_THEMES, builtinFor(theme));
  return { ...base.values, ...theme.values };
}

function newId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "theme";
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueName(themes: Theme[], base: string): string {
  const names = new Set(themes.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

// --- Persistence ----------------------------------------------------------------

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(theme: Theme): void {
  clearTimeout(saveTimers.get(theme.id));
  saveTimers.set(
    theme.id,
    setTimeout(() => {
      saveTimers.delete(theme.id);
      api.saveTheme(theme).catch((e) => console.error(`[rally] saving theme ${theme.id} failed:`, e));
    }, SAVE_DELAY_MS),
  );
}

// --- Broadcast ------------------------------------------------------------------

// Sliders and color drags fire many times per frame; send at most one update per frame per theme.
const pendingUpserts = new Map<string, ThemeEvent>();
let flushQueued = false;

function broadcast(event: ThemeEvent): void {
  if (event.kind === "upsert") {
    pendingUpserts.set(event.theme.id, event);
    if (!flushQueued) {
      flushQueued = true;
      requestAnimationFrame(() => {
        flushQueued = false;
        for (const e of pendingUpserts.values()) void emit(EVENT, e);
        pendingUpserts.clear();
      });
    }
    return;
  }
  void emit(EVENT, event);
}

// --- Store ----------------------------------------------------------------------

function initialState(): Pick<ThemeState, "userThemes" | "themes" | "activeId" | "values"> {
  const activeId = readStorage(ACTIVE_KEY) ?? readStorage(LEGACY_KEY) ?? DEFAULT_THEME_ID;
  let cached: Theme | null = null;
  try {
    const parsed = JSON.parse(readStorage(CACHE_KEY) ?? "null");
    if (isTheme(parsed) && parsed.id === activeId && !BUILTIN_IDS.has(parsed.id)) cached = parsed;
  } catch {}
  const userThemes = cached ? [cached] : [];
  const themes = [...BUILTIN_THEMES, ...userThemes];
  const active = findTheme(themes, activeId);
  return { userThemes, themes, activeId: active.id, values: resolve(active) };
}

export const useThemeStore = create<ThemeState>((set, get) => {
  /** Replace the user theme list and/or active theme, then restyle this window. */
  const commit = (userThemes: Theme[], activeId: string) => {
    const themes = [...BUILTIN_THEMES, ...userThemes];
    const active = findTheme(themes, activeId);
    const values = resolve(active);
    const switched = active.id !== get().activeId;
    set({ userThemes, themes, activeId: active.id, values });
    writeStorage(ACTIVE_KEY, active.id);
    writeStorage(CACHE_KEY, JSON.stringify(active));
    applyTheme(values);
    if (switched) repaintBackdropFilters();
  };

  const upsert = (list: Theme[], theme: Theme) =>
    list.some((t) => t.id === theme.id) ? list.map((t) => (t.id === theme.id ? theme : t)) : [...list, theme];

  const saveAndShare = (theme: Theme, activeId: string) => {
    scheduleSave(theme);
    broadcast({ from: windowLabel, activeId, kind: "upsert", theme });
  };

  return {
    ...initialState(),

    setActive: (id) => {
      commit(get().userThemes, id);
      broadcast({ from: windowLabel, activeId: get().activeId, kind: "activate" });
    },

    setValue: (key, value) => {
      let { activeId } = get();
      if (BUILTIN_IDS.has(activeId)) activeId = get().duplicate(activeId);
      const current = findTheme(get().themes, activeId);
      const theme: Theme = { ...current, values: { ...current.values, [key]: value } };
      commit(upsert(get().userThemes, theme), activeId);
      saveAndShare(theme, activeId);
    },

    duplicate: (id) => {
      const source = findTheme(get().themes, id);
      const name = uniqueName(get().themes, `${source.name} copy`);
      // Copy the resolved values so the new file is complete and self-describing.
      const theme: Theme = { version: 1, id: newId(name), name, values: { ...resolve(source) } };
      commit(upsert(get().userThemes, theme), theme.id);
      saveAndShare(theme, theme.id);
      return theme.id;
    },

    rename: (id, name) => {
      const trimmed = name.trim();
      if (BUILTIN_IDS.has(id) || !trimmed) return;
      const current = findTheme(get().themes, id);
      const theme: Theme = { ...current, name: trimmed };
      commit(upsert(get().userThemes, theme), get().activeId);
      saveAndShare(theme, get().activeId);
    },

    remove: (id) => {
      if (BUILTIN_IDS.has(id)) return;
      const { activeId, userThemes } = get();
      const removed = findTheme(get().themes, id);
      // Deleting the active theme switches to its fallback built-in.
      const nextActive = activeId === id ? builtinFor(removed) : activeId;
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      // A queued edit for this theme must not reach other windows after the removal.
      pendingUpserts.delete(id);
      commit(userThemes.filter((t) => t.id !== id), nextActive);
      api.deleteTheme(id).catch((e) => console.error(`[rally] deleting theme ${id} failed:`, e));
      broadcast({ from: windowLabel, activeId: nextActive, kind: "remove", id });
    },
  };
});

/**
 * Apply the theme before the first render, load user themes from disk, and
 * follow edits made in other windows. Call once per window from main.tsx.
 */
export function initTheme(): void {
  const store = useThemeStore;
  applyTheme(store.getState().values);

  api
    .listThemes()
    .then((raw) => {
      const fromDisk = raw.filter(isTheme).filter((t) => !BUILTIN_IDS.has(t.id));
      fromDisk.sort((a, b) => a.name.localeCompare(b.name));
      const { activeId } = store.getState();
      const themes = [...BUILTIN_THEMES, ...fromDisk];
      const active = findTheme(themes, activeId);
      const values = resolve(active);
      store.setState({ userThemes: fromDisk, themes, activeId: active.id, values });
      writeStorage(ACTIVE_KEY, active.id);
      writeStorage(CACHE_KEY, JSON.stringify(active));
      applyTheme(values);
    })
    .catch((e) => console.error("[rally] loading themes failed:", e));

  void listen<ThemeEvent>(EVENT, ({ payload }) => {
    if (payload.from === windowLabel) return;
    const { userThemes } = store.getState();
    let next = userThemes;
    if (payload.kind === "upsert") {
      next = userThemes.some((t) => t.id === payload.theme.id)
        ? userThemes.map((t) => (t.id === payload.theme.id ? payload.theme : t))
        : [...userThemes, payload.theme];
    } else if (payload.kind === "remove") {
      next = userThemes.filter((t) => t.id !== payload.id);
    }
    const themes = next === userThemes ? store.getState().themes : [...BUILTIN_THEMES, ...next];
    const active = findTheme(themes, payload.activeId);
    const values = resolve(active);
    const switched = active.id !== store.getState().activeId;
    store.setState({ userThemes: next, themes, activeId: active.id, values });
    applyTheme(values);
    if (switched) repaintBackdropFilters();
  });

  // Reduce transparency is toggled in System Settings, outside Rally.
  window.addEventListener("focus", () => syncBackdrop(store.getState().values));
}

// E2E bridge access (same pattern as __rallyStoreAccessor). setState lets tests
// preview values without saving them to ~/.rally/themes.
(window as any).__rallyThemeStore = {
  store: useThemeStore,
  preview: (values: ThemeValues) => {
    useThemeStore.setState({ values });
    applyTheme(values);
  },
};
