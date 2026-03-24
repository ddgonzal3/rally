/**
 * Focus-mode scroll gesture detector.
 *
 * Converts a stream of horizontal wheel deltas into discrete "navigate left/right"
 * actions — exactly one per physical trackpad swipe, regardless of macOS inertia.
 *
 * Pure state machine with no DOM or timer dependencies.
 * Time is injected so tests can control it precisely.
 */

export type ScrollDirection = "left" | "right";
export type ScrollAction = { navigate: ScrollDirection } | null;

export interface FocusScrollConfig {
  /**
   * Minimum gap (ms) between wheel events to consider inertia "ended"
   * and allow the next gesture. macOS fires wheel events every ~16ms
   * during active scrolling, so anything >50ms is a gap.
   */
  gestureGapMs: number;
}

const DEFAULT_CONFIG: FocusScrollConfig = {
  gestureGapMs: 80,
};

export function createFocusScrollMachine(config: Partial<FocusScrollConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  let locked = false;
  let lockedDir: ScrollDirection | null = null;
  let lastEventTime = 0;

  /**
   * Feed a wheel event into the machine.
   * Returns { navigate: direction } if this event should trigger navigation,
   * or null if it should be absorbed (inertia / noise).
   */
  function handleWheel(deltaX: number, now: number): ScrollAction {
    const absDelta = Math.abs(deltaX);

    // Ignore noise
    if (absDelta < 1) return null;

    const dir: ScrollDirection = deltaX > 0 ? "right" : "left";
    const gap = now - lastEventTime;
    lastEventTime = now;

    // If enough time passed since last event, inertia is over — unlock
    if (locked && gap >= cfg.gestureGapMs) {
      locked = false;
    }

    // Direction reversal always means a new gesture
    if (locked && dir !== lockedDir) {
      locked = false;
    }

    if (locked) return null;

    // Navigate and lock
    locked = true;
    lockedDir = dir;
    return { navigate: dir };
  }

  /** Reset state (e.g., when exiting focus mode). */
  function reset() {
    locked = false;
    lockedDir = null;
    lastEventTime = 0;
  }

  return { handleWheel, reset };
}
