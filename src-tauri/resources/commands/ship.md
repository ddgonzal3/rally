<!-- rally-ship-v7 -->
# Ship: Commit, Push, PR, Review, Merge

You are automating the full ship lifecycle for the current branch. Follow each step exactly. Run the shell scripts verbatim — do NOT improvise git commands outside these scripts.

## Progress Tracking via Signal File

Rally tracks ship progress by reading the signal file. Before starting each major step, update the signal file with the current phase. This lets Rally show a status pill regardless of where `/ship` is running.

**First, run this setup once at the very beginning** (before Step 1) to initialize variables and the helper function:

```bash
REPO_PATH=$(git rev-parse --show-toplevel)
SANITIZED=$(echo "$REPO_PATH" | sed 's|^/||; s|/|--|g')
SIGNAL_DIR="$HOME/.rally/ship-signals"
mkdir -p "$SIGNAL_DIR"
SIGNAL_FILE="$SIGNAL_DIR/$SANITIZED.json"
SHIP_BRANCH=$(git symbolic-ref --short HEAD)
SHIP_PR_NUM=0
SHIP_PR_URL=""
```

**Then, before each step, write the phase signal.** Use this exact pattern (replacing `PHASE_NAME` with the phase):

```bash
cat > "$SIGNAL_FILE" << SIGNAL_EOF
{
  "version": 1,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repo_path": "$REPO_PATH",
  "branch": "$SHIP_BRANCH",
  "verdict": "shipping",
  "phase": "PHASE_NAME",
  "pr_number": $SHIP_PR_NUM,
  "pr_url": "$SHIP_PR_URL",
  "summary": "",
  "flagged_items": []
}
SIGNAL_EOF
```

The phases are: `detecting`, `committing`, `pushing`, `creating_pr`, `checking`, `reviewing`, `writing_verdict`, `complete`.

**Important:** After Step 4 discovers the PR number and URL, update `SHIP_PR_NUM` and `SHIP_PR_URL` so subsequent phase signals include them.

## Step 1: Detect State

Write the phase signal with `"phase": "detecting"`, then run this exact script:

```bash
BRANCH=$(git symbolic-ref --short HEAD)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$MAIN_BRANCH" ] && MAIN_BRANCH="main"
IS_DIRTY=$([ -n "$(git status --porcelain)" ] && echo "true" || echo "false")
HAS_REMOTE=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null && echo "true" || echo "false")
echo "BRANCH=$BRANCH MAIN=$MAIN_BRANCH DIRTY=$IS_DIRTY REMOTE=$HAS_REMOTE"
SHIP_BRANCH="$BRANCH"
```

Store these values for subsequent steps.

**Guard rail**: If `BRANCH` equals `MAIN_BRANCH`:

1. Look at the working tree changes (`git diff --stat`, `git diff --cached --stat`, `git status --porcelain`) to understand what's being shipped.
2. Generate a short, descriptive kebab-case branch name based on the changes (e.g., `add-user-auth`, `fix-sidebar-layout`, `update-ship-command`). If there are no changes to inspect, use the surrounding conversation context.
3. Create and switch to the branch:
   ```bash
   git checkout -b <generated-branch-name>
   ```
4. Update the tracking variable:
   ```bash
   SHIP_BRANCH="<generated-branch-name>"
   ```
5. Continue with Step 2.

## Step 2: Commit if Dirty

Write the phase signal with `"phase": "committing"`, then:

Only if `IS_DIRTY=true`:

1. First, read the diff to understand what changed:
   ```bash
   git diff --stat
   git diff --cached --stat
   ```

2. Write a concise, descriptive commit message based on the diff, then:
   ```bash
   git add -u
   git commit -m "<your descriptive message>"
   ```

This is the ONE non-deterministic part — use your judgment on the commit message.

## Step 3: Push

Write the phase signal with `"phase": "pushing"`, then:

