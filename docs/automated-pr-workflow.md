# Automated PR review and integration

Claude Projects authors changes and opens PRs against `dev`. GitHub runs CI.
The optional controller in `.github/workflows/pr-automation.yml` reconciles PRs
every five minutes, preferring completed Codex reviews and running a fresh Claude
review when Codex reports quota exhaustion or no usable result arrives within
twenty minutes of observing a new head. It does not post repeated Codex requests.

This controller ships **inactive**. The existing workflow remains unchanged
until the one-time deployment below. Firstmate and its old no-mistakes daemon
are not dependencies. A separate optional no-mistakes cloud shipping adapter
can validate work before publication; its PR-body attestation does not replace
the App-owned checks.

## Review policy

- Existing seventeen required CI checks remain required. No human approval is
  required for routine automated merging.
- `AI Review Gate` records review of the current head and base, using the pinned
  controller policy. A later commit or base change needs fresh evidence.
- Claude runs without tools, hooks, repository settings or GitHub credentials.
  The controller supplies changed files, complete before/after source, the diff
  and PR intent as untrusted data. It never claims to have executed tests.
- Sensitive paths and policy changes receive a separate security/integrity pass
  when Claude is the fallback. These are independent fresh sessions of the
  configured model, not a claim of cross-model independence. When Codex supplies
  the correctness pass, Claude supplies the sensitive/test-integrity pass.
- `Test Integrity Gate` permits ordinary equivalent test rewrites through review
  but refuses lower coverage floors, expanded exclusions, added/extended
  quarantine and scanner-policy changes without a separate policy decision.
- Missing output, partial review coverage and provider errors never count as
  approval. Two attempts per head are allowed, separated by at least five
  minutes. After three automatic repair attempts, unresolved findings hold the PR;
  an App-owned ledger keeps that budget across commits.
- Public receipts contain verdicts, paths, counts and evidence digests. Detailed
  findings are encrypted with the controller App key and retained across fixes
  and interrupted jobs. Reviewers must explicitly reconcile each carried
  finding with code evidence; a late clean provider result cannot erase it.
  Model findings are deliberately not posted publicly. A separate tool-free
  Claude fixer proposes file replacements in memory; the controller publishes
  the bounded correction as a descendant commit and requires fresh review/CI.
  It cannot edit gate policy, generated files or unrelated production files.
  For a held sensitive PR, use a private Claude Projects review to reproduce and
  address the issue. This adapter does not send messages into Claude Projects.
- A model's judgment can be wrong. Complete snapshot limits (100 changed files,
  350 KB source/diff) and binary or missing context hold a PR rather than claiming
  complete review. Subsequent work can add a tool-isolated large-change worker.

## Integration policy

`Merge Readiness Gate` serializes final integration. The controller first
requires a successful full post-merge `dev` CI run, updates an eligible branch
against current `dev`, and dispatches full CI for that head. Only after full CI,
the existing required checks, current review and integrity checks pass does it
grant readiness and request a squash merge with the expected head SHA.

Strict/up-to-date branch protection and administrator enforcement remain the
backstop when the base changes between observation and GitHub's merge operation.
The controller resets readiness for unmerged candidates and pauses integration
while `dev` is red. It does not bypass protection or remove CI requirements.
Other PRs can be reviewed while one is held. Ordinary PR CI can still be
path-selected; the final manual-dispatch validation runs every capability.

## One-time deployment

The schedule and manual dispatch must exist on GitHub's default branch (`main`).
Merging this PR to `dev` alone does not activate the schedule. Promote the
reviewed workflow through the repository's normal release process; do not
change the default branch or bypass that process.

1. Create a private GitHub App installed only on OwnCord. Grant repository
   permissions: Checks write, Contents write, Pull requests write, Actions
   write, and Administration read. Keep Metadata read. No administration write
   or protection bypass is required. Create the `pr-automation` environment,
   restrict its deployment branches to exactly `main` (selected branches, no
   tags), and require no reviewers. Store `REVIEW_APP_PRIVATE_KEY` as an
   **environment secret**, never a repository secret. Store the numeric App ID
   as repository variable `REVIEW_APP_ID`. Branch restrictions permit scheduled
   default-branch runs without making this credential available to PR jobs.
2. Set `REVIEW_CONTROLLER_REF` to the **full immutable commit SHA** containing
   the reviewed controller implementation. Checkout always uses this revision;
   a PR cannot deploy its own changes to its judge. Updating this variable is
   a separate owner-controlled deployment decision.
3. Reuse `CLAUDE_CODE_OAUTH_TOKEN`, already used by the interactive workflow.
   Confirm its validity through the shadow run; OAuth may also exhaust capacity.
   No paid API credential or spending fallback is enabled automatically.
4. Set `REVIEW_MODE=shadow`. Dispatch **PR Automation Controller** and exercise
   quota fallback, missing output, moved heads and test-policy changes. The new
   checks may appear but the controller makes no merges or branch updates.
   Existing automatic merges remain governed by existing protection during
   this observation period. Observe at least ten representative PRs.
5. Once the worker is proven, preserve all current required checks, turn on
   strict/up-to-date checks, keep administrator enforcement enabled, and add
   all three new check names bound to this dedicated App's ID. Do not bind them
   to GitHub Actions (15368). Use the setup script's `--check` mode to inspect
   prerequisites and its explicit `--apply` mode only after shadow validation.
6. Set `REVIEW_MODE=enforce` and dispatch the controller. It refuses to merge
   unless live protection has the expected App-bound checks and strict policy.

The controller uses a dedicated App because ordinary Actions jobs can otherwise
emit similarly named checks. Do not grant that App's private key to PR workflows
or authoring/fix agents. The metered worker receives only the Claude credential;
its child environment excludes the controller token. PR code is never checked
out or executed in this credential-bearing controller job.

The App key also protects private review evidence in the App-owned ledger. Keep
the key available while those PRs are active; rotation that loses decryption
access holds affected work rather than silently dropping findings. The model
worker never receives the key. Provider attempts are reserved before model
execution so an interrupted job cannot reset its metered retry budget.
Installation tokens are renewed in the trusted controller during long reviews;
the renewal key is never passed to review or repair subprocesses.

## Verification and recovery

Run `node --test scripts/pr-automation/policy.test.mjs
scripts/pr-automation/controller.test.mjs`, `actionlint`, and `npm run
check:hygiene`. Tests use GitHub boundary fixtures and fake provider execution;
they do not consume live review quota or mutate GitHub.

The same pinned workflow/controller revision owns one global Actions concurrency
group, without cancelling a running tick. Current evidence is reconstructed from
App-owned checks and a per-PR App-owned ledger on every run. A restart does not
reuse a receipt bound to another head, base or policy. Do not run a second
controller outside this concurrency group.

If the App or credential becomes unavailable after enforcement, PRs remain
blocked. Restore the credential and rerun the controller. Do not remove required
checks as a routine recovery. A held repair budget needs an explicit owner
diagnosis; this initial version has no automatic budget-reset command. To
disable deployment, pause the workflow first; removing the gate or relaxing a
coverage/security policy is an explicit owner decision, not a model verdict.

This initial implementation does not change hosted Codex settings, provision a
GitHub App, restart Firstmate, invoke a hidden Claude Projects API, or enable
enforcement before shadow validation. The install/activation steps are necessary
to make the prepared gates enforceable.
