# Bug-detection improvements — design

Date: 2026-08-08
Status: partially implemented (verified 2026-08-19) — Tier 1a's `make fuzz`
target exists (`Server/Makefile`) and Tier 2's five custom ESLint rules
shipped 2026-08-08 (`Client/eslint-rules.js`), so the gap table
below is stale for those two rows; Tiers 1b/1c are on-demand npm scripts;
Tiers 3–4 remain unimplemented.

## Problem

The multi-agent bug hunt finds real defects at a high rate — the 2026-08-08
client hunt confirmed 88 bugs and the follow-up sweeps fixed 101 — but it is
the only mechanism doing so, it costs a large token budget per run, and it has
never converged. Meanwhile several bug-catching tools are already installed,
configured, and committed to this repository, and none of them execute.

This design adds mechanical detection alongside the agentic hunt, prioritised
by yield per token spent.

## What already exists and does not run

| Asset                                                 | State                                               | Gap                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14 `Fuzz*` harnesses under `Server/**/*_fuzz_test.go` | Committed                                           | `go test ./...` runs a `Fuzz*` function against its **seed corpus only** — one pass per seed, zero generated inputs. `-fuzz` appears nowhere in the repo. |
| Stryker mutation testing                              | `stryker.config.mjs` + `npm run test:mutate`        | Referenced in `ci.yml` only inside an npm-audit comment. Has never run.                                                                                   |
| Browser-mode vitest                                   | `vitest.config.browser.ts` + `npm run test:browser` | CI runs jsdom only.                                                                                                                                       |
| Cross-package coverage                                | `make cover-all` prints every 0.0%-covered function | Output is not fed to anything.                                                                                                                            |

Separately, three of the codebase's sharpest invariants are documented in
`CLAUDE.md` files as prose and asserted nowhere:

- `ws`: "a frame that skips the queue, or a seq allocated for a frame that is
  then dropped, is silently unrecoverable"
- voice: cleanup in an aborted attempt "must be scoped to that attempt's own
  room — a global `leaveVoice()` there kills the live session"
- E2EE: "must never report an unverified peer as verified"

Prose fails no build.

## Locked decisions

**Everything in this design runs locally, on demand. Nothing is added to
GitHub Actions.**

Rationale: `go test -fuzz` writes each crashing input to
`testdata/fuzz/<Target>/<hash>`, and that file _is_ a working reproducer. The
root `CLAUDE.md` states: "This repo is public — unfixed defects do not belong
in commits, issues, or PR descriptions." Actions artifacts on a public repo are
downloadable by anyone, and a red scheduled job is itself a public signal that
something is broken. A Stryker surviving-mutant report is a milder version of
the same disclosure: a precise map of which behaviour nobody tests.

Local-only also means zero new workflow files and zero CI minutes.

**Corpus discipline.** A crasher stays uncommitted until its fix exists. The
`testdata/fuzz/` corpus entry and the fix are committed together, as one
regression test. This is the same shape as the existing test-first rule.

**Always replay a crasher before believing it.** Go runs fuzz targets in
separate worker processes. When a worker dies without reporting, the
coordinator cannot tell "crashed on this input" from "was killed externally",
so it saves the in-flight input to `testdata/fuzz/` as a suspected crasher.
Interrupting a fuzz run therefore manufactures a fake reproducer that is
indistinguishable at a glance from a real security finding. Confirm with
`go test ./<pkg> -run='<FuzzTarget>'` — a real crasher fails there. Observed
2026-08-08: a 1666-byte malformed JPEG appeared under
`api/testdata/fuzz/FuzzImageDimensions/` purely because the run was killed.

**Never `rm -r` a `testdata/fuzz/<Target>/` directory** to clear a false
crasher. Committed seed corpus files live in the same directory — deleting the
directory takes them with it. Remove the single offending file by name.

**Superseded 2026-08-08: Tier 2 ships as ESLint rules, not semgrep.** Semgrep
has no native Windows support (WSL or Docker only), so on this machine it would
join `make` as tooling that cannot be run locally. ESLint flat config supports
an inline plugin, so custom rules cost no new dependency — and `npx eslint
src/` is already a blocking CI gate, which removes the promotion step entirely.
Rules live in `Client/eslint-rules.js`, tested with `RuleTester`
in `tests/unit/eslint-rules.test.ts`. See "Tier 2 — delivered" below.

