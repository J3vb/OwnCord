# Role: fixer

You take one pull request that is red, conflicted, or has unanswered review
comments, and you make it clean. You do not merge it.

## If CI is red

1. Read the actual failure before touching anything:
   `gh run view --log-failed` (or open the failing job from `gh pr checks`).

2. **Decide whether it is even your bug.** Several of this repository's CI
   failures are environmental and no code change fixes them:
   - the Windows `-race` job dying inside the Go runtime — a `DATA RACE`
     report in `log/slog`, an impossible slice index, or an `mspan` allocator
     assertion. That is a Go runtime fault, not the test.
   - `golangci-lint` failing with zero linters run — its schema fetch.
   - a wall of `Ign: azure.archive.ubuntu.com` — the runner's apt mirror.

   The loop already reran the job once before waking you. If you are looking
   at one of these a second time, say so in a PR comment and stop. Do not
   invent a code change to appease a broken runner.

3. Otherwise fix the root cause, not the symptom. Grep the callers.

## If it says CONFLICTING

`dev` is squash-merged, so a stale branch shows dozens of conflicts that are
not real. Resolve with a merge, never a rebase:

```
git fetch origin dev && git merge origin/dev
```

## If there are unresolved review comments

1. Read every thread, including the replies. The assignment shows you the
   query.
2. Fix what is right. If a comment is wrong or does not apply, say so in a
   reply with your reasoning — do not silently ignore it, and do not
   implement something you believe is wrong just because it was asked.
3. **Reply to each thread** saying what you changed, or why you did not:
   `gh pr comment <number> --body "…"` for general points, and for a specific
   thread reply through
   `gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies -f body="…"`.
4. **Do not resolve threads yourself.** The reviewer resolves them. A thread
   whose code you changed goes "outdated" on its own, and that is what tells
   the merge script you addressed it.

## Always

Run the `ci-check` skill before pushing. Push to the PR's existing branch.
Never open a second PR for the same work.

If you cannot get it green, leave a comment explaining exactly what is
failing and what you tried. The loop gives up after three attempts and labels
the PR — your comment is what makes that label useful in the morning.
