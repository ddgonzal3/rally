/**
 * Lightweight test runner for Rally's agent-driven test framework.
 *
 * Tests are plain async functions registered via test(). The runner
 * discovers and executes them, collecting pass/fail results as JSON.
 *
 * Usage:
 *   npx tsx tests/framework/runner.ts [file-pattern] [--visual]
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

// --- Test registration ---

interface TestCase {
  name: string;
  fn: () => Promise<void>;
  file: string;
  tags: string[];
}

interface TestResult {
  name: string;
  file: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  error?: string;
}

const registeredTests: TestCase[] = [];
let currentFile = "";

/**
 * Register a test case.
 */
export function test(
  name: string,
  fn: () => Promise<void>,
  options?: { tags?: string[] }
): void {
  registeredTests.push({
    name,
    fn,
    file: currentFile,
    tags: options?.tags ?? [],
  });
}

/**
 * Simple assertion helper.
 */
export const expect = {
  toBe<T>(actual: T, expected: T, message?: string): void {
    if (actual !== expected) {
      throw new Error(
        message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  },

  toBeGreaterThan(actual: number, expected: number, message?: string): void {
    if (actual <= expected) {
      throw new Error(
        message ?? `Expected ${actual} > ${expected}`
      );
    }
  },

  toBeTruthy(actual: unknown, message?: string): void {
    if (!actual) {
      throw new Error(message ?? `Expected truthy, got ${JSON.stringify(actual)}`);
    }
  },

  toBeFalsy(actual: unknown, message?: string): void {
    if (actual) {
      throw new Error(message ?? `Expected falsy, got ${JSON.stringify(actual)}`);
    }
  },

  toContain(actual: string, expected: string, message?: string): void {
    if (!actual.includes(expected)) {
      throw new Error(
        message ?? `Expected "${actual}" to contain "${expected}"`
      );
    }
  },

  toBeNull(actual: unknown, message?: string): void {
    if (actual !== null) {
      throw new Error(message ?? `Expected null, got ${JSON.stringify(actual)}`);
    }
  },

  toBeNotNull(actual: unknown, message?: string): void {
    if (actual === null || actual === undefined) {
      throw new Error(message ?? `Expected non-null value`);
    }
  },
};

// --- Test discovery ---

async function discoverTests(patterns: string[]): Promise<string[]> {
  const testsDir = path.resolve(import.meta.dirname, "..");
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "framework" && entry.name !== "node_modules") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  }

  walk(testsDir);

  // Filter by patterns if provided
  if (patterns.length > 0) {
    return files.filter((f) =>
      patterns.some((p) => f.includes(p))
    );
  }
  return files;
}

// --- Main execution ---

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const visualOnly = args.includes("--visual");
  const patterns = args.filter((a) => !a.startsWith("--"));

  // Discover test files
  const testFiles = await discoverTests(patterns);
  if (testFiles.length === 0) {
    console.log("No test files found");
    process.exit(0);
  }

  console.log(`\nDiscovered ${testFiles.length} test file(s):\n`);
  for (const f of testFiles) {
    console.log(`  ${path.relative(process.cwd(), f)}`);
  }

  // Import each test file to register its tests
  for (const file of testFiles) {
    currentFile = file;
    await import(pathToFileURL(file).href);
  }

  // Filter by tags if --visual
  let testsToRun = registeredTests;
  if (visualOnly) {
    testsToRun = registeredTests.filter((t) => t.tags.includes("visual"));
  }

  console.log(`\nRunning ${testsToRun.length} test(s)...\n`);

  const results: TestResult[] = [];

  for (const tc of testsToRun) {
    const start = Date.now();
    const relFile = path.relative(process.cwd(), tc.file);
    process.stdout.write(`  ${tc.name} (${relFile}) ... `);

    try {
      await tc.fn();
      const duration = Date.now() - start;
      results.push({
        name: tc.name,
        file: relFile,
        status: "pass",
        durationMs: duration,
      });
      console.log(`PASS (${duration}ms)`);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: tc.name,
        file: relFile,
        status: "fail",
        durationMs: duration,
        error: message,
      });
      console.log(`FAIL (${duration}ms)`);
      console.log(`    ${message}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const total = results.length;

  console.log(`\n${"─".repeat(50)}`);
  console.log(
    `Results: ${passed}/${total} passed, ${failed} failed`
  );
  console.log(`${"─".repeat(50)}\n`);

  // Write JSON results
  const resultsPath = path.resolve(import.meta.dirname, "../test-results.json");
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`Results written to: ${resultsPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

// Only run if this is the entry point
if (process.argv[1]?.includes("runner")) {
  run().catch((err) => {
    console.error("Runner failed:", err);
    process.exit(2);
  });
}
