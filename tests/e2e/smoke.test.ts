/**
 * Smoke test — verifies the app launches, the bridge is injected,
 * and basic UI elements are present.
 */

import { test, expect } from "../framework/runner.js";
import { bridge } from "../framework/bridge.js";
import { screenshot } from "../framework/screenshot.js";

test("app is ready and bridge is injected", async () => {
  const ready = await bridge.isReady();
  expect.toBe(ready, true, "App should report ready via health endpoint");

  const bridgeReady = await bridge.eval<boolean>(
    "return window.__rallyTest.ready()"
  );
  expect.toBe(bridgeReady, true, "Bridge should be injected and ready");
});

test("document has a title", async () => {
  const title = await bridge.eval<string>("return document.title");
  expect.toBeTruthy(title, "Document should have a title");
});

test("app root is mounted", async () => {
  // The React app should be mounted in #root with child elements
  const rootChildren = await bridge.eval<number>(
    "return document.querySelector('#root')?.children?.length || 0"
  );
  expect.toBeGreaterThan(
    rootChildren,
    0,
    "React root should have children (app is mounted)"
  );
});

test("store is accessible", async () => {
  const state = await bridge.getStoreState();
  expect.toBeNotNull(state, "Store state should be accessible via bridge");
  // Workspaces array should exist (even if empty)
  const hasWorkspaces = await bridge.eval<boolean>(
    "return Array.isArray(window.__rallyTest.getStoreState()?.workspaces)"
  );
  expect.toBe(hasWorkspaces, true, "Store should have a workspaces array");
});

test("capture initial screenshot", async () => {
  // Wait a moment for any animations to settle
  await new Promise((resolve) => setTimeout(resolve, 500));
  const path = screenshot.capture("smoke-initial");
  expect.toBeTruthy(path, "Screenshot should be captured successfully");
});
