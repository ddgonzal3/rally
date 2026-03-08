import { scriptOutputBuffers } from "../stores/workspaceStore";
import type { ScriptRun } from "./types";

export type WatcherBuildStatus = "idle" | "building" | "success" | "error";

export function isWatcherScript(name: string): boolean {
  return name.toLowerCase().includes("watch");
}

const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const WATCHER_ERROR_PATTERNS = [
  /\bRunning target .* failed\b/i,
  /^\s*Failed tasks?:\s*$/i,
  /\bbuild failed\b/i,
  /\bcompilation failed\b/i,
  /\btypecheck failed\b/i,
  /\bFailed to compile\b/i,
  /\bCompiled with errors?\b/i,
  /\bERROR in\b/i,
  /\[ERROR\]/i,
  /\berror TS\d{4}:/i,
  /\bTS\d{4}:/i,
  /\bNG\d{4}:/i,
  /^[✘x]\s/i,
] as const;
const SCRIPT_ERROR_PATTERNS = [
  ...WATCHER_ERROR_PATTERNS,
  /\bERR!\b/i,
  /\bfailed\b/i,
  /^error:/i,
  /^error\s/i,
] as const;
const SUCCESS_PATTERNS = /\b(built in|compiled successfully|successfully compiled|ready in|bundle generation complete|build complete|compiled in)\b/i;
const BUILDING_PATTERNS = /\b(rebuilding|compiling|bundling|transforming|generating .*bundles?|building|starting incremental watcher|nx run .*--watch|phase:\s*(setup|build|emit))\b/i;

interface CachedWatcherStatus {
  status: WatcherBuildStatus;
  chunkCount: number;
}

function normalizeLine(line: string): string {
  return line.replace(ANSI_REGEX, "").replace(/\r/g, "").trim();
}

function isIgnorableErrorLine(line: string): boolean {
  return /\b0 errors?\b/i.test(line) ||
    /searchable error logs/i.test(line) ||
    /deprecationwarning/i.test(line) ||
    /prone to errors that have security implications/i.test(line);
}

function hasWatcherError(line: string): boolean {
  if (!line || isIgnorableErrorLine(line)) return false;
  return WATCHER_ERROR_PATTERNS.some((pattern) => pattern.test(line));
}

function hasScriptError(line: string): boolean {
  if (!line || isIgnorableErrorLine(line)) return false;
  return SCRIPT_ERROR_PATTERNS.some((pattern) => pattern.test(line));
}

function hasSuccess(line: string): boolean {
  if (!line) return false;
  return SUCCESS_PATTERNS.test(line);
}

function hasBuilding(line: string): boolean {
  if (!line) return false;
  return BUILDING_PATTERNS.test(line);
}

function decodeChunks(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("");
}

function createInitialWatcherStatus(): CachedWatcherStatus {
  return { status: "building", chunkCount: 0 };
}

function applyWatcherText(
  status: WatcherBuildStatus,
  text: string,
): WatcherBuildStatus {
  let nextStatus = status;
  for (const raw of text.split("\n")) {
    const line = normalizeLine(raw);
    if (!line) continue;
    if (hasBuilding(line)) {
      nextStatus = "building";
    }
    if (hasWatcherError(line)) {
      nextStatus = "error";
      continue;
    }
    if (hasSuccess(line) && nextStatus !== "error") {
      nextStatus = "success";
    }
  }
  return nextStatus;
}

/**
 * Cached watcher build status — updated incrementally as new output arrives.
 * Avoids re-decoding the entire buffer on every render.
 */
const watcherStatusCache = new Map<string, CachedWatcherStatus>();

export function observeWatcherOutput(
  bufferKey: string,
  text: string,
): WatcherBuildStatus {
  const cached = watcherStatusCache.get(bufferKey) ?? createInitialWatcherStatus();
  const status = applyWatcherText(cached.status, text);
  watcherStatusCache.set(bufferKey, {
    status,
    chunkCount: cached.chunkCount + 1,
  });
  return status;
}

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
  let currentStatus = cached?.status ?? createInitialWatcherStatus().status;

  if (buf.length > startIdx) {
    const newChunks = buf.slice(startIdx);
    const text = decodeChunks(newChunks);
    currentStatus = applyWatcherText(currentStatus, text);
  }

  watcherStatusCache.set(bufferKey, { status: currentStatus, chunkCount: buf.length });
  return currentStatus;
}

export function clearWatcherStatusCache(bufferKey: string): void {
  watcherStatusCache.delete(bufferKey);
}

export function inferScriptCompletionStatus(
  bufferKey: string,
  scriptName: string,
): "success" | "error" {
  const buf = scriptOutputBuffers.get(bufferKey);
  if (!buf || buf.length === 0) return "success";

  if (isWatcherScript(scriptName)) {
    return getWatcherBuildStatus(bufferKey) === "error" ? "error" : "success";
  }

  const text = decodeChunks(buf);
  for (const raw of text.split("\n")) {
    const line = normalizeLine(raw);
    if (hasScriptError(line)) return "error";
  }
  return "success";
}

export function getWatcherDisplayStatus(run: ScriptRun | undefined): WatcherBuildStatus {
  if (!run) return "idle";
  if (run.status === "running") return run.watcherBuildStatus ?? "building";
  if (run.watcherBuildStatus === "error" || run.status === "error") return "error";
  return "idle";
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
