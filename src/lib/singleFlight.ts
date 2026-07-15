/**
 * Wrap an async function so only one call runs at a time, and so the
 * wrapper's promise is GUARANTEED to settle within `staleMs`.
 *
 * The naive boolean in-flight guard (`if (inFlight) return; inFlight = true;
 * try { await work() } finally { inFlight = false }`) has a fatal failure
 * mode: if `work()` never settles (e.g. a Tauri invoke whose Rust future
 * parks forever), the `finally` never runs and the guard latches — every
 * future call early-returns until app restart. This bricked PR-status
 * polling: one hung `git_pr_status` invoke at startup silently killed all
 * PR badge refreshes (interval, focus, visibilitychange, manual button).
 *
 * Here the work races a `staleMs` deadline. If the deadline wins, we log
 * loudly, release the slot, and settle — the next poll starts fresh. If
 * the abandoned work eventually settles, its store updates are idempotent
 * and harmless. Errors from the work are logged and swallowed (poll cycles
 * already absorb per-item errors; a rejection here must never become an
 * unhandled rejection from an interval tick).
 */
export function singleFlight<Args extends unknown[]>(
  name: string,
  staleMs: number,
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  let inFlight = false;

  return async (...args: Args) => {
    if (inFlight) return;
    inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(...args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`did not settle within ${staleMs}ms — releasing the slot`),
              ),
            staleMs,
          );
        }),
      ]);
    } catch (e) {
      console.warn(`[rally] ${name}:`, e);
    } finally {
      clearTimeout(timer);
      inFlight = false;
    }
  };
}
