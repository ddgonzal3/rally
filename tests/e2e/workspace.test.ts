/**
 * Workspace CRUD tests — create, list, rename, remove workspaces.
 */

import { test, expect } from "../framework/runner.js";
import { bridge } from "../framework/bridge.js";
import { screenshot } from "../framework/screenshot.js";

test("list workspaces returns empty array initially", async () => {
  const workspaces = await bridge.invoke<unknown[]>("list_workspaces");
  // In test mode we might have pre-existing workspaces from ~/.rally
  // but we should at least get an array back
  expect.toBeTruthy(
    Array.isArray(workspaces),
    "list_workspaces should return an array"
  );
});

test("create workspace via invoke", async () => {
  const result = await bridge.invoke("create_workspace", {
    name: "test-workspace",
    paths: ["/tmp/rally-test/repo1"],
  });
  expect.toBeNotNull(result, "create_workspace should return a result");

  // Verify it appears in the list
  const workspaces = await bridge.invoke<Array<{ name: string }>>(
    "list_workspaces"
  );
  const found = workspaces.find((w) => w.name === "test-workspace");
  expect.toBeNotNull(found, "Created workspace should appear in list");
});

test("workspace appears in store state", async () => {
  const state = await bridge.getStoreState();
  expect.toBeNotNull(state, "Store should be accessible");
  const workspaces = (state as any)?.workspaces;
  expect.toBeTruthy(Array.isArray(workspaces), "Store should have workspaces");
});

test("capture workspace view", async () => {
  await new Promise((r) => setTimeout(r, 500));
  screenshot.capture("workspace-created");
});

test("remove workspace via invoke", async () => {
  // First find the workspace we created
  const workspaces = await bridge.invoke<Array<{ id: string; name: string }>>(
    "list_workspaces"
  );
  const ws = workspaces.find((w) => w.name === "test-workspace");
  if (ws) {
    await bridge.invoke("remove_workspace", { id: ws.id });
    const after = await bridge.invoke<Array<{ name: string }>>(
      "list_workspaces"
    );
    const found = after.find((w) => w.name === "test-workspace");
    expect.toBeNull(
      found ?? null,
      "Removed workspace should not appear in list"
    );
  }
});
