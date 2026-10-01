import { describe, expect, it, vi } from "vitest";

vi.mock("../stores/workspaceStore", () => ({ scriptOutputBuffers: new Map() }));

import { observeWatcherOutput } from "./watcherStatus";

// Trimmed from a real Flow watch-fe.sh run after the move to Vite: the
// side-by-side `tsc --watch` prints type errors, the build still syncs.
const rebuildWithTypeErrors = `build started...
[flow-build] start
[watcher] Compiling...
[typecheck] apps/flow/src/widget-lab/hosts/eq-lab-host.tsx(306,42): error TS2322: Type 'RefObject<HTMLDivElement | null>' is not assignable to type 'Ref<HTMLDivElement> | undefined'.
[typecheck] Found 77 errors.
transforming...
✓ 6055 modules transformed.
built in 13461ms.
[flow-build] done
[watcher] *** Build synced — safe to reload ***
`;

describe("watcher status", () => {
  it("stays green when only the side-by-side type checker reports errors", () => {
    const status = observeWatcherOutput("flow-typecheck", rebuildWithTypeErrors);
    expect(status.status).toBe("success");
    expect(status.buildCompletionCount).toBe(1);
  });

  it("still goes red when the build itself reports a type error", () => {
    const status = observeWatcherOutput("plain-tsc", "[watcher] Compiling...\nsrc/a.ts(1,1): error TS2322: bad\n");
    expect(status.status).toBe("error");
  });
});
