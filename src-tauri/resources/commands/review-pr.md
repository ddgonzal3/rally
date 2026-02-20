<\!-- playbench-review-pr-v1 -->
# PR Review (Edit, Fix Loop & Stage)

You are a senior engineer orchestrating a thorough, iterative code review. Your goal is to leave the code **meaningfully better** than you found it.

**CRITICAL: All review work MUST be delegated to Task agents.** The main agent handles only orchestration (branch detection, merging findings, applying fixes, staging, and reporting). This keeps the main conversation context clean and unaffected by the volume of code read during review.

## Step 1: Determine the Base Branch (Main Agent)

This is lightweight — do it directly.

1. **If PR number provided**:

   ```bash
   gh pr view <number> --json baseRefName,headRefName,files
   ```

2. **If branch name provided**:

   ```bash
   gh pr list --head <branch-name> --json number,baseRefName
   # If no PR exists, ask the user for the target branch
   ```

3. **If "current branch" or no input**:
   ```bash
   gh pr view --json baseRefName,number 2>/dev/null
   # If no PR, detect default branch
   git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'
   ```

Store: `BASE_BRANCH="<determined-base>"`

## Step 2: Collect Changed File List (Main Agent)

Run these commands to get the file list and stats — but do NOT read the files yourself:

```bash
git diff --name-only $(git merge-base HEAD $BASE_BRANCH)...HEAD
git diff --stat $(git merge-base HEAD $BASE_BRANCH)...HEAD
git log --oneline $(git merge-base HEAD $BASE_BRANCH)...HEAD
```

Use the file count to decide the review strategy in Step 3.

## Step 3: Delegate Review to Task Agents

**All code reading and review happens in subagents.** Never read changed files or diffs in the main context.

### Small PRs (1-4 files, single layer)

Launch **one** Task agent (subagent_type: `general-purpose`) with this prompt structure:

```
You are a senior engineer doing a thorough code review. Review the PR diff and changed files against the checklist below.

BASE_BRANCH: <base>
Changed files: <file list>

## Instructions

1. Run: git diff $(git merge-base HEAD <base>)...HEAD
2. Read each changed file completely
3. Understand what the PR is trying to accomplish
4. Review against EVERY checklist category below
5. For each issue found, note: file, line, severity, description
6. Return your findings in the structured format at the bottom

<include the full Review Checklist from below>
<include the Severity Levels from below>
<include the Output Format from below>
```

### Large PRs (5+ files or multiple layers)

Launch **three** Task agents in parallel (subagent_type: `general-purpose`), each with a focused perspective. Give each agent the same base context (branch, file list, instructions to read the diff and files) but different checklist sections:

| Agent      | Focus Areas                                                | Checklist Sections |
| ---------- | ---------------------------------------------------------- | ------------------ |
| Reviewer A | Architecture, patterns, DRY compliance, service boundaries | 3, 4               |
| Reviewer B | Correctness, security, edge cases, resource cleanup        | 1, 2, 6            |
| Reviewer C | Readability, type safety, PR hygiene, dead code            | 5, 7, 8            |

Each agent prompt should include:
- The base branch and file list
- Instructions to run `git diff` and read all changed files
- Only their assigned checklist sections
- The severity levels and output format

### Review Checklist (Include in Agent Prompts)

#### Severity Levels

- **Critical** — Must fix before merge. Bugs, security issues, data integrity risks, broken functionality.
- **Suggestion** — Should strongly consider. Readability improvements, better patterns, missing edge cases.
- **Nitpick** — Optional. Style preferences, minor naming improvements, cosmetic issues.

#### 1. Correctness (Critical priority)

- [ ] Logic handles all expected inputs correctly
- [ ] No off-by-one errors, null/undefined hazards, or unhandled promise rejections
- [ ] Error handling is present and appropriate (not swallowing errors silently)
- [ ] No race conditions in async code (RxJS subscription ordering, goroutine safety, channel usage)
- [ ] Resources are cleaned up (subscriptions via `takeUntilDestroyed`/`unsubscribe`, deferred closes in Go)
- [ ] State mutations happen at the right time (not in constructors for Angular, not in init for Go without proper locking)

#### 2. Security

- [ ] No XSS vulnerabilities in templates (no `innerHTML` with untrusted data)
- [ ] No SQL injection risks (parameterized queries in Go, no string concatenation for queries)
- [ ] Input validation at system boundaries (user input, IPC messages, API responses, gRPC requests)
- [ ] Secrets, API keys, and credentials are not hardcoded or committed
- [ ] File paths from user input are validated before native/filesystem calls
- [ ] Auth checks present on protected endpoints (Twirp auth annotations, session checks)

#### 3. Architecture

