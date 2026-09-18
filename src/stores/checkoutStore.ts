import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CheckoutNote {
  busy?: boolean;
  label?: string;
}

interface CheckoutState {
  notes: Record<string, CheckoutNote>;
  setBusy: (cwd: string, busy: boolean) => void;
  setLabel: (cwd: string, label: string) => void;
}

// Checkout identity, independent of workspaces, panels, and Claude sessions.
export const useCheckoutStore = create<CheckoutState>()(persist((set) => ({
  notes: {},
  setBusy: (cwd, busy) => set((s) => ({ notes: { ...s.notes, [cwd]: { ...s.notes[cwd], busy } } })),
  setLabel: (cwd, label) => set((s) => ({ notes: { ...s.notes, [cwd]: { ...s.notes[cwd], label: label.trim() } } })),
}), { name: "rally:checkout-notes" }));

// Keep other Rally windows in agreement about checkout reservations.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === "rally:checkout-notes" || event.key === null) void useCheckoutStore.persist.rehydrate();
  });
}

export function assertCheckoutAvailable(cwd: string) {
  if (useCheckoutStore.getState().notes[cwd]?.busy) {
    throw new Error("This checkout is marked busy outside Rally. Clear its busy mark before starting a new task or resetting it.");
  }
}