## Tier 1 — Turn on what already exists

### 1a. `make fuzz`

Go fuzzes **one target per package per invocation**, so this cannot be a single
`go test -fuzz ./...`. The target enumerates fuzz functions and runs each with
a time budget.

Add to `Server/Makefile`, and to its header comment block:

```make
# fuzz  Actually fuzz. CI only replays the seed corpus; this generates inputs.
#       Override the per-target budget: FUZZTIME=2m make fuzz
FUZZTIME ?= 30s
fuzz:
	@for pkg in $$(go list ./...); do \
	  for fn in $$(go test -list='^Fuzz' $$pkg 2>/dev/null | grep '^Fuzz'); do \
	    echo "── $$pkg $$fn"; \
	    go test $$pkg -run='^$$' -fuzz="^$$fn$$" -fuzztime=$(FUZZTIME) || exit 1; \
	  done; \
	done
```

Add `fuzz` to the `.PHONY` list.

Default budget 30s per target — a full sweep of 14 targets is about 10 minutes
unattended. `FUZZTIME=2m` for a deep run.

### 1b. Scoped Stryker runs

`stryker.config.mjs` already scopes mutation to `src/lib/**` and `src/stores/**`
with `thresholds.break: 50`. A full run over that scope is expensive; a
hotspot run is not:

```bash
npx stryker run --mutate "src/lib/dispatcher.ts,src/lib/ws.ts,src/lib/livekitE2EE.ts"
```

Roughly 25 minutes for three files. Surviving mutants identify lines whose
behaviour can be changed with the entire 4800-test suite still green.

Treat the result as advisory. Do not gate on `thresholds.break` — the threshold
in the config file applies to a full-scope run and is meaningless for a
three-file subset.

Target the files the hunt keeps returning to: `dispatcher.ts`, `ws.ts`,
`livekitE2EE.ts`, `identity.ts`, and the voice session module.

### 1c. Browser-mode vitest

Run `npm run test:browser` locally. The client `CLAUDE.md` already documents
jsdom diverging from native Web Storage semantics; browser mode is the only
configured surface that observes that class.

### 1d. Prerequisite

Confirm `Client/reports/`, `Client/.stryker-tmp/`,
`Server/coverage-all.out`, and `Server/**/testdata/fuzz/` interim output are
covered by `.gitignore` before running any of the above. Add entries where
they are missing.

## Tier 2 — Bugs to permanent detectors

Roughly 200 confirmed real bugs have been fixed across the hunt and harvest
runs. Each one currently bought exactly one fix. Encoding the recurring
_classes_ converts them into permanent detectors.

**Sources to mine:** bughunt commit history on `fix/bughunt-*` and
`fix/bughunt-harvest-*` branches, `.superpowers/harvest-med-low-checklist.md`,
and `docs/audit-*.md`.

**Method:** cluster findings by class, not by symptom. Use the installed
`semgrep-rule-creator` skill, which is test-first — each rule ships with a
positive fixture that must match and a negative fixture that must not.

### Tier 2 — delivered 2026-08-08

Five rules, all scoped to the modules their invariant governs, all proven to
fire by reintroducing the historical bug shape into real source and reverting:

| Rule                             | Encodes                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `no-leave-voice-when-superseded` | A global `leaveVoice()` inside a branch that already confirmed supersession tears down the newer live session |
| `e2ee-epoch-needs-keypair-check` | A non-key-holder never bumps the epoch, so an epoch-only staleness guard cannot see a restarted session       |
| `e2ee-verified-status-literal`   | Keeps `"verified"` tied to a hand-written call site that earned it, never a computed status                   |
| `no-identity-scope-fallback`     | A `?? 0` placeholder scope mints a keypair under the wrong account                                            |
| `no-store-write-in-ws-on`        | Page-local `ws.on` handlers may read stores, not write them                                                   |

**Declined: `await`-then-stale-snapshot.** Not AST-expressible. Whether an
await needs a guard — and whether the guard present is sufficient and correctly
placed — is intent, not shape. `livekitSession.ts` alone expresses supersession
guards in at least four different forms, and several awaits legitimately need
no guard. Any rule here would be too narrow to catch real bugs or broad enough
to flag most of the file's already-correct guard code. A rule that misfires on
correct code gets disabled and trains people to ignore the linter.