```bash
git push 2>/dev/null || git push --set-upstream origin "$(git symbolic-ref --short HEAD)"
```

If push is rejected (diverged after rebase), use:
```bash
git push --force-with-lease
```

## Step 4: Create PR if Needed

Write the phase signal with `"phase": "creating_pr"`, then:

```bash
PR_NUM=$(gh pr view --json number,state -q 'select(.state=="OPEN") | .number' 2>/dev/null)
if [ -z "$PR_NUM" ]; then
  gh pr create --fill
  PR_NUM=$(gh pr view --json number -q '.number')
fi
PR_URL=$(gh pr view "$PR_NUM" --json url -q '.url')
echo "PR_NUMBER=$PR_NUM PR_URL=$PR_URL"
```

**Update the tracking variables** so subsequent phase signals include PR info:
```bash
SHIP_PR_NUM=$PR_NUM
SHIP_PR_URL="$PR_URL"
```

## Step 5: Check Conflicts

Write the phase signal with `"phase": "checking"`, then:

```bash
MERGEABLE=$(gh pr view "$PR_NUM" --json mergeable -q '.mergeable')
echo "MERGEABLE=$MERGEABLE"
```

If `MERGEABLE=CONFLICTING`:
- Tell the user: "PR has merge conflicts. Resolve them before shipping."
- Write the signal file with `verdict: "manual_review"` and a summary explaining the conflict.
- STOP.

## Step 5b: Sanity Check — Is This PR Worth Merging?

Before reviewing, check what's actually in this PR:

```bash
gh pr diff "$PR_NUM" --stat
```

If the PR contains **only** trivial or empty changes (e.g., just an empty file, only whitespace changes, only a placeholder/stub with no real implementation), do NOT auto-merge. Instead:
- Write the signal file with `verdict: "manual_review"`
- Set the summary to explain why: "This PR appears to contain only trivial/empty changes (e.g., an empty markdown file). Please verify this is intentional before merging."
- STOP.

This prevents accidentally shipping placeholder files, empty stubs, or accidental commits.

## Step 6: Review

Write the phase signal with `"phase": "reviewing"`, then:

Read `~/.rally/commands/review-pr.md` and follow its full review process for the current branch. This is the same process used by the standalone `/review-pr` command.

**Important differences from standalone review-pr:**
- After the review fixes are applied and staged, **commit and push them** (review-pr alone only stages):
  ```bash
  git add -u
  git commit -m "fix: address review findings"
  git push
  ```
- Use the review findings to determine the verdict in Step 7.

## Step 7: Determine Verdict

Based on the review:

- **`auto_merge`**: No remaining critical issues. All fixes applied and pushed. PR is ready.
- **`manual_review`**: There are flagged items the user should look at, or you're unsure about a fix.

## Step 8: Write Final Signal File

Write the phase signal with `"phase": "writing_verdict"`, then write the final signal with the verdict:

```bash
cat > "$SIGNAL_FILE" << 'SIGNAL_EOF'
{
  "version": 1,
  "timestamp": "<ISO 8601 timestamp>",
  "repo_path": "<absolute repo path>",
  "branch": "<branch name>",
  "verdict": "<auto_merge or manual_review>",
  "phase": "complete",
  "pr_number": <number>,
  "pr_url": "<full GitHub PR URL>",
  "summary": "<one paragraph review summary>",
  "flagged_items": []
}
SIGNAL_EOF
```

For `flagged_items`, include any issues you chose NOT to fix:
```json
{ "file": "src/foo.ts", "line": 42, "severity": "suggestion", "description": "Consider extracting..." }
```

## Step 9: Final Output

### If `auto_merge`:
Print a summary of what was done:
- Commits made
- PR created/updated
- Review findings fixed
- "Signal written — Rally will merge and sync automatically."

### If `manual_review`:
Print the review report with flagged items. Stay available for the user to discuss and iterate. When the user is satisfied, update the signal file verdict to `auto_merge` and push any final changes.
