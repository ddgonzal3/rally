import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyTitle,
  clearPtyActivity,
  hasUnansweredBell,
  markPtyInput,
  observePtyOutput,
  ptyBellAt,
  ptyTerminalTitles,
} from "./ptyActivity";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

describe("classifyTitle", () => {
  it("recognises Claude Code prefixes", () => {
    expect(classifyTitle("✳ Fix export bug", 1)).toEqual({ title: "Fix export bug", claude: "idle", at: 1 });
    expect(classifyTitle("⠂ Fix export bug", 1).claude).toBe("busy");
    expect(classifyTitle("⠐ Fix export bug", 1).claude).toBe("busy");
    expect(classifyTitle("zsh", 1)).toEqual({ title: "zsh", claude: "none", at: 1 });
  });
});

describe("observePtyOutput", () => {
  beforeEach(() => clearPtyActivity("p"));

  it("parses an OSC 0 title terminated by BEL without counting it as a bell", () => {
    observePtyOutput("p", bytes("\x1b]0;✳ Topic here\x07"), 5);
    expect(ptyTerminalTitles.get("p")).toEqual({ title: "Topic here", claude: "idle", at: 5 });
    expect(ptyBellAt.has("p")).toBe(false);
  });

  it("parses OSC 2 with ST terminator across chunk boundaries", () => {
    observePtyOutput("p", bytes("\x1b]2;⠂ Hal"), 1);
    observePtyOutput("p", bytes("f done\x1b\\"), 2);
    expect(ptyTerminalTitles.get("p")).toEqual({ title: "Half done", claude: "busy", at: 2 });
  });

  it("ignores non-title OSC codes (e.g. OSC 7 cwd)", () => {
    observePtyOutput("p", bytes("\x1b]7;file://host/tmp\x07"), 1);
    expect(ptyTerminalTitles.has("p")).toBe(false);
  });

  it("records a standalone bell and clears attention after input", () => {
    observePtyOutput("p", bytes("done\x07"), 100);
    expect(ptyBellAt.get("p")).toBe(100);
    expect(hasUnansweredBell("p")).toBe(true);
    markPtyInput("p", 150);
    expect(hasUnansweredBell("p")).toBe(false);
  });

  it("survives runaway sequences", () => {
    observePtyOutput("p", bytes("\x1b]0;" + "x".repeat(2000)), 1);
    observePtyOutput("p", bytes("\x07plain\x07"), 2);
    // The runaway OSC was abandoned; the later bare BEL counts.
    expect(ptyBellAt.get("p")).toBe(2);
  });
});
