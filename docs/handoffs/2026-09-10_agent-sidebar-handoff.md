# Handoff: Rally agent sidebar, ⌘K launcher, automatic preparation

Work in `~/splice/splice/rally2` (branch `rally-v2`). Read `CLAUDE.md` and `PITFALLS.md` first. Everything below is uncommitted on that branch.

## What exists now

- **Agent sidebar** (`src/components/AgentSidebar.tsx`, `AgentsPanel.tsx`): leftmost column, ⌘B toggles, collapses on half-screen snap, resizable edge. One row per panel (pod), grouped by project (origin repo). The old bottom stash dock and the titlebar PR pills are gone. The tool rail (files, search, threads) is hidden by default, ⌘⇧B.
- **⌘K launcher** (`TaskLauncher.tsx`): prompt box, native project dropdown (alphabetical, defaults to last used, else the project with most checkouts), "Read-only question" toggle. Rally picks a free checkout: no Claude mid-turn, no tracked changes, no open PR. `Message…` on a row opens the same launcher aimed at that agent.
- **Preparation** (`src/lib/taskPrep.ts`, pure logic in `src/lib/prepare.ts`): steps = deliver first, then the repo's `prepare` list from `RALLY.json` (bare string = blocking, `{script, background: true}` = ensure-running, never restart), then a branch step. First blocking step has the clean-tree guard (`assessSyncSafety`). No `prepare` block: `statusBarRight` scripts are blocking, watcher-named `statusBar` scripts are background. Delivery into an idle Claude REPL types `/clear` then the prompt; otherwise launches `claude --dangerously-skip-permissions '<prompt>'`. Branches: `danny/<task-slug>` from the default branch, placeholder `danny/<agent>-MMDD` on **Reset checkout**, renamed on the next task. Branches with commits or an open PR are never touched. All scripts run through the existing footer dots; there is no second status surface.
- **Status truth** (`src-tauri/src/claude_sessions.rs`, `src/stores/agentStore.ts`): Claude Code's `~/.claude/sessions/<pid>.json` mapped to Rally PTYs by parent-PID walk. `busy | waiting | idle`. Terminal silence is never "done". Fallback: OSC title spinner + BEL parsed from raw PTY output (`src/lib/ptyActivity.ts`).
- **Checkout health** (`git_ops::checkout_health`): default branch per repo (`rally.syncBranch` → `origin/HEAD` → staging/main/master), ahead/behind, dirty (tracked files only, `.DS_Store` excluded and restored before a guarded sync), nested `.claude/worktrees` detection, origin URL, git user name.
- **Tests**: `npx vitest run src` (39), `cargo test --lib` in `src-tauri` (19), e2e `./scripts/test.sh --skip-build tests/e2e/agent-tasks.test.ts` after `cargo tauri build --debug --features test-bridge --bundles app` (10 scenarios against the real app, launches real short Claude sessions, fixture at `~/.rally/test-fixtures/agent-tasks`, pre-trusted in `~/.claude.json`).

## Sidebar row model (applied 2026-09-10, revised 2026-09-11 after Danny's review)

Built in `src/lib/sidebarModel.ts` (pure, tested) and rendered by `AgentsPanel.tsx`:

1. **Project rows.** One per origin repo, alphabetical. Name, a count of free checkouts (free = no working/waiting agent, clean tree, no open PR — same rule as ⌘K), and a chevron. Click → ⌘K with the project chosen. Right-click → New task…, Reveal in Finder (submenu per checkout).
2. **Rows under a project: collapsed vs expanded (chevron, persisted per project).** Collapsed shows every panel visible on the canvas plus anything that matters now: a dot (working amber / needs you blue), a `!` problem, or an open PR. A panel Danny started by hand must never drop out of the sidebar when Claude reaches its prompt. Expanded shows every checkout as a row — one per open Claude panel, or one bare row for a checkout with no panel — so nothing is unreachable (Danny Ctrl-C'd an agent, it vanished, he was locked out). The expanded list replaces the collapsed one; it never stacks a second list. Second line: task description, else Claude's live topic while active, else the branch. Never a stale topic. Hidden panels stay listed, dimmed. Clicking a bare row starts a task there (⌘K aimed at that checkout) when it is free.
3. **PR once.** Pill flush right on the first row of a checkout with an open PR. A checkout with a PR and no panel keeps one row; click opens the PR.
4. **Merged rows.** Single-checkout project with exactly one row draws only that row, named after the project.
5. **Calm, tight.** Project row 28px, drawer row 24px, panel row 44px, fixed. 8px gutter both sides. No tooltips on rows (only the `!` mark and hover buttons). No middle dots. Right cluster order: eye (hover), `!`, dot, pill — the pill never moves.

⌘K: solid dark card (Danny found the frosted one too light), project picker, model picker (Fable / Opus, remembered), read-only toggle. The model goes to `claude --model <id>` on launch or `/model <id>` into a reused REPL.

Canvas: the `flight-focus-pod` event now runs the focus layout (`navigateToPod`) instead of panning to the pod's raw x — a pod added by ⌘K used to land alone on the left with the other columns off-screen.

## Pitfalls learned this session (also in PITFALLS.md)

- Launching Rally from a terminal inside a Claude Code session leaks `CLAUDE_CODE_*` env into PTYs; nested Claude then never registers. `pty_manager.rs` strips the namespace (`is_claude_session_env`).
- "Rebuilt but old UI" was a stale process: `run.sh` matched `MacOS/Rally` but the binary is `MacOS/rally`, so the kill never hit. Fixed to match the bundle directory. Not a WebKit cache.
- `git_cmd` trims stdout, so the first `git status --porcelain` line loses its leading column; parse by whitespace (`porcelain_path`).
- Flow has committed `.DS_Store` files Finder keeps modifying; they must never count as dirty.
- Claude Code's trust dialog blocks session registration; the e2e fixture path is stable and pre-trusted.
- The agent store's session poll is 2s; call `refreshSessions()` before any reuse/free decision.

## Verify before handing back

```
./scripts/check.sh
npx vitest run src
(cd src-tauri && cargo test --lib)
cargo tauri build --debug --features test-bridge --bundles app && ./scripts/test.sh --skip-build tests/e2e/agent-tasks.test.ts
./scripts/run.sh
```

Then screenshot the sidebar and compare against the rules above before reporting.
