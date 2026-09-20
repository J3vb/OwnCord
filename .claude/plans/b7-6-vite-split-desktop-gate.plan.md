# Plan: B7-6 — Target-neutral Vite split and the desktop compile gate

> **Milestone:** B7-6 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-6-vite-split`.
> **Worktree:** `.claude/worktrees/b7-6`.
> **Drafted:** 2026-09-20. **Base commit:** `8cb03344` (`dev`).

## Summary

`Client/vite.config.ts` is 56 lines and assumes exactly one target. Three of
its settings exist only because Tauri is the consumer — `stripCrossOrigin()`
(Tauri serves over a custom protocol), `server.watch.ignored` for
`src-tauri/**` (without it the watcher dies with EBUSY on Windows when cargo
writes the output DLL), and the `TAURI_DEV_HOST` binding — but nothing in the
file says so, and nothing fails if a change quietly makes the build
desktop-only in a new way.

This milestone splits it into a shared config plus a desktop overlay, and adds
`build:desktop` as an explicit, checked target. It is a build-config change
only: **no call site moves and no application code changes.**

**What this milestone is not.** B8 (browser, PWA, mobile) was deferred
post-beta on 2026-09-18, so there is **no `build:web` here** and no browser
overlay. The roadmap's workstream 3 names `build:web` / `build:desktop`
together; only the desktop half is in scope. The point of the split now is
that the desktop assumptions become _named and checked_ rather than ambient —
which is what makes a browser overlay cheap later, without building one.

## Verify before you implement

Checked at `8cb03344`. If a row is false at your HEAD, **stop that task and
record it**.

| #   | Claim                                                                                                                | How to re-check                                     | Verified |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------- |
| 1   | `Client/vite.config.ts` is a single 56-line config; no split exists                                                  | `wc -l Client/vite.config.ts`                       | yes      |
| 2   | `build` is `tsc -p tsconfig.build.json && vite build`; there is no `build:desktop` or `build:web` script             | `Client/package.json` scripts block                 | yes      |
| 3   | `tauri.conf.json` has `"beforeBuildCommand": "npm run build"` and `"frontendDist": "../dist"`                        | `grep beforeBuild Client/src-tauri/tauri.conf.json` | yes      |
| 4   | Three settings are desktop-only: `stripCrossOrigin()`, `server.watch.ignored: ["**/src-tauri/**"]`, `TAURI_DEV_HOST` | read `vite.config.ts`                               | yes      |
| 5   | `manualChunks` keeps `livekit-client` out of the entry chunk, and Rolldown (Vite 8) supports only the function form  | the comment at `vite.config.ts:22-24`               | yes      |
| 6   | `tauri-build` runs on PRs to `dev` when `Client/vite.config.ts` changes (owner decision 2026-09-19)                  | B7 PRD open questions                               | yes      |

**Row 6 means this branch will trigger the full Tauri build in CI.** That is
intended — it is the gate this milestone adds value to. Do not attempt
`npm run tauri build` locally; `ci-check` says so explicitly.

## Patterns to Mirror

- **Config comments carry the reason, not the restatement.** `vite.config.ts`'s
  existing `server.watch.ignored` comment is the model: it names the failure
  (EBUSY on Windows when cargo writes the DLL) rather than saying "ignore
  src-tauri". Every setting the overlay claims as desktop-only gets that kind
  of comment or it is not clear why it moved.
- **A gate that cannot fail is not a gate.** B7-3's null-subject probe found
  nine vacuous tests that three review rounds had missed. Whatever check this
  milestone adds, prove it red before you rely on it green.

## Files to Change

| Path                               | Change                                    |
| ---------------------------------- | ----------------------------------------- |
| `Client/vite.config.ts`            | becomes the shared, target-neutral config |
| `Client/vite.config.desktop.ts`    | new: the desktop overlay                  |
| `Client/package.json`              | add `build:desktop`; keep `build` working |
| `Client/src-tauri/tauri.conf.json` | `beforeBuildCommand` → the desktop script |
| `.github/workflows/ci.yml`         | the desktop compile gate                  |
| `docs/architecture/*.md`           | only if a doc states the build shape      |

**Never** edit generated files, `docs/plans/*`, `CHANGELOG.md`, or any status
row.

## Tasks

Commit after every task — conventional subject, scope `b7-6`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Baseline the current build output

- **Action:** run `npm --prefix Client run build` and record the emitted file
  list with sizes (`ls -la Client/dist/assets/`). This is the artifact the
  split must not change.
- **Validate:** build exits 0; keep the listing — Task 3 diffs against it.

### Task 1: Split the config

- **Action:** move the three desktop-only settings from row 4 into
  `vite.config.desktop.ts`, which imports the shared config and merges. The
  shared `vite.config.ts` keeps the aliases, `manualChunks` and the build
  options that are not target-specific.
- **Gotcha:** `manualChunks` must stay in the **shared** config. It is a
  chunking decision about `livekit-client`, not a Tauri decision, and B7-7
  budgets against it. Moving it into the overlay would make the budget
  target-specific by accident.
- **Gotcha:** keep the function form — Rolldown supports no other
  (`vite.config.ts:22-24`).
- **Validate:** `npx vite build --config vite.config.desktop.ts` from `Client/`
  exits 0. Commit.

### Task 2: `build:desktop`, and keep `build` honest

- **Action:** add `"build:desktop": "tsc -p tsconfig.build.json && vite build --config vite.config.desktop.ts"`.
  Point `tauri.conf.json`'s `beforeBuildCommand` at it. Decide what plain
  `build` means — see the open question; the default is that it stays an alias
  for `build:desktop` until B8 gives it a second meaning.
- **Validate:** both `npm run build` and `npm run build:desktop` exit 0 from
  `Client/`. Commit.

### Task 3: Prove the split changed nothing

- **Action:** diff the Task 0 listing against the output of `build:desktop` —
  same chunk names, same entry, `livekit` still its own chunk, sizes within a
  few bytes (hashes differ only if content did).
- **Why:** this is the milestone's real acceptance. A split that silently
  changed the shipped bundle has done harm, not good.
- **Gotcha:** if a size moved more than trivially, find out why before
  continuing. A LiveKit chunk that merged back into the entry is exactly the
  regression B7-7 will later budget against.
- **Validate:** record the before/after listings in the report. Commit.

### Task 4: The compile gate in CI

- **Action:** add a CI step that runs `build:desktop` so a change that breaks
  the desktop target fails on the PR rather than at `tauri build` time.
- **Gotcha:** `ci-check` warns that a step added only to `release.yml` first
  executes at tag time — the wrong place to discover its bugs. This step goes
  in `ci.yml`.
- **Validate:** `npx actionlint .github/workflows/ci.yml` if available (it is
  skipped on Windows; CI runs it for real). **Prove the gate can fail:**
  temporarily break the desktop config, confirm the step goes red, revert.
  Record both outcomes with exit codes. Commit.

### Task 5: Final gate

- **Validate:**

  ```
  npm --prefix Client run build:desktop
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client test
  npm run check:hygiene
  ```

  Then the `ci-check` skill. Commit.

## Validation

```
( cd Client && npm run build:desktop )
( cd Client && npm run build )
npm --prefix Client run typecheck:build
npm --prefix Client test          # count not lower
npm run check:hygiene             # prettier + actionlint
# → then the ci-check skill; expect tauri-build to run on this PR (row 6)
```

## Risks

| Risk                                                                           | Mitigation                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| The split silently changes the shipped bundle                                  | Task 3 diffs the emitted files against a recorded baseline |
| `manualChunks` drifts into the overlay and B7-7 budgets the wrong thing        | Task 1 gotcha; the shared config keeps it                  |
| The new CI gate is green but cannot fail                                       | Task 4 proves it red before trusting it                    |
| `beforeBuildCommand` and CI disagree about which script builds the desktop app | Task 2 changes both in one commit                          |

## Out of scope

- `build:web`, any browser overlay, any PWA or mobile target — B8, deferred
  post-beta 2026-09-18.
- Bundle **budgets** and moving LiveKit/RNNoise off the startup path — B7-7.
- Any call-site migration — B7-4 and B7-5.

## Open questions for the owner

- [ ] After the split, does plain `npm run build` stay an alias for
      `build:desktop`? **Proposed default:** yes. With B8 deferred there is no
      second target to disambiguate, and making `build` fail would break every
      existing habit and script for no gain.
- [ ] Should the CI desktop-compile step be a new job or a step inside
      `Client Static Checks`? **Proposed default:** a step in an existing job —
      a whole job for one `vite build` costs a runner spin-up for no isolation
      benefit.

## Acceptance

- [ ] `vite.config.ts` is target-neutral; `vite.config.desktop.ts` holds the
      three desktop-only settings, each with a comment naming _why_ it is
      desktop-only
- [ ] `manualChunks` is in the shared config, still the function form
- [ ] `build:desktop` exists; `tauri.conf.json` `beforeBuildCommand` uses it
- [ ] Emitted bundle proven unchanged against the Task 0 baseline
- [ ] The CI desktop-compile gate exists **and was observed failing** on a
      deliberately broken config before being trusted green
- [ ] No application code changed — `git diff --stat origin/dev...` touches no
      `Client/src/**` file
- [ ] `ci-check` green, including the `tauri-build` job this branch triggers
