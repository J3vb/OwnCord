---
name: ship-cloud
description: Validate and publish committed OwnCord changes from a Claude cloud session through pinned no-mistakes using Claude only, with GitHub PR reviews requested through @codex review and PRs targeting dev.
---

# Ship OwnCord from Claude cloud

Use this workflow when shipping committed changes from Claude Projects. It is
opt-in and requires an x64 Linux cloud session with usable `gh` authentication
and an authenticated `claude` CLI. Codex CLI is not a cloud prerequisite.

1. Check `git status`. Preserve unrelated work. Finish and commit the requested
   changes on a feature branch based on `dev`; never run the gate from `dev` or
   `main` or with uncommitted work.
2. Write the user's complete intent and accepted decisions to a private file
   outside the checkout. Never put secrets or security reproduction details in
   a public PR. The adapter disables publication of the intent section; review
   any generated public summary for security detail as well.
3. Run `node scripts/no-mistakes-cloud.mjs --setup`. This downloads and verifies
   a pinned release, creates a session-local profile, checks prerequisites and
   initializes the local gate. A missing CLI/authentication is a real blocker;
   do not claim validation succeeded or push directly as a substitute.
4. Run `node scripts/no-mistakes-cloud.mjs --intent-file <literal file path>`.
   Do not interpolate intent prose into a shell command. The adapter fixes the
   base branch to `dev`, enables only eligible automatic decisions and bounds
   each driver call to sixty seconds.
5. Read every response. While active, the pipeline owns its worktree and fixes.
   On a bounded wait ending, inspect `--status` and use `--reattach`; do not
   start another run, hand-edit the gate worktree, force-push, or kill the daemon
   to bypass a gate. Follow the installed upstream `/no-mistakes` guidance for
   gates. Use the adapter's `--fix-findings <ids>` only for eligible corrections
   or a fix the user explicitly authorized. A real `ask-user` policy/product
   decision must be escalated; never blanket-approve, skip or decline findings
   just to continue.
6. Once the PR exists, request its final-head GitHub review with
   `gh pr comment <number> --body '@codex review'`. Inspect the existing request
   comments and provider receipt first: do not repeat a request for the same
   head or request again when that head already has a running/completed review.
   After a correction changes the head, request review for the new final head.
   If Codex reports quota exhaustion, hand off to the deployed Claude fallback
   instead of posting repeated requests. A request comment is not an approval.
7. At `checks-passed`, report the PR URL and hand integration to the independent
   GitHub checks/merge policy. Never merge directly from this skill. If the
   cloud session ends, the local daemon does not continue running elsewhere;
   GitHub CI and its deployed controller continue independently.

The cloud profile uses Claude CLI only for reviews and fixes. Missing/malformed
review output still fails. Codex runs only through GitHub PR review requests;
the separately deployed GitHub controller uses Claude when that Codex review is
unavailable or exceeds its wait bound. no-mistakes reviews start fresh sessions, while
its fixer may reuse its own session. Every CI repair re-enters review before
publication. Ordinary review, test and CI repairs have a three-attempt budget.

Setup writes only an isolated temporary no-mistakes home and a local Git gate;
upstream `init` also installs its generated user-level skill in the ephemeral
cloud home. It does not overwrite the operator's normal no-mistakes profile or
modify Claude Projects account settings. If nested CLI execution or auth is not
available in the beta environment, report that limitation and use the independent
GitHub review worker once deployed; do not fabricate a no-mistakes receipt.
