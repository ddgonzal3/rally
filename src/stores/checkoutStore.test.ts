import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("persists labels and busy marks independently and restores them after a reload", async () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  vi.stubGlobal("window", { localStorage, addEventListener: vi.fn() });
  vi.resetModules();
  const first = await import("./checkoutStore");
  first.useCheckoutStore.getState().setLabel("/repo", "  MIDI editor  ");
  first.useCheckoutStore.getState().setBusy("/repo", true);
  expect(() => first.assertCheckoutAvailable("/repo")).toThrow("marked busy outside Rally");
  vi.resetModules();
  const restored = await import("./checkoutStore");
  expect(restored.useCheckoutStore.getState().notes["/repo"]).toEqual({ label: "MIDI editor", busy: true });
  restored.useCheckoutStore.getState().setBusy("/repo", false);
  expect(() => restored.assertCheckoutAvailable("/repo")).not.toThrow();
  expect(restored.useCheckoutStore.getState().notes["/repo"].label).toBe("MIDI editor");
  restored.useCheckoutStore.getState().setLabel("/repo", "");
  expect(restored.useCheckoutStore.getState().notes["/repo"].busy).toBe(false);
});
