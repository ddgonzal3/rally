import { scriptOutputBuffers } from "../stores/workspaceStore";

export type WatcherBuildStatus = "idle" | "building" | "success" | "error";

export function isWatcherScript(name: string): boolean {
  return name.toLowerCase().includes("watch");
}

const ERROR_PATTERNS = /\b(error|failed|failure|ERR!|ERROR)\b/i;
const SUCCESS_PATTERNS = /\b(built in|compiled successfully|ready in|watching for file changes|successfully compiled|ready|complete)\b/i;
const BUILDING_PATTERNS = /\b(rebuilding|compiling|bundling|transforming)\b/i;

/**
 * Cached watcher build status — updated incrementally as new output arrives.
 * Avoids re-decoding the entire buffer on every render.
 */
const watcherStatusCache = new Map<string, { status: WatcherBuildStatus; chunkCount: number }>();

export function getWatcherBuildStatus(bufferKey: string): WatcherBuildStatus {
  const buf = scriptOutputBuffers.get(bufferKey);
  if (!buf || buf.length === 0) return "building";

  let cached = watcherStatusCache.get(bufferKey);
  // Buffer was reset (new run) — clear stale cache
  if (cached && buf.length < cached.chunkCount) {
    watcherStatusCache.delete(bufferKey);
    cached = undefined;
  }
  if (cached && cached.chunkCount === buf.length) return cached.status;

  const startIdx = cached?.chunkCount ?? 0;
  let currentStatus = cached?.status ?? "building";

  if (buf.length > startIdx) {
    // For watchers: new output after success/error means a rebuild started
    if (currentStatus === "success" || currentStatus === "error") {
      currentStatus = "building";
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const newChunks = buf.slice(startIdx);
    const text = newChunks.map((c) => decoder.decode(c, { stream: true })).join("");
    if (BUILDING_PATTERNS.test(text)) currentStatus = "building";
    if (ERROR_PATTERNS.test(text)) currentStatus = "error";
    if (SUCCESS_PATTERNS.test(text)) currentStatus = "success";
  }

  watcherStatusCache.set(bufferKey, { status: currentStatus, chunkCount: buf.length });
  return currentStatus;
}

export function getStatusColor(status: WatcherBuildStatus): string {
  switch (status) {
    case "error": return "var(--status-red)";
    case "success": return "var(--status-green)";
    case "building": return "var(--status-amber)";
    case "idle": return "var(--text-dim)";
  }
}

export function getDisplayName(scriptName: string): string {
  return scriptName.replace(/\.(sh|bash)$/, "");
}

