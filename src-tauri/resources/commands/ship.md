<!-- rally-ship-v8 -->
# Ship: Sync, Push, PR, Review, Merge

You are automating the ship lifecycle for the current branch. Follow each step exactly. This command does NOT commit — the user must have already committed their work.

## Progress Tracking via Signal File

Rally tracks ship progress by reading the signal file. Before starting each major step, update the signal file with the current phase.

**First, run this setup once at the very beginning:**

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

Phases: `detecting`, `syncing`, `pushing`, `creating_pr`, `checking`, `reviewing`, `writing_verdict`, `merging`, `complete`.

**Important:** After Step 3 discovers the PR number and URL, update `SHIP_PR_NUM` and `SHIP_PR_URL` so subsequent phase signals include them.

## Step 1: Detect & Guard

Write the phase signal with `"phase": "detecting"`, then:

```bash
BRANCH=$(git symbolic-ref --short HEAD)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$MAIN_BRANCH" ] && MAIN_BRANCH="main"
IS_DIRTY=$([ -n "$(git status --porcelain)" ] && echo "true" || echo "false")
AHEAD=$(git rev-list --count "$MAIN_BRANCH".."$BRANCH" 2>/dev/null || echo "0")
echo "BRANCH=$BRANCH MAIN=$MAIN_BRANCH DIRTY=$IS_DIRTY AHEAD=$AHEAD"
SHIP_BRANCH="$BRANCH"
```

**Guard rails — STOP if any of these fail:**
- If `BRANCH` equals `MAIN_BRANCH`: "Cannot ship from main. Switch to a feature branch first."
- If `IS_DIRTY=true`: "Working tree is dirty. Commit your changes first, then run /ship again."
- If `AHEAD=0`: "No commits ahead of $MAIN_BRANCH. Nothing to ship."

## Step 2: Sync Branch

Write the phase signal with `"phase": "syncing"`, then rebase onto main:

```bash
git checkout "$MAIN_BRANCH"
git pull
git rebase "$MAIN_BRANCH" "$BRANCH"
```

If the rebase fails due to conflicts:
- Write signal with `verdict: "manual_review"` and summary explaining the conflict.
- Tell the user: "Rebase onto $MAIN_BRANCH has conflicts. Resolve them, then run /ship again."
- STOP.

## Step 3: Push & Create PR

Write the phase signal with `"phase": "pushing"`, then:

```bash
git push 2>/dev/null || git push --set-upstream origin "$BRANCH"
```

If push is rejected (diverged), use `git push --force-with-lease`.

Write the phase signal with `"phase": "creating_pr"`, then:

```bash
PR_NUM=$(gh pr view --json number,state -q 'select(.state=="OPEN") | .number' 2>/dev/null)
if [ -z "$PR_NUM" ]; then
  gh pr create --fill
  PR_NUM=$(gh pr view --json number -q '.number')
fi
PR_URL=$(gh pr view "$PR_NUM" --json url -q '.url')
echo "PR_NUMBER=$PR_NUM PR_URL=$PR_URL"
SHIP_PR_NUM=$PR_NUM
SHIP_PR_URL="$PR_URL"
```

## Step 4: Check Conflicts

Write the phase signal with `"phase": "checking"`, then:

```bash
MERGEABLE=$(gh pr view "$PR_NUM" --json mergeable -q '.mergeable')
echo "MERGEABLE=$MERGEABLE"
```

If `MERGEABLE=CONFLICTING`:
- Write signal with `verdict: "manual_review"` and summary explaining the conflict.
- STOP.

**Sanity check:** Run `gh pr diff "$PR_NUM" --stat`. If the PR contains only trivial/empty changes, write signal with `verdict: "manual_review"` and summary explaining why. STOP.

## Step 5: Review

Write the phase signal with `"phase": "reviewing"`, then:

Read `~/.rally/commands/review-pr.md` and follow its full review process for the current branch.

**After the review completes, determine the verdict based on findings.**

## Step 6: Apply Verdict

### If low-risk (no flagged items requiring user attention):

1. If the review made any changes:
   ```bash
   git add -u
   git commit -m "Review fixes"
   git push
   ```

2. Write the phase signal with `"phase": "merging"`, then auto-merge and sync:
   ```bash
   "$HOME/.rally/bin/gmerge"
   ```

3. Write the final signal file with `verdict: "auto_merge"`, `phase: "complete"`, and a summary.

4. Print summary: what was reviewed, what was fixed, PR merged and branch synced.

### If flagged (issues requiring user attention):

1. Stage the review changes (do NOT commit or push):
   ```bash
   git add -u
   ```

2. Write the final signal file with `verdict: "manual_review"`, `phase: "complete"`, summary, and flagged_items.

3. Print the review report with flagged items. Then:
   "Changes staged. Review them, then run `gfinish "your message"` when ready."

## Final Signal File Format

```bash
cat > "$SIGNAL_FILE" << 'SIGNAL_EOF'
{
  "version": 1,
  "timestamp": "<ISO 8601>",
  "repo_path": "<repo path>",
  "branch": "<branch>",
  "verdict": "<auto_merge or manual_review>",
  "phase": "complete",
  "pr_number": <number>,
  "pr_url": "<url>",
  "summary": "<one paragraph>",
  "flagged_items": []
}
SIGNAL_EOF
```

For flagged_items:
```json
{ "file": "src/foo.ts", "line": 42, "severity": "suggestion", "description": "Consider extracting..." }
```