**Found while writing these:** the dispatcher invariant in the client
`CLAUDE.md` was factually wrong. It claimed `ws.on(...)` appears only in
`dispatcher.ts`; eight handlers across `main.ts`, `MainPage.ts` and
`ChannelController.ts` say otherwise. The true invariant — dispatcher is the
single path by which server events _write to stores_ — is what the rule
encodes, and the doc has been corrected to match.

**Still open:** the server-side `ws` seq/FIFO invariant, which needs a Go
runtime assertion rather than a lint rule.

Not every fixed bug becomes a rule. A class earns one when it has recurred at
least twice, or when it corresponds to an invariant already written down in a
`CLAUDE.md`.

## Tier 3 — Stateful and chaos testing

Fuzzing and property tests find bad **functions**. Every recurring bug in this
codebase's history is a bad **ordering**: `registerNow` reconnect-transfer,
superseded voice sessions, duplicate-message reconciliation, resync corruption,
the auth-race deep link, the logout/auto-login race. Nothing in the repo
generates orderings.

### 3a. Client model-based tests

`fast-check` v4 is already a dependency, and
`tests/unit/*.property.test.ts` establish the house pattern. Use `fc.commands`.

- **Commands:** `Connect`, `Disconnect`, `RegisterNow`, `Receive(seq)`,
  `Supersede`, `Resync`, `Logout`.
- **Model:** a minimal reference implementation of expected store state — not
  a second copy of the real logic.
- **Invariants:** message ids never duplicate; per-client seq is monotonic; a
  verified peer never flips to unverified and back; an aborted voice attempt
  never tears down a live session owned by a newer attempt.

The shrinking is the point: fast-check reduces a 40-step failure to the minimal
3-step reproducer, which is what makes an ordering bug fixable at all.

### 3b. Server hub simulation

A `ws` package test driving random interleavings of subscribe, broadcast, ack
and disconnect under `-race`, asserting the FIFO and seq property already
stated in `Server/CLAUDE.md`. Seeded and therefore replayable.

### 3c. Fault-injected transport

A test-only wrapper that drops, reorders, duplicates and delays frames from a
seed. Shared by 3a and 3b. Deterministic: a failing seed reproduces exactly.

## Tier 4 — Sharpen the hunt

The 2026-08-08 client hunt fixed 101 bugs and still did not converge. Four
changes, cheapest first:

1. **Persistent seen-ledger.** Key on `(file, symbol, class)` and persist
   _across_ runs, not only within one. Each run currently starts cold and
   re-derives ground already covered — the most likely reason convergence never
   arrives.
2. **Sibling-sweep lens.** For every confirmed bug, enumerate the other callers
   of the touched function. This is the root-cause rule turned into a lens: it
   converts one finding into its whole family, which is also what stops the
   same class reappearing in the next round.
3. **Coverage-guided targeting.** `make cover-all` already prints every
   function at 0.0%. Feed that list to the finders as a priority surface.
4. **Anti-pattern priming.** Supply the fixed-bug corpus as "confirmed-real
   classes in this codebase — hunt siblings" rather than starting each finder
   from a cold read.

## Order and effort

| Step                              | Effort                 | Runs in                 |
| --------------------------------- | ---------------------- | ----------------------- |
| 1a `make fuzz`                    | 15 min to write        | 10 min/sweep unattended |
| 1b Stryker hotspots               | 0 (already configured) | ~25 min for 3 files     |
| 1d gitignore check                | 5 min                  | —                       |
| 2 first four semgrep rules        | ~1 afternoon           | seconds                 |
| 4.1 + 4.2 ledger and sibling lens | ~2 hours               | within existing hunt    |
| 1c browser-mode vitest            | 0                      | minutes                 |
| 3 model-based and chaos harnesses | ~1 day                 | minutes                 |

Tier 1a is first because 14 harnesses — the expensive part — are already
written and produce nothing today.

## Non-goals

- No new GitHub Actions workflows, jobs, or scheduled runs.
- No gating of any existing CI check on mutation score or fuzz results.
- No change to the existing test suites' assertions. The client suite is green
  and stays green.
- No promotion of semgrep to CI in this scope.
- No replacement of the agentic bug hunt. Tier 4 sharpens it; Tiers 1 to 3 run
  beside it.
