# Pull Request

<!-- Base branch: PRs target `dev`, not `main`. `main` carries releases only.
     See docs/contributing.md#branch-and-pr-model. The Docker and Tauri Full
     Build jobs are gated on `main` and report as skipped here — that is
     expected. -->

## Summary

<!-- What does this PR do? 1-3 bullet points -->

-

## Changes

<!-- List the key changes made -->

-

## Test Plan

- [ ] `npm run check` passes from the repository root — the one entry point that
      runs what CI gates on. `check:server` / `check:client` / `check:rust` /
      `check:hygiene` / `check:docs` run a single stack if that is all you touched
- [ ] Manual testing done (describe below)
- [ ] Generated files were regenerated, not hand-edited — `Server/db/dbgen/`,
      `Server/ws/message_types.go`, `Client/src/lib/protocolTypes.ts`,
      `Client/src/generated/`, `.superpowers/FINDINGS.md`. CI fails on drift
- [ ] Docs updated — anything under `docs/architecture/` (incl. `ux/`) whose
      "Source of truth" files this PR touches is updated in the same PR
      (their maintenance rule), and reference docs (`api.md`, `protocol.md`,
      `schema.md`, `server-configuration.md`) reflect any surface changes

## Scope

<!-- What adjacent work did you deliberately leave out, and why? A written
     deferral is a deliverable — see docs/contributing.md#commit-format. -->

Not included:

> **No security detail in this PR.** This repository is public, so the
> description, the commits and the branch name are all disclosure channels. If
> this change repairs a vulnerability, report it through
> [private security reporting](https://github.com/J3vb/OwnCord/security/advisories/new)
> first and describe only the control this PR adds.

## Screenshots

<!-- If UI changes, add before/after screenshots -->

## Related Issues

<!-- Link any related issues: Fixes #123, Relates to #456 -->
