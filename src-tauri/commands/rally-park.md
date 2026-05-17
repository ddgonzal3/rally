<!-- rally-park-v3 -->
# Park: Stash current Claude thread

You are parking the current thread so its tree slot frees up. Branch + Claude convo persist on remote + in Rally's DB. Resume later from any tree.

## When to use

User invokes `/rally-park` or says any of: "park this", "park it", "set this aside", "stash this for later", "I'll come back to this", "save and switch."

## Steps

### 1. Verify in a git repo

```bash
git rev-parse --show-toplevel
```

If error, abort and tell user: "rally-park needs to run inside a git repo."

### 2. Refuse to park main/master

```bash
BRANCH=$(git branch --show-current)
```

If `$BRANCH` is `main` or `master`, abort: "Refusing to park main/master. Make a feature branch first."

### 3. Commit WIP

Stage everything, commit with auto-message. Skip if nothing to commit. Use `--no-verify` — parking should never fail on hooks.

```bash
git add -A
if ! git diff --cached --quiet; then
  git commit -m "park: WIP" --no-verify
fi
```

### 4. Auto-name branch if still placeholder

If `$BRANCH` matches `^danny/[1-8]$`, generate a slug from THIS conversation's actual work. Pick 2–4 lowercase words separated by `-`, describing what was being worked on. Examples: `fix-audition-crash`, `mood-classifier-tuning`, `slots-rail-impl`.

Must be `[a-z0-9-]+` only. No spaces, no dots, no slashes beyond the `danny/` prefix.

```bash
NEW_BRANCH="danny/<your-slug>"
git branch -m "$NEW_BRANCH"
BRANCH="$NEW_BRANCH"
```

If branch already has a meaningful name (not `danny/N`), keep it as-is.

### 5. Push to remote

```bash
git push -u origin "$BRANCH" --no-verify
```

### 6. Generate one-line summary

Write a short (≤80 chars) plain-text summary of what was being worked on. No quotes, no newlines.

### 7. Find current Claude session id

Claude Code stores per-session JSONL files at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The encoded cwd is the
absolute path with `/` replaced by `-` (the leading slash becomes a leading
dash). The newest file = the current session.

```bash
REPO=$(git rev-parse --show-toplevel)
PROJ_KEY=$(echo "$REPO" | sed 's|/|-|g')
PROJ_DIR="$HOME/.claude/projects/$PROJ_KEY"

if [ -d "$PROJ_DIR" ]; then
  NEWEST=$(ls -t "$PROJ_DIR"/*.jsonl 2>/dev/null | head -n 1)
  SESSION=$(basename "$NEWEST" .jsonl 2>/dev/null)
else
  SESSION=""
fi
```

If `$SESSION` is empty, that's fine — proceed without it, but warn the user
they'll need to start a fresh convo on resume.

### 8. Capture origin URL

```bash
ORIGIN=$(git remote get-url origin 2>/dev/null || echo "")
```

Used by Rally on resume to detect "wrong repo" cases.

### 9. Signal Rally

```bash
SUMMARY="<your one-line summary here>"

PAYLOAD=$(cat <<EOF
{
  "repo": "$REPO",
  "branch": "$BRANCH",
  "session_id": "$SESSION",
  "summary": "$SUMMARY",
  "origin_url": "$ORIGIN"
}
EOF
)

curl -s -X POST http://127.0.0.1:21547/park \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
```

### 10. Free the tree

Switch the tree back to `main` (or `master`) so it visually reads as available
again. JSONL stays in this tree's `~/.claude/projects/` dir untouched — that's
what makes a clean resume back into this same tree possible.

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
git checkout "$DEFAULT_BRANCH" 2>/dev/null || true
```

Best-effort — if checkout fails (uncommitted changes shouldn't be possible
since step 3 staged everything, but just in case), don't block the park.

If curl fails (connection refused), tell user: "Rally not running — branch pushed, but Rally won't see it until next launch."

### 11. Confirm to user

One line. Example:

```
Parked danny/fix-audition-crash. Resume from Rally's Parked Threads panel.
```

Then suggest user runs `/clear` to drop the convo. Rally frees the slot when it receives the signal.

## Notes

- Never push to `main`/`master`.
- Never park if merge in progress or unresolved conflicts — tell user to resolve first.
- Slug must be filesystem-safe: `[a-z0-9-]+`, no spaces, no dots, no slashes beyond the `danny/` prefix.
- Use `--no-verify` on both commit and push so parking is hook-proof.
