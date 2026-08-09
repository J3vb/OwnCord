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

Read the ledger and pass every record in as `known`, so the hunt does not
re-derive anything already found, fixed, declined, or refuted:

```
Workflow({
  name: "bughunt",
  args: {
    known: <every record from findings-ledger.json, as {file, line, title, status}>,
    lenses: [ {key, prompt}, ... ],   // optional: scope the hunt to one subsystem
    maxRounds: 8,
    dryThreshold: 2,
  },
})
```

Omit `lenses` for a general hunt across the rotating families.

Each lens object is `{key, prompt}`. `key` must match `^[a-z0-9-]+$` —
lowercase letters, digits, and hyphens only. Keys get interpolated into agent
labels of the form `r<N>:hunt:<key>:<model>`, and a key containing uppercase,
dots, or spaces breaks label parsing. A lens missing `key` or `prompt` is not
validated — it reaches the finder prompt as the literal string `undefined`,
silently degrading that lens instead of failing loudly. Check your lens
objects before passing them.

When it returns, append each entry of `result.confirmed` to the ledger with
`status: "open"`, an id from `nextId`, and today's date. Bump `nextId`. Then:

```bash
node .superpowers/render-ledger.mjs
```

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
  },
})
```

Create and check out the branch first — the workflow commits to whatever branch
is current and does not create one.

When it returns, for each entry in `result.results`:

- `fixed` → status `fixed`, `fix: {commit, test, revertProof: "pass"}` using the
  matching `result.commits` entry
- `declined` → status `declined`, copy the rationale
- `blocked` → leave `open`, record the rationale; these failed their revert-proof
  or their agent died, and want a human

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

Re-render, then review the branch and open the PR by hand. The workflow never
pushes and never opens a PR.

## Testing the workflows themselves

```bash
node .claude/workflows/bughunt.harness.mjs
node .claude/workflows/bughunt-fix.harness.mjs
node .superpowers/render-ledger.mjs --selftest
node .superpowers/verify-fixes.mjs --selftest
```

All four run offline with zero API calls. Run them after any edit to the
relevant script.
