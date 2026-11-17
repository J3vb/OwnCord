---
name: bughunt-run
description: Run a bug hunt and turn its findings into committed fixes. Use when starting a hunt, resuming one, or fixing findings already in the ledger. Covers the ledger handoff between the bughunt and bughunt-fix workflows.
---

# Running the bughunt pipeline

Two workflows with a human gate between them. The ledger at
`.superpowers/findings-ledger.json` is the interface. Both workflows are pure
functions of their `args` — **the session does all file I/O**, because workflow
scripts have no filesystem access.

Only the ledger is tracked; everything else under `.superpowers/` is gitignored
scratch. This repo is public and unfixed defects must never reach a commit, an
issue, or a PR body.

## 1. Hunt

**Launch the hunt from a turn that carries a token-budget directive** (recommended:
`+25M`, comfortably above a full coverage run's ~8-12M). The workflow's cost ceiling is gated
on `budget.total`, which is null without a directive — a directive-less run has **no
ceiling at all**. The workflow's first log line echoes the state: `budget=25M` means
armed; `budget=NONE - cost ceiling disarmed` means stop the run and relaunch with a
directive.

Before launching, read the ledger and pass every record in as `known`, so the
hunt does not re-derive anything already found, fixed, declined, or refuted.

```
Workflow({
  name: "bughunt",
  args: {
    known: <every record from findings-ledger.json, as {file, line, title, status}>,
    lenses: [ {key, prompt}, ... ],   // optional: scope the hunt to one subsystem
    maxRounds: 30,   // safety backstop only
    dryThreshold: 2,
  },
})
```

Without a `graph` inventory the hunt logs
`explore: args.graph absent/empty - falling back to churn-based fresh eyes` and
targets by churn. That is the expected mode: the inventory script that built
`graph` is not in the repo.

`converged: true` means `dryThreshold` consecutive eligible rounds confirmed
nothing (a round where the lens family comes up empty with the pool drained
counts as dry — family `exhausted`). `stalledCoverage: true` means adaptive
rounds stopped making progress (usually mass finder failures — investigate
before re-running).

Omit `lenses` for a general hunt across the rotating families.

Each lens object is `{key, prompt}`. `key` must match `^[a-z0-9-]+$` —
lowercase letters, digits, and hyphens only. Keys get interpolated into agent
labels of the form `r<N>:hunt:<key>:<model>`, and a key containing uppercase,
dots, or spaces breaks label parsing. A lens missing `key` or `prompt` is not
validated — it reaches the finder prompt as the literal string `undefined`,
silently degrading that lens instead of failing loudly. Check your lens
objects before passing them.

When it returns, first save the raw result verbatim to
`.superpowers/hunts/<YYYY-MM-DD>-raw.json`, then check **every** confirmed
finding's coordinates against the working tree (file exists, line within
length). Fix or drop stale coordinates before appending to the ledger: they
poison `bughunt-fix`.

