/**
 * Vision-based evaluator — loads the design spec and structures
 * evaluation prompts for the agent.
 *
 * This module doesn't contain AI logic itself. It builds structured
 * prompts that an agent (Claude Code) uses to evaluate screenshots
 * against the design specification.
 */

import * as fs from "fs";
import * as path from "path";

const DESIGN_SPEC_PATH = path.resolve(import.meta.dirname, "../design-spec.md");

export interface EvaluationCriteria {
  /** Section of the design spec to reference (e.g., "Sidebar", "Color System") */
  section: string;
  /** Specific things to check */
  checks: string[];
}

export interface EvaluationPrompt {
  /** Path to the screenshot to evaluate */
  screenshotPath: string;
  /** The full evaluation prompt text */
  prompt: string;
  /** The relevant design spec excerpt */
  specExcerpt: string;
}

export class Evaluator {
  private specContent: string | null = null;

  /**
   * Load the design specification document.
   */
  loadSpec(): string {
    if (!this.specContent) {
      if (!fs.existsSync(DESIGN_SPEC_PATH)) {
        throw new Error(`Design spec not found at ${DESIGN_SPEC_PATH}`);
      }
      this.specContent = fs.readFileSync(DESIGN_SPEC_PATH, "utf-8");
    }
    return this.specContent;
  }

  /**
   * Extract a section from the design spec by heading.
   * Looks for a heading matching `sectionName` and returns everything
   * until the next heading of the same or higher level.
   */
  getSection(sectionName: string): string {
    const spec = this.loadSpec();
    const lines = spec.split("\n");
    let capturing = false;
    let captureLevel = 0;
    const captured: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();

        if (
          title.toLowerCase().includes(sectionName.toLowerCase()) &&
          !capturing
        ) {
          capturing = true;
          captureLevel = level;
          captured.push(line);
          continue;
        }

        if (capturing && level <= captureLevel) {
          break; // Hit next section at same or higher level
        }
      }

      if (capturing) {
        captured.push(line);
      }
    }

    return captured.join("\n").trim();
  }

  /**
   * Build a structured evaluation prompt for an agent to assess
   * a screenshot against the design spec.
   */
  buildEvaluation(
    screenshotPath: string,
    criteria: EvaluationCriteria
  ): EvaluationPrompt {
    const specExcerpt = this.getSection(criteria.section);

    const checksFormatted = criteria.checks
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");

    const prompt = `Evaluate this screenshot of Rally against the design specification.

## Design Spec Reference: ${criteria.section}

${specExcerpt}

## Evaluation Criteria

Check each of the following:
${checksFormatted}

## Instructions

1. Read the screenshot at: ${screenshotPath}
2. For each criterion, assess whether the UI matches the design spec
3. Report PASS or FAIL for each criterion with a brief explanation
4. Note any visual issues not covered by the explicit criteria

Format your response as:
- [PASS/FAIL] Criterion description: explanation
`;

    return {
      screenshotPath,
      prompt,
      specExcerpt,
    };
  }

  /**
   * Pre-built evaluation for sidebar visual compliance.
   */
  sidebarEvaluation(screenshotPath: string): EvaluationPrompt {
    return this.buildEvaluation(screenshotPath, {
      section: "Sidebar",
      checks: [
        "Background color matches spec (#1a1a1a)",
        "Text colors follow hierarchy (primary #ddd, active #eee)",
        "Icon colors are neutral (#aaa), not colored",
        "Font sizes are consistent (13px for items, 11px for headers)",
        "Spacing between items is uniform",
        "Active workspace has correct background (#2a2a2a)",
        "Border color matches spec (#333 for header border)",
      ],
    });
  }

  /**
   * Pre-built evaluation for overall layout coherence.
   */
  layoutEvaluation(screenshotPath: string): EvaluationPrompt {
    return this.buildEvaluation(screenshotPath, {
      section: "Layout",
      checks: [
        "Sidebar is positioned on the left",
        "Activity bar is visible and correctly sized (46px wide)",
        "Titlebar has correct height (~34px) with native traffic lights",
        "Main content fills remaining space",
        "No unexpected colored elements (buttons, icons should be neutral)",
        "Font family appears consistent throughout (system-ui/San Francisco)",
        "Dark theme colors are cohesive — no jarring brightness differences",
      ],
    });
  }
}

export const evaluator = new Evaluator();
