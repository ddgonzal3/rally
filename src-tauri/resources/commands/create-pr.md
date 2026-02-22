<!-- rally-create-pr-v1 -->
# Create PR: Branch (if needed), Push, and Open PR

You are creating a pull request for the current working changes. Follow each step exactly.

## Step 1: Detect State

```bash
BRANCH=$(git symbolic-ref --short HEAD)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$MAIN_BRANCH" ] && MAIN_BRANCH="main"
IS_DIRTY=$([ -n "$(git status --porcelain)" ] && echo "true" || echo "false")
EXISTING_PR=$(gh pr view --json number,state -q 'select(.state=="OPEN") | .number' 2>/dev/null)
echo "BRANCH=$BRANCH MAIN=$MAIN_BRANCH DIRTY=$IS_DIRTY EXISTING_PR=$EXISTING_PR"
```

**Guard rail**: If `EXISTING_PR` is not empty, STOP: "PR #$EXISTING_PR already exists for this branch. Push new commits to update it, or use /review-pr to review it."

## Step 2: Create Feature Branch (if on main)

If `BRANCH` equals `MAIN_BRANCH`:

1. Inspect the working tree to understand the changes:
   ```bash
   git diff --stat
   git diff --cached --stat
   git status --porcelain
   ```
2. Generate a short, descriptive kebab-case branch name based on the changes (e.g., `add-user-auth`, `fix-sidebar-layout`, `update-ship-command`). If there are no changes to inspect, use the surrounding conversation context.
3. Create and switch to the branch:
   ```bash
   git checkout -b <generated-branch-name>
   ```
4. Update: `BRANCH=<generated-branch-name>`

## Step 3: Commit if Dirty

Only if `IS_DIRTY=true`:

1. Read the diff to understand what changed:
   ```bash
   git diff --stat
   git diff --cached --stat
   ```

2. Write a concise, descriptive commit message based on the diff:
   ```bash
   git add -u
   git commit -m "<your descriptive message>"
   ```

If the working tree is clean and there are no new commits beyond main, STOP: "Nothing to create a PR for — no changes found."

## Step 4: Push

```bash
git push 2>/dev/null || git push --set-upstream origin "$BRANCH"
```

## Step 5: Analyze Changes and Create PR

Read the full diff against main to write a good PR description:

```bash
git diff "$MAIN_BRANCH"..."$BRANCH" --stat
git log --oneline "$MAIN_BRANCH".."$BRANCH"
git diff "$MAIN_BRANCH"..."$BRANCH"
```

Based on the diff, create the PR with a clear title and structured body:

```bash
gh pr create --title "<concise title describing the change>" --body "<structured body>"
```

**PR body format:**
```
## Summary

<1-3 sentences describing what this PR does and why>

## Changes

- <bullet points of key changes>

## Test Plan

- <how to verify the changes work>
```

## Step 6: Final Output

```bash
PR_NUM=$(gh pr view --json number -q '.number')
PR_URL=$(gh pr view --json url -q '.url')
echo "PR_NUMBER=$PR_NUM PR_URL=$PR_URL"
```

Print a summary:
- PR number and URL
- Branch name
- Number of commits
- Files changed
