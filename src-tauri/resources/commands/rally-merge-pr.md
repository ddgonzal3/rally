<!-- rally-merge-pr-v1 -->
# Merge PR: Merge, Sync, Stay on Feature Branch

You are merging the current branch's PR and syncing the feature branch with main. Follow each step exactly.

## Step 1: Detect State

```bash
BRANCH=$(git symbolic-ref --short HEAD)
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
[ -z "$MAIN_BRANCH" ] && MAIN_BRANCH="main"
PR_NUM=$(gh pr view --json number -q '.number' 2>/dev/null)
echo "BRANCH=$BRANCH MAIN=$MAIN_BRANCH PR=$PR_NUM"
```

**Guard rails:**
- If `BRANCH` equals `MAIN_BRANCH`, STOP: "You're on the main branch. Switch to the feature branch whose PR you want to merge."
- If `PR_NUM` is empty, STOP: "No PR found for this branch. Create a PR first."

## Step 2: Verify PR is Mergeable

```bash
MERGEABLE=$(gh pr view "$PR_NUM" --json mergeable -q '.mergeable')
echo "MERGEABLE=$MERGEABLE"
```

If `MERGEABLE=CONFLICTING`, STOP: "PR has merge conflicts. Resolve them before merging."

## Step 3: Merge the PR

Merge with squash. Do NOT delete the remote branch.

```bash
gh pr merge "$PR_NUM" --squash
```

## Step 4: Sync Feature Branch

After the merge is complete, sync the local environment:

```bash
# 1. Update main with the merged changes
git checkout "$MAIN_BRANCH"
git pull

# 2. Go back to the feature branch
git checkout "$BRANCH"

# 3. Count commits ahead of main (these were squash-merged, now redundant)
AHEAD=$(git rev-list --count "$MAIN_BRANCH".."$BRANCH")
echo "Commits to reset: $AHEAD"

# 4. Reset the redundant commits and rebase onto main
if [ "$AHEAD" -gt 0 ]; then
  git reset --hard "HEAD~$AHEAD"
fi
git rebase "$MAIN_BRANCH"

# 5. Push the synced branch to keep remote in sync
git push --force-with-lease
```

## Step 5: Final Output

Print a summary:
- PR number and URL that was merged
- Branch that was synced
- Current state: on `BRANCH`, synced with `MAIN_BRANCH`

Example:
```
Merged PR #42 (squash) into main.
Synced feature-branch with main (reset 3 commits, rebased).
Currently on: feature-branch (synced with main)
```
