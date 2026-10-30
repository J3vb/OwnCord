# How OwnCord uses AI

Most of OwnCord's code is written with AI coding agents, and a person decides what gets built and ships every release. This page says how that works and what keeps the code honest. It is for anyone who wants to know how far to trust the code, or who wants to contribute.

## Who does what

- **The maintainer** decides what to build, makes the product and design calls, tests on real machines, and tags and approves releases.
- **AI agents** do most of the writing: a planning agent breaks a change into work packages, a builder agent writes the code and its tests, and a different model reviews changes that touch voice, the database, authentication or concurrency. The agent definitions live in [`.claude/agents/`](../.claude/agents/).
- **A second AI reviewer** (Codex) reads every pull request when it is marked ready.

Every change goes through a pull request to `dev` and the same CI as a human's change. Nothing merges on an agent's word: it merges when CI is green.

## What catches mistakes

AI-written code fails in recognisable ways: it copies a pattern that is almost right, it skips an error path, or it says "fixed" without proving it. These checks are there for exactly that, and each one fails CI on its own.

| Check                      | What it stops                                                                                                                                                             | Where                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tests first                | A fix lands with a test that failed before it. The client and server suites run on every PR.                                                                              | [docs/testing-behavior.md](testing-behavior.md)                                         |
| Coverage floor             | Client coverage may not drop below its floor.                                                                                                                             | `Client/coverage-floor.json`                                                            |
| Mutation testing           | Tests that run code without checking it: Stryker changes the code and the tests must notice.                                                                              | `Client/stryker.config.mjs`, nightly in `.github/workflows/nightly-test-depth.yml`      |
| Custom lint rules          | Project rules a generic linter can't see, such as WebSocket events reaching stores only through the dispatcher, every native call handling its error, and no unsafe HTML. | `Client/eslint-rules.js`                                                                |
| Server invariants          | Structural rules for the Go server: lock order, which package may touch the database, where permission checks happen, file sizes.                                         | `Server/invariants/`                                                                    |
| Budgets                    | Startup bundle size and voice-join time may not grow past their budgets.                                                                                                  | `Client/bundle-budgets.json`, `Client/voice-join-budget.json`                           |
| Generated code             | Protocol types, database queries and reference docs come from one source and CI fails on drift.                                                                           | [CLAUDE.md](../CLAUDE.md), "Generated code"                                             |
| Comment and test-title ids | Comments say the reason and test titles say the behaviour, never a ticket number from a plan the reader can't see.                                                        | `scripts/checks/check-comment-ids.mjs`, [docs/code-style.md](code-style.md), "Comments" |
| Supply chain               | Known-vulnerable dependencies and risky workflow changes.                                                                                                                 | `osv-scanner.toml`, `.github/workflows/`                                                |

## Where defects are tracked

Bugs found by hunts and reviews go into one ledger, [`.superpowers/findings-ledger.json`](../.superpowers/findings-ledger.json), with a status and a severity. A fix closes its entry in the same pull request, and the test that proves the fix stays with the code when it moves. Security problems never go in a public issue: see [docs/security.md](security.md).

## The rules agents follow

The rules are written down so they apply the same way to people and agents:

- [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md): the guardrails every change follows (a short plan before code, no `any`, every error wrapped, every goroutine stoppable).
- [docs/code-style.md](code-style.md): formatting, naming, errors, tests and comments.
- [docs/contributing.md](contributing.md): branches, pull requests and commit messages.

## What this means for you

The code is held to the checks above, not to trust in whoever wrote it. If you find something the checks missed, that is a gap in the checks: open an issue (or use the private route for anything security-related), and the fix usually adds the check that would have caught it.
