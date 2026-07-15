import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { singleFlight } from "./singleFlight";

describe("singleFlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs calls that arrive while idle", async () => {
    const fn = vi.fn(async () => {});
    const wrapped = singleFlight("test", 1000, fn);
    await wrapped();
    await wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes arguments through", async () => {
    const fn = vi.fn(async (_force: boolean) => {});
    const wrapped = singleFlight("test", 1000, fn);
    await wrapped(true);
    expect(fn).toHaveBeenCalledWith(true);
  });

  it("drops calls while a run is in flight", async () => {
    let release!: () => void;
    const fn = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = resolve)),
      )
      .mockResolvedValue(undefined);
    const wrapped = singleFlight("test", 1000, fn);
    const first = wrapped();
    void wrapped();
    void wrapped();
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    await first;
    await wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("swallows rejections (no unhandled rejection from poll ticks) and frees the slot", async () => {
    const fn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const wrapped = singleFlight("test", 1000, fn);
    await expect(wrapped()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledOnce();
    await wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("settles and frees the slot when the work never settles", async () => {
    const fn = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(new Promise<void>(() => {})) // hangs forever
      .mockResolvedValue(undefined);
    const wrapped = singleFlight("test", 1000, fn);
    const first = wrapped();
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    void wrapped(); // still in flight — dropped
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600); // deadline passed
    await first; // wrapper promise settled despite hung work
    expect(console.warn).toHaveBeenCalledOnce();

    await wrapped(); // slot free — runs fresh
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not fire the stale warning when work settles in time", async () => {
    const fn = vi.fn(async () => {});
    const wrapped = singleFlight("test", 1000, fn);
    await wrapped();
    await vi.advanceTimersByTimeAsync(2000);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
