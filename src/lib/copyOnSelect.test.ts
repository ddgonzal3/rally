import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri", () => ({
  api: { writeClipboardText: vi.fn(() => Promise.resolve()) },
}));

import { api } from "./tauri";
import { installCopyOnSelect } from "./copyOnSelect";
import type { Terminal } from "@xterm/xterm";

function fakeTerm() {
  let selection = "";
  let listener: (() => void) | null = null;
  const term = {
    getSelection: () => selection,
    onSelectionChange: (cb: () => void) => {
      listener = cb;
      return { dispose: () => { listener = null; } };
    },
  } as unknown as Terminal;
  return {
    term,
    select(text: string) {
      selection = text;
      listener?.();
    },
    get hasListener() { return listener !== null; },
  };
}

describe("installCopyOnSelect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.writeClipboardText).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("copies once after the selection settles, not on every drag step", () => {
    const t = fakeTerm();
    installCopyOnSelect(t.term);
    t.select("he");
    t.select("hel");
    t.select("hello");
    expect(api.writeClipboardText).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(api.writeClipboardText).toHaveBeenCalledTimes(1);
    expect(api.writeClipboardText).toHaveBeenCalledWith("hello");
  });

  it("ignores cleared selections and unchanged text", () => {
    const t = fakeTerm();
    installCopyOnSelect(t.term);
    t.select("same");
    vi.advanceTimersByTime(60);
    t.select("same");
    vi.advanceTimersByTime(60);
    t.select("");
    vi.advanceTimersByTime(60);
    expect(api.writeClipboardText).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending copy and unsubscribes", () => {
    const t = fakeTerm();
    const d = installCopyOnSelect(t.term);
    t.select("pending");
    d.dispose();
    vi.advanceTimersByTime(60);
    expect(api.writeClipboardText).not.toHaveBeenCalled();
    expect(t.hasListener).toBe(false);
  });
});
