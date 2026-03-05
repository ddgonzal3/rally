/**
 * Shared localhost port detection for terminal and script output.
 *
 * Matches explicit URLs (http://localhost:3000) and common framework
 * announcements ("listening on port 3000", "ready on :5173", etc.).
 */

// Match http(s)://localhost:<port> or http(s)://127.0.0.1:<port>
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/gi;

// Match common "listening on port XXXX" / "ready on :XXXX" patterns
const ANNOUNCE_RE = /(?:listening|running|started|ready|serving|available)\s+(?:on|at)\s+(?:port\s+)?:?(\d{2,5})/gi;

/** Strip ANSI escape codes so patterns match clean text */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][A-Z0-9]|\x0f/g;

export interface ParsedPort {
  port: number;
  url: string;
}

/**
 * Scan a chunk of terminal output for localhost port references.
 * Returns deduplicated ports found in this chunk.
 */
export function detectPorts(raw: string): ParsedPort[] {
  const text = raw.replace(ANSI_RE, "");
  const seen = new Set<number>();
  const results: ParsedPort[] = [];

  for (const match of text.matchAll(URL_RE)) {
    const port = parseInt(match[1], 10);
    if (port > 0 && port <= 65535 && !seen.has(port)) {
      seen.add(port);
      results.push({ port, url: `http://localhost:${port}` });
    }
  }

  for (const match of text.matchAll(ANNOUNCE_RE)) {
    const port = parseInt(match[1], 10);
    if (port > 0 && port <= 65535 && !seen.has(port)) {
      seen.add(port);
      results.push({ port, url: `http://localhost:${port}` });
    }
  }

  return results;
}