- [ ] Changes follow existing patterns (handler → service → store for Go; component → service for Angular)
- [ ] Correct layer separation (components don't contain business logic, handlers don't contain DB queries)
- [ ] No DRY violations — check if similar code already exists in shared services or libs
- [ ] New utilities are placed in the correct location (shared lib vs. local to feature)
- [ ] No circular dependencies introduced
- [ ] Event bus / gRPC communication follows established patterns

#### 4. Code Cleanliness

- [ ] Functions are small and focused
- [ ] Naming is clear and descriptive (follows project conventions)
- [ ] No dead code, commented-out code, or TODOs without context
- [ ] No magic numbers — constants are extracted and named
- [ ] Complex logic is extracted into well-named helper functions
- [ ] No unused imports, variables, or injected services

#### 5. Readability

- [ ] Code intent is clear without excessive comments
- [ ] Comments explain "why", not "what"
- [ ] Consistent style with the rest of the codebase
- [ ] RxJS pipes are readable (not 15 operators deep without intermediate variables)
- [ ] Angular template expressions are simple (complex logic belongs in the component class)
- [ ] Go error wrapping provides context (`fmt.Errorf("failed to X: %w", err)`)

#### 6. Performance

- [ ] No unnecessary re-renders or change detection cycles (Angular)
- [ ] Large lists use `trackBy` in `*ngFor`
- [ ] No N+1 patterns in data fetching (SQL queries in loops, repeated gRPC calls)
- [ ] Canvas rendering is optimized (no redundant draws)
- [ ] Expensive computations are cached or memoized where appropriate
- [ ] No memory leaks (subscriptions, event listeners, intervals, goroutines cleaned up)
- [ ] Database queries use appropriate indexes

#### 7. Type Safety

- [ ] No `any` types in TypeScript — use `unknown` with type guards or proper generics
- [ ] Exported functions have explicit return types
- [ ] Types are imported with `import type` when only used for type checking
- [ ] Interfaces/types are in the right location (shared types file vs. local)
- [ ] Go: proper error type assertions, no unchecked type conversions

#### 8. PR Hygiene

- [ ] Changes are focused on a single concern (not mixing features with unrelated refactors)
- [ ] No unrelated formatting or whitespace-only diffs
- [ ] No temporary debug logging left in (`console.log`, `debugger`, `fmt.Println`)
- [ ] Commit messages are clear and follow conventional commits format

### Agent Output Format (Include in Agent Prompts)

Tell each agent to return findings in this exact structure:

```
## Findings

### Critical
- `file.ts:42` — [Description of the issue and suggested fix]

### Suggestions
- `file.ts:15` — [Description and rationale]

### Nitpicks
- `file.ts:88` — [Minor observation]

### Summary
[One paragraph: What is the PR doing? Overall quality assessment.]
```

## Step 4: Merge Findings & Fix Issues (Main Agent)

Once all review agents return:

1. **Merge findings** — combine all agent results into a single list
2. **Deduplicate** — if multiple agents flag the same issue, elevate its severity
3. **Fix all Critical issues** — read only the specific files/lines needed, make targeted fixes
4. **Fix reasonable Suggestions** — apply improvements that are clearly beneficial
5. **Re-review fixes** — launch a quick follow-up Task agent to verify your fixes didn't introduce new issues (give it only the files you modified and ask it to check for correctness)
6. **Iterate** — if the follow-up agent finds new issues, fix and re-verify until clean

**Use your judgment on fixes:**

- If fixing something requires touching code far outside the PR's diff, note it but skip it
- If a fix is risky (behavior might change), make the fix but flag it clearly in the report
- If you're unsure, err on the side of making the change — the author can revert

## Step 5: Stage Changes (Main Agent)

```bash
git add -u  # or specific files
```

**DO NOT COMMIT.** The user will commit when ready.

## Step 6: Report (Main Agent)

```markdown
## PR Review: <branch> → <parent>

**Files changed**: <count>
**Insertions**: +<count> | **Deletions**: -<count>
**Review passes**: <number of iterations before clean>

### Summary

[One paragraph: What was the PR trying to do? What state did you find it in? What's the overall quality delta from your changes?]

### Critical Issues Fixed

- `file.ts:42` — [Description of the issue and what you did]

### Suggestions Applied

- `file.ts:15` — [Description and rationale]

### Nitpicks (For Your Awareness)

- `file.ts:88` — [Minor observation, not fixed]

### Not Fixed (Out of Scope or Too Risky)

- [Issues you noticed but intentionally left alone, with reasoning]

### Flagged for Author Review

- [Changes where you made a judgment call they should verify]

### Test These Areas

- [Specific user flows or edge cases that touch your changes]
```

If no issues are found in a category, omit that section entirely.

## What "Good Enough" Looks Like

After your pass, the code should:

- Be readable without needing the PR description for context
- Handle failure cases explicitly
- Have no obvious duplication
- Use names that explain intent
- Be no more complex than necessary

If you only find trivial issues (unused imports, minor formatting), say so explicitly — but also consider whether you looked hard enough.
