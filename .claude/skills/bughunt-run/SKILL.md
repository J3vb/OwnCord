---
name: bughunt-run
description: Run a bug hunt and turn its findings into committed fixes. Use when starting a hunt, resuming one, or fixing findings already in the ledger. Covers the ledger handoff between the bughunt and bughunt-fix workflows.
---

# Running the bughunt pipeline

Two workflows with a human gate between them. The ledger at
`.superpowers/findings-ledger.json` is the interface. Both workflows are pure
functions of their `args` — **the session does all file I/O**, because workflow
scripts have no filesystem access.

`.superpowers/` is gitignored. This repo is public and unfixed defects must never
reach a commit, an issue, or a PR body.

## 1. Hunt

**Launch the hunt from a turn that carries a token-budget directive** (recommended:
`+25M`, comfortably above a full 8-round run). The workflow's cost ceiling is gated
on `budget.total`, which is null without a directive — a directive-less run has **no
ceiling at all**. The workflow's first log line echoes the state: `budget=25M` means
armed; `budget=NONE - cost ceiling disarmed` means stop the run and relaunch with a
directive.

Before launching, in order:

1. **Rebuild the graph** (stale coordinates aim the explore lens at moved code):
   `graphify update . --no-cluster` — local tree-sitter, zero LLM cost, ~10.7k nodes.
2. **Rank explore targets**: `node .superpowers/rank-explore.mjs` — writes
   `.superpowers/explore-ranking.json`, deprioritizing files recorded clean in
   `.superpowers/explored-clean.json` and dropping files that no longer exist.
3. Read the ledger and pass every record in as `known`, so the hunt does not
   re-derive anything already found, fixed, declined, or refuted.

```
Workflow({
  name: "bughunt",
  args: {
    known: <every record from findings-ledger.json, as {file, line, title, status}>,
    graph: <the rows of .superpowers/explore-ranking.json>,
    lenses: [ {key, prompt}, ... ],   // optional: scope the hunt to one subsystem
    maxRounds: 8,
    dryThreshold: 2,
  },
})
```

If `graph` is omitted or empty the hunt logs
`explore: args.graph absent/empty - falling back to churn-based fresh eyes` and
still runs — degraded targeting, never a smaller lens family.

Omit `lenses` for a general hunt across the rotating families.

Each lens object is `{key, prompt}`. `key` must match `^[a-z0-9-]+$` —
lowercase letters, digits, and hyphens only. Keys get interpolated into agent
labels of the form `r<N>:hunt:<key>:<model>`, and a key containing uppercase,
dots, or spaces breaks label parsing. A lens missing `key` or `prompt` is not
validated — it reaches the finder prompt as the literal string `undefined`,
silently degrading that lens instead of failing loudly. Check your lens
objects before passing them.

When it returns, first save the raw result verbatim to
`.superpowers/hunts/<YYYY-MM-DD>-raw.json`, then:

```bash
node .superpowers/render-run-stats.mjs .superpowers/hunts/<YYYY-MM-DD>-raw.json <hunt-name>
```

This validates the result shape, appends the run's telemetry to
`.superpowers/run-history.json`, updates `.superpowers/explored-clean.json`, and
checks **every** confirmed finding's coordinates against the working tree (file
exists, line within length — the report agent that used to spot-check two findings
is gone). Resolve any `COORD` warnings before appending to the ledger: stale
coordinates poison `bughunt-fix`.

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

Read `.superpowers/FINDINGS.md`. Mark anything you do not want fixed as
`declined` with a rationale — declined findings are fed back into the next hunt's
prompts and never re-reported.

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

## When a run trips the breaker

The run stops early if more than `threshold` of attempted findings fail, once at
least `minAttempts` have been tried. `declined` never counts as a failure — a run
where several findings are correctly declined is a good run. There are two trip
points: the fix stage (before any prove agent runs) and inside the prove loop.

**A tripped run means stop and investigate, do not re-run.** The usual causes are
being on the wrong branch, a broken test runner, or ledger coordinates gone stale
after a rebase. Re-running without fixing the cause just spends the budget again.

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

Check `result.gate`. A failed gate leaves the commits in place on the branch —
fix it yourself, do not re-run the workflow over it.

## 4. Verify the fixes independently — REQUIRED

The workflow's prove agent *self-reports* that each test went RED with the fix
reverted. Nothing inside the workflow can verify that: workflow scripts have no
filesystem access. You do. Run the independent proof over every commit the
workflow made:

```bash
node .superpowers/verify-fixes.mjs <sha> <sha> ...
```

It reverts each commit's source files to the parent, runs that stack's tests,
and requires them to FAIL — then restores and requires them to PASS. This is the
only check in the pipeline no agent can fabricate.

Any `FAIL ... VACUOUS TEST` means the fix was committed behind a test that
proves nothing. Revert that commit and set its findings back to `open`; do not
talk yourself into keeping it because the code change looks right.

For every commit `verify-fixes.mjs` reports `PASS`, upgrade that commit's
findings' `fix.revertProof` from `"self-reported"` to `"pass"` — this
independent run is the only check in the pipeline no agent can fabricate, and
it is what earns the upgrade. A `FAIL` commit needs no further edit here — it
was already reverted and its findings set back to `open` above.

Re-render. Before you review the branch and open the PR, inspect the working
tree: a blocked or declined cluster can leave its edits and any new failing
test it wrote sitting uncommitted. Discard what you don't want — a reflexive
`git add -A` would commit tests that describe unfixed defects into a public
repo. Then review the branch and open the PR by hand. The workflow never
pushes and never opens a PR.

## Testing the workflows themselves

```bash
node .claude/workflows/bughunt.harness.mjs
node .claude/workflows/bughunt-fix.harness.mjs
node .superpowers/render-ledger.mjs --selftest
node .superpowers/verify-fixes.mjs --selftest
node .superpowers/rank-explore.mjs --selftest
node .superpowers/render-run-stats.mjs --selftest
```

All four run offline with zero API calls. Run them after any edit to the
relevant script.
