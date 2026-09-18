/**
 * Dependency-free helpers for script names. Lives apart from
 * `watcherStatus.ts` (which imports the store) so pure logic and unit tests
 * can use it without pulling in Tauri.
 */

/** Basename of a script reference, which may be a relative path. */
export function scriptBasename(name: string): string {
  return name.split("/").pop() ?? name;
}

export function isWatcherScript(name: string): boolean {
  return scriptBasename(name).toLowerCase().includes("watch");
}

export function getDisplayName(scriptName: string): string {
  return scriptBasename(scriptName).replace(/\.(sh|bash|zsh)$/, "");
}
