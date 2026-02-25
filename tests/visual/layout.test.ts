/**
 * Visual layout tests — capture screenshots at key UI states
 * and build evaluation prompts for agent-based visual review.
 *
 * These tests capture screenshots and generate evaluation criteria.
 * The actual visual assessment is done by the agent reading the
 * screenshots and evaluating them against the design spec.
 */

import { test, expect } from "../framework/runner.js";
import { bridge } from "../framework/bridge.js";
import { screenshot } from "../framework/screenshot.js";
import { evaluator } from "../framework/evaluator.js";

test(
  "capture and evaluate overall layout",
  async () => {
    await new Promise((r) => setTimeout(r, 500));
    const path = screenshot.capture("layout-overall");

    // Build the evaluation prompt (agent will use this to assess the screenshot)
    const evaluation = evaluator.layoutEvaluation(path);

    // Log the evaluation for the agent to review
    console.log("\n--- VISUAL EVALUATION PROMPT ---");
    console.log(evaluation.prompt);
    console.log("--- END EVALUATION ---\n");

    // The test "passes" if the screenshot was captured successfully.
    // Visual assessment is done by the agent after the test run.
    expect.toBeTruthy(path, "Screenshot captured for layout evaluation");
  },
  { tags: ["visual"] }
);

test(
  "capture sidebar view for evaluation",
  async () => {
    await new Promise((r) => setTimeout(r, 300));
    const path = screenshot.capture("sidebar-view");

    const evaluation = evaluator.sidebarEvaluation(path);

    console.log("\n--- VISUAL EVALUATION PROMPT ---");
    console.log(evaluation.prompt);
    console.log("--- END EVALUATION ---\n");

    expect.toBeTruthy(path, "Screenshot captured for sidebar evaluation");
  },
  { tags: ["visual"] }
);

test(
  "verify color values via computed styles",
  async () => {
    // Check that we can read computed styles from the app
    // This validates that the bridge can inspect CSS properties

    // Try to read the body background color
    const bodyBg = await bridge.eval<string>(
      "return window.getComputedStyle(document.body).backgroundColor"
    );
    expect.toBeNotNull(bodyBg, "Should be able to read body background color");

    // If we can access CSS, log some key values for the agent to compare
    // against the design spec
    console.log("\n--- COMPUTED STYLE VALUES ---");
    console.log(`body background: ${bodyBg}`);

    const bodyColor = await bridge.eval<string>(
      "return window.getComputedStyle(document.body).color"
    );
    console.log(`body color: ${bodyColor}`);

    const bodyFont = await bridge.eval<string>(
      "return window.getComputedStyle(document.body).fontFamily"
    );
    console.log(`body font: ${bodyFont}`);
    console.log("--- END COMPUTED STYLES ---\n");
  },
  { tags: ["visual"] }
);
