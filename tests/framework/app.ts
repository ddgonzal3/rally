/**
 * App lifecycle manager — build, launch, wait-for-ready, kill.
 *
 * Usage:
 *   const app = new AppManager();
 *   await app.launch();    // builds if needed, launches, waits for ready
 *   // ... run tests ...
 *   await app.kill();
 */

import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const APP_PATH = path.join(
  PROJECT_ROOT,
  "src-tauri/target/debug/bundle/macos/Rally.app"
);
const HEALTH_URL = "http://127.0.0.1:9876/health";
const TEST_DATA_DIR = "/tmp/rally-test";

export class AppManager {
  private proc: ChildProcess | null = null;

  /**
   * Build the app with the test-bridge feature.
   * Skips if the binary is already up-to-date (no source changes).
   */
  build(): void {
    console.log("[app] Building Rally with test-bridge feature...");

    // Build frontend
    execSync("npm run build", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });

    // Build Rust with test-bridge feature
    execSync("cargo tauri build --bundles app --features test-bridge", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });

    console.log("[app] Build complete");
  }

  /**
   * Launch Rally in test mode and wait for it to be ready.
   */
  async launch(options?: { skipBuild?: boolean }): Promise<void> {
    if (!options?.skipBuild) {
      this.build();
    }

    if (!fs.existsSync(APP_PATH)) {
      throw new Error(`App not found at ${APP_PATH}. Run build first.`);
    }

    // Ensure clean test data directory
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    console.log("[app] Launching Rally in test mode...");
    this.proc = spawn("open", ["-a", APP_PATH, "--args", "--test-mode"], {
      env: {
        ...process.env,
        RALLY_TEST_MODE: "1",
      },
      stdio: "ignore",
    });

    await this.waitForReady();
    console.log("[app] Rally is ready");
  }

  /**
   * Poll the health endpoint until the app reports ready.
   */
  private async waitForReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(HEALTH_URL);
        if (res.ok) {
          const data = await res.json();
          if (data.ready) return;
        }
      } catch {
        // Server not up yet — keep polling
      }
      await sleep(pollInterval);
    }

    throw new Error(`App not ready after ${timeoutMs}ms`);
  }

  /**
   * Kill the Rally process.
   */
  async kill(): Promise<void> {
    console.log("[app] Killing Rally...");
    try {
      execSync("pkill -f 'Rally.app'", { stdio: "ignore" });
    } catch {
      // Process might already be dead
    }
    this.proc = null;

    // Clean up test data
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
