<!-- rally-ship-v2 -->
# Ship: Commit, Push, PR, Review, Merge

You are automating the full ship lifecycle for the current branch. Follow each step exactly. Run the shell scripts verbatim — do NOT improvise git commands outside these scripts.

## Step 1: Detect State

Run this exact script:

```bash
BRANCH=$(git symbolic-ref --short HEAD)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$MAIN_BRANCH" ] && MAIN_BRANCH="main"
IS_DIRTY=$([ -n "$(git status --porcelain)" ] && echo "true" || echo "false")
HAS_REMOTE=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null && echo "true" || echo "false")
echo "BRANCH=$BRANCH MAIN=$MAIN_BRANCH DIRTY=$IS_DIRTY REMOTE=$HAS_REMOTE"
```

Store these values for subsequent steps.

**Guard rail**: If `BRANCH` equals `MAIN_BRANCH`, STOP and tell the user: "You're on the main branch. Create a feature branch first."

## Step 2: Commit if Dirty

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

```bash
git push 2>/dev/null || git push --set-upstream origin "$(git symbolic-ref --short HEAD)"
```

If push is rejected (diverged after rebase), use:
```bash
git push --force-with-lease
```

## Step 4: Create PR if Needed

```bash
PR_NUM=$(gh pr view --json number -q '.number' 2>/dev/null)
if [ -z "$PR_NUM" ]; then
  gh pr create --fill
  PR_NUM=$(gh pr view --json number -q '.number')
fi
echo "PR_NUMBER=$PR_NUM"
```

## Step 5: Check Conflicts

```bash
MERGEABLE=$(gh pr view "$PR_NUM" --json mergeable -q '.mergeable')
echo "MERGEABLE=$MERGEABLE"
```

If `MERGEABLE=CONFLICTING`:
- Tell the user: "PR has merge conflicts. Resolve them before shipping."
- Write the signal file with `verdict: "manual_review"` and a summary explaining the conflict.
- STOP.

## Step 6: Review

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

## Step 8: Write Signal File

```bash
REPO_PATH=$(git rev-parse --show-toplevel)
SANITIZED=$(echo "$REPO_PATH" | sed 's|^/||; s|/|--|g')
SIGNAL_DIR="$HOME/.rally/ship-signals"
mkdir -p "$SIGNAL_DIR"
```

Then write the signal JSON. Use the exact format — the app parses this:

```bash
cat > "$SIGNAL_DIR/$SANITIZED.json" << 'SIGNAL_EOF'
{
  "version": 1,
  "timestamp": "<ISO 8601 timestamp>",
  "repo_path": "<absolute repo path>",
  "branch": "<branch name>",
  "verdict": "<auto_merge or manual_review>",
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