Then append each entry of `result.confirmed` to the ledger with
`status: "open"`, an id from `nextId`, and today's date. Bump `nextId`. The
incoming record carries a prose `fix` field (bughunt's suggested remedy) —
rename it to `suggestedFix` when appending, so the ledger's `fix` field starts
as `null` and is free for `bughunt-fix` to fill in with `{commit, test,
revertProof}` once something is actually fixed. Then:

```bash
node .superpowers/render-ledger.mjs
```

Each confirmed record carries `finder: "opus"`. The dual-model finder panel was
retired 2026-08-12: attribution over the only measured run priced sonnet's unique
yield (1 high, 4 medium, 9 low) at roughly a third of the run's agents. The known
cost: with one finder, a lazy-but-non-null finder round can read as "clean" where
the panel required both models to agree it was. Watch `runStats` — per-lens
candidate counts make an anomalously empty lens visible after the fact.

## 2. Gate (human)

Generate the readable rendering, then read it — it is gitignored, so a fresh
clone has no copy until you make one:

```bash
node .superpowers/render-ledger.mjs   # writes .superpowers/FINDINGS.md
```

Mark anything you do not want fixed as `declined` with a rationale — declined
findings are fed back into the next hunt's prompts and never re-reported. Edit
`findings-ledger.json` to do that, not the rendering.

## 3. Fix

```
Workflow({
  name: "bughunt-fix",
  args: {
    findings: <records with status "open" from findings-ledger.json>,
    branch: "fix/bughunt-YYYY-MM-DD",
    only: ["OC-0042"],        // optional
    maxSeverity: "medium",    // optional
    circuitBreaker: { threshold: 0.5, minAttempts: 3 },  // optional; false to disable
  },
})
```

Create and check out the branch first — the workflow commits to whatever branch
is current and does not create one.

### Composing the batch

The workflow clusters findings by the file the BUG is in, but its same-run
overlap guard fires on the files the FIX touches. Compose the batch so the two
can never disagree:

- **Close over the file relation.** Pull in every open finding that shares a
  file with anything already selected, regardless of severity — a same-file
  finding left behind is a future cross-cluster block.
- **Re-check coordinates against the working tree** (file exists, line within
  length) before launching; merges since the hunt can stale them.
- **Scan fix-touchpoints, then read only the hits.** Token-scan each finding's
  `suggestedFix`/`why` for path-like tokens owned by another cluster, then read
  just the flagged records to separate evidence citations from actual fix
  edits — the scan over-predicts (a measured run: 6 flagged, 1 real). True
  collisions go into **sequential waves**: launch the later wave after the
  earlier wave's commits land, and the same-run guard never fires. Batch 4
  skipped this and self-blocked 20/27 findings; batch 6 ran it and blocked
  zero.

### Security findings

Fixed security findings ship as ordinary PRs to `dev` with neutral wording:
commit subjects and PR text say what was fixed, never the weakness — no
severity labels, repro steps, or attack narratives in public text. Never a
public issue or advisory. Never decline a finding merely for routing.

## When a run trips the breaker

The run stops early if more than `threshold` of attempted findings fail, once at
least `minAttempts` have been tried. `declined` never counts as a failure — a run
where several findings are correctly declined is a good run. There are two trip
points: the fix stage (before any prove agent runs) and inside the prove loop.

**A tripped run means stop and investigate, do not re-run.** The usual causes are
being on the wrong branch, a broken test runner, or ledger coordinates gone stale
after a rebase. Re-running without fixing the cause just spends the budget again.

**Re-verify a blocked finding against HEAD before fixing it.** A deferred item
ages against a moving codebase: later hunts routinely fix a blocked finding as a
side effect of an overlapping sibling, and a saved debris patch stops applying
once a refactor rewrites the files it touched. Check the _mechanism_ still exists
at HEAD, not just the line coordinates. If it is already covered, mark it fixed
with a pointer to the covering commit instead of re-fixing it. Of 6 findings
blocked on 2026-08-14, 2 were already fixed 5 days later and the debris patch no
longer applied at all.

Findings from clusters the run never reached come back `blocked` with a rationale
naming the breaker. Set those back to `open` once the underlying problem is fixed
— they were never attempted. Their edits are sitting uncommitted in the working
tree, so the debris warning above applies to them too.

Whatever committed before the trip still goes through the gate, so `result.gate`
tells you whether those commits are green.

When it returns, for each entry in `result.results`:

- `fixed` → status `fixed`, `fix: {commit, test, revertProof: "self-reported"}`
  using the matching `result.commits` entry — the prove agent's own report, not
  yet independently checked (see step 4)
- `declined` → status `declined`, copy the rationale
- `blocked` → status `blocked` (not `open`), record the rationale; these failed
  their revert-proof, tripped the cross-cluster overlap guard, or their agent
  died, and want a human. Do NOT leave them `open` — `bughunt-fix` only picks up
  `open` findings, so `open` would silently re-enter one of these into the next
  fix run, exactly the retry loop the design deliberately excludes ("one human
  look beats three agent attempts").

Ledger writes select records by id or `fix.commit` — never by date fields,
which collide when two batches reconcile on the same day — and every bulk
mutation asserts its expected match count before writing (a same-day sibling
batch once inflated a 29-record update to 44 matches; only the count
assertion caught it).

Check `result.gate`. A failed gate leaves the commits in place on the branch —
fix it yourself, do not re-run the workflow over it.

A fix that tightens a guard and fails ONLY e2e/CI while unit tests and local
gates stay green is usually a test-infrastructure defect, not a bad fix:
triage the mock/harness first. Check that mock echoes carry the same fields
the real server sends (real channel ids, not sentinels), and never assert
broadcast delivery on a socket the same operation force-closes. Mocks
calibrated against lenient code silently decay into lies — every
guard-tightening fix is also a fidelity audit of the mocks that exercise it.
The Playwright trace's console stream (grep the .trace file for the app's log
lines) locates the mechanism in minutes.

## 4. Verify the fixes independently — REQUIRED

The workflow's prove agent _self-reports_ that each test went RED with the fix
reverted. Nothing inside the workflow can verify that: workflow scripts have no
filesystem access. You do. For every commit the workflow made, prove it by hand
from the branch tip:

1. Reverse-apply only the commit's source changes onto the current tree
   (`git show <sha> -- <source files> | git apply -R`), run that commit's
   tests, and require them to FAIL.
2. Restore to HEAD (`git checkout HEAD -- <source files>`) and require the same
   tests to PASS.

Reverse-apply onto the tip, never check out a mid-branch snapshot: stacked
waves pile commits onto shared files, and a snapshot restore corrupts every
later check. Rust commits with in-file `#[cfg(test)]` tests need the split at
the `mod tests` boundary. Race/deadlock-class fixes prove under their detector
(`go test -race ./<pkg>/`); a cross-stack commit (e.g. a vitest file pinning a
`src-tauri/` config) proves with the test file's own runner.

While you do this the working tree is not a stable read surface: anything
reading concurrently must read committed objects (`git show HEAD:<path>`).

A test that still passes with the fix reverted proves nothing. Revert that
commit and set its findings back to `open`; do not talk yourself into keeping
it because the code change looks right. For every commit that passed both
steps, upgrade its findings' `fix.revertProof` from `"self-reported"` to
`"pass"`.

Re-render. Before you review the branch and open the PR, inspect the working
tree: a blocked or declined cluster can leave its edits and any new failing
test it wrote sitting uncommitted. The gate's "N uncommitted modifications at
gate time" note is the trigger list. **Classify before discarding** — an
uncommitted modification to a TRACKED test file may be a required companion to
a committed fix, not debris. Two known mechanisms: the old test locked the old
buggy behavior, and the fix widened an interface that a fake/mock in a test
file the cluster never named must now implement (without it the committed
package does not even compile). The decisive test: `git stash push -- <file>`,
then compile/test the committed state alone — if it fails, the modification is
a companion; fold it into the causing commit (fixup + autosquash keeps the
history coherent) or commit it with attribution. Only then
discard true debris — a reflexive `git add -A` would commit tests that
describe unfixed defects into a public repo.

**Capture before destroying, as separate verified steps.** Preserve blocked or
declined edits by copying the files aside (or `git stash push -u` after
confirming it actually saved something) BEFORE any rm/checkout, and never
chain the capture and the destructive step into one command — a capture
failure then becomes data loss (`git diff /dev/null <file>` fails outright on
Windows git and has deleted debris before it was saved). Never blind
`git stash pop`: a paired push on a clean tree saves nothing, and the pop then
grabs whatever foreign stash sits on top (a preserved debris stash, in the
measured case — ~40 conflicted paths). Pop only a ref you verified your own
push created; for temporary file comparisons, skip stash entirely and read old
versions from the object store (`git show <ref>:<path>`). Audit what got COMMITTED, too: parallel fix agents share the tree, so a
prove agent can commit a sibling cluster's content that happened to sit in a
shared test file or in regenerated output. Grep the committed tests for
finding ids outside the run's fixed set, and re-run the generated-code
verifies (sqlc/protocol) after the debris discard — a mismatch means a commit
carries foreign regen content. Anything pinning or describing an UNFIXED
finding must be excised from history (amend + rebase onto the amended
commit), not merely removed by a follow-up commit.

Then review the branch against the merge-base — `git diff
origin/dev...HEAD` (three-dot), never two-dot: a concurrent merge plus a
background fetch can move the base mid-run and turn the two-dot diff into
phantom deletions. `dev` is the integration branch every PR targets
(docs/contributing.md#branch-and-pr-model); use `origin/main` only for a
release PR cut from `dev`. If origin moved, confirm zero file overlap and a
clean `git merge-tree --write-tree origin/dev HEAD` before opening the PR by
hand. The workflow never
pushes and never opens a PR.

## Testing the workflows themselves

```bash
node .claude/workflows/bughunt.harness.mjs
node .claude/workflows/bughunt-fix.harness.mjs
node .superpowers/render-ledger.mjs --selftest
```

All three run offline with zero API calls. Run them after any edit to the
relevant script.
