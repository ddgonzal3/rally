import { describe, it, expect } from "vitest";
import { createFocusScrollMachine } from "./focusScroll";

/**
 * Simulates a trackpad swipe: a burst of wheel events with increasing then
 * decreasing deltaX, followed by a long inertia tail of decaying deltas.
 * Events arrive every ~16ms (60fps).
 */
function simulateSwipe(
  machine: ReturnType<typeof createFocusScrollMachine>,
  direction: "right" | "left",
  startTime: number,
  opts?: { peakDelta?: number; eventCount?: number }
) {
  const sign = direction === "right" ? 1 : -1;
  const peak = opts?.peakDelta ?? 40;
  const count = opts?.eventCount ?? 30;
  const results: ReturnType<typeof machine.handleWheel>[] = [];

  for (let i = 0; i < count; i++) {
    const t = startTime + i * 16;
    // Ramp up to peak in first 1/4, then decay
    const progress = i / count;
    const magnitude =
      progress < 0.25
        ? peak * (progress / 0.25)
        : peak * (1 - (progress - 0.25) / 0.75);
    const delta = Math.max(magnitude, 0.5) * sign;
    results.push(machine.handleWheel(delta, t));
  }
  return results;
}

describe("FocusScrollMachine", () => {
  it("navigates exactly once on a single swipe", () => {
    const m = createFocusScrollMachine();
    const results = simulateSwipe(m, "right", 0);
    const navs = results.filter((r) => r !== null);
    expect(navs).toHaveLength(1);
    expect(navs[0]).toEqual({ navigate: "right" });
  });

  it("navigates on the first meaningful event of a swipe", () => {
    const m = createFocusScrollMachine();
    const result = m.handleWheel(5, 0);
    expect(result).toEqual({ navigate: "right" });
  });

  it("absorbs all inertia events after navigation", () => {
    const m = createFocusScrollMachine();
    // First event navigates
    expect(m.handleWheel(20, 0)).toEqual({ navigate: "right" });
    // Subsequent inertia events at 16ms intervals — all absorbed
    for (let i = 1; i <= 50; i++) {
      expect(m.handleWheel(20 - i * 0.3, i * 16)).toBeNull();
    }
  });

  it("allows a new swipe immediately after inertia ends (gap >= gestureGapMs)", () => {
    const m = createFocusScrollMachine({ gestureGapMs: 80 });
    // First swipe
    expect(m.handleWheel(20, 0)).toEqual({ navigate: "right" });
    // Inertia events every 16ms for ~400ms
    for (let i = 1; i <= 25; i++) {
      m.handleWheel(Math.max(20 - i, 1), i * 16);
    }
    const lastInertiaTime = 25 * 16; // 400ms

    // Gap of 80ms — inertia is over, new swipe should navigate immediately
    const newSwipeTime = lastInertiaTime + 80;
    expect(m.handleWheel(15, newSwipeTime)).toEqual({ navigate: "right" });
  });

  it("does NOT navigate during inertia even with large deltas", () => {
    const m = createFocusScrollMachine({ gestureGapMs: 80 });
    // First event navigates
    expect(m.handleWheel(30, 0)).toEqual({ navigate: "right" });
    // Large inertia events arriving continuously (no gap)
    expect(m.handleWheel(25, 16)).toBeNull();
    expect(m.handleWheel(20, 32)).toBeNull();
    expect(m.handleWheel(15, 48)).toBeNull();
    expect(m.handleWheel(25, 64)).toBeNull(); // spike, but no gap
    expect(m.handleWheel(30, 80)).toBeNull(); // big spike, but no gap
  });

  it("navigates immediately on direction reversal", () => {
    const m = createFocusScrollMachine();
    // Swipe right
    expect(m.handleWheel(20, 0)).toEqual({ navigate: "right" });
    // Inertia still flowing
    expect(m.handleWheel(10, 16)).toBeNull();
    // Reverse direction — should navigate left immediately
    expect(m.handleWheel(-15, 32)).toEqual({ navigate: "left" });
  });

  it("handles rapid successive swipes in the same direction", () => {
    const m = createFocusScrollMachine({ gestureGapMs: 80 });
    const navs: string[] = [];

    // Swipe 1
    const results1 = simulateSwipe(m, "right", 0, { eventCount: 15 });
    navs.push(...results1.filter((r) => r !== null).map((r) => r!.navigate));

    // Gap of 100ms after last event of swipe 1
    const swipe2Start = 15 * 16 + 100;

    // Swipe 2
    const results2 = simulateSwipe(m, "right", swipe2Start, { eventCount: 15 });
    navs.push(...results2.filter((r) => r !== null).map((r) => r!.navigate));

    // Gap of 100ms
    const swipe3Start = swipe2Start + 15 * 16 + 100;

    // Swipe 3
    const results3 = simulateSwipe(m, "right", swipe3Start, { eventCount: 15 });
    navs.push(...results3.filter((r) => r !== null).map((r) => r!.navigate));

    expect(navs).toEqual(["right", "right", "right"]);
  });

  it("ignores sub-threshold deltas (noise)", () => {
    const m = createFocusScrollMachine();
    expect(m.handleWheel(0.5, 0)).toBeNull();
    expect(m.handleWheel(-0.3, 16)).toBeNull();
    expect(m.handleWheel(0.9, 32)).toBeNull();
  });

  it("resets to clean state", () => {
    const m = createFocusScrollMachine();
    m.handleWheel(20, 0); // navigate and lock
    m.reset();
    // Should navigate again immediately after reset
    expect(m.handleWheel(20, 16)).toEqual({ navigate: "right" });
  });

  it("a fast flick (few events, big deltas) still navigates exactly once", () => {
    const m = createFocusScrollMachine();
    const results = [
      m.handleWheel(50, 0),
      m.handleWheel(45, 16),
      m.handleWheel(30, 32),
      m.handleWheel(15, 48),
      m.handleWheel(5, 64),
    ];
    const navs = results.filter((r) => r !== null);
    expect(navs).toHaveLength(1);
    expect(navs[0]).toEqual({ navigate: "right" });
  });

  it("a slow gentle swipe navigates exactly once", () => {
    const m = createFocusScrollMachine();
    const results = [
      m.handleWheel(2, 0),
      m.handleWheel(3, 16),
      m.handleWheel(2, 32),
      m.handleWheel(1.5, 48),
      m.handleWheel(1, 64),
    ];
    const navs = results.filter((r) => r !== null);
    expect(navs).toHaveLength(1);
  });

  it("swipe right then left then right — 3 navigations", () => {
    const m = createFocusScrollMachine({ gestureGapMs: 80 });

    // Right
    expect(m.handleWheel(20, 0)).toEqual({ navigate: "right" });
    m.handleWheel(10, 16);

    // Left (direction change — immediate)
    expect(m.handleWheel(-15, 32)).toEqual({ navigate: "left" });
    m.handleWheel(-8, 48);

    // Right again (direction change — immediate)
    expect(m.handleWheel(12, 64)).toEqual({ navigate: "right" });
  });
});
