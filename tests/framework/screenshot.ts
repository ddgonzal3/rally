/**
 * Screenshot capture — wraps macOS screencapture for Rally's window.
 *
 * Uses osascript to find Rally's window ID, then screencapture -l
 * to capture just that window.
 */

import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const CAPTURES_DIR = path.resolve(
  import.meta.dirname,
  "../screenshots/captures"
);

export class Screenshot {
  constructor() {
    fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  }

  /**
   * Capture Rally's window to a PNG file.
   *
   * @param name - descriptive name (used in filename)
   * @returns absolute path to the captured screenshot
   */
  capture(name: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${name}-${timestamp}.png`;
    const filepath = path.join(CAPTURES_DIR, filename);

    const windowId = this.findWindowId();
    if (windowId) {
      // Capture specific window by ID (no shadow, no cursor)
      execSync(`screencapture -l ${windowId} -o -x "${filepath}"`, {
        stdio: "ignore",
      });
    } else {
      // Fallback: capture the frontmost window
      console.warn(
        "[screenshot] Could not find Rally window ID, capturing frontmost"
      );
      execSync(`screencapture -o -x "${filepath}"`, {
        stdio: "ignore",
      });
    }

    if (!fs.existsSync(filepath)) {
      throw new Error(`Screenshot was not created at ${filepath}`);
    }

    console.log(`[screenshot] Captured: ${filepath}`);
    return filepath;
  }

  /**
   * Find Rally's window ID using osascript.
   * Returns the CGWindowID as a string, or null if not found.
   */
  private findWindowId(): string | null {
    try {
      // Get the window ID of the Rally app's first window
      const result = execSync(
        `osascript -e 'tell application "System Events" to get id of first window of (first process whose name is "Rally")'`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
      ).trim();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * List all captured screenshots.
   */
  listCaptures(): string[] {
    if (!fs.existsSync(CAPTURES_DIR)) return [];
    return fs
      .readdirSync(CAPTURES_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => path.join(CAPTURES_DIR, f))
      .sort();
  }

  /**
   * Clean up all captured screenshots.
   */
  clearCaptures(): void {
    if (fs.existsSync(CAPTURES_DIR)) {
      for (const file of fs.readdirSync(CAPTURES_DIR)) {
        fs.unlinkSync(path.join(CAPTURES_DIR, file));
      }
    }
  }
}

export const screenshot = new Screenshot();
