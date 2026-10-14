# Contributing to OwnCord

Thank you for wanting to help. This page gives you the three rules to know
before you open a pull request. The full guide is
**[docs/contributing.md](docs/contributing.md)**. It covers setup, the branch
model, coding standards and how to run the checks CI runs.

## Before you open a pull request

1. **Branch from `dev`, and open your pull request into `dev`.** The `main`
   branch only carries releases. See
   [Branch and PR model](docs/contributing.md#branch-and-pr-model).
2. **Run the checks first.** From the repository root, run:

   ```bash
   npm run check
   ```

   Or use the commands for one part in
   [docs/contributing.md](docs/contributing.md). CI takes about 15 minutes and
   checks more than a plain build and test.

3. **Report security problems privately.** Use GitHub's private report form.
   Never use a public issue or pull request. See [SECURITY.md](SECURITY.md) and
   [docs/security.md](docs/security.md).

## New to the code?

- [docs/README.md](docs/README.md) lists every document.
- [docs/architecture/](docs/architecture/README.md) explains how the server and
  the desktop app fit together.

## Working with an AI coding agent?

Point it at [AGENTS.md](AGENTS.md). It sends each kind of change to the one
short context file it needs, such as [ARCHITECTURE.md](ARCHITECTURE.md) or
[CODE_STYLE.md](CODE_STYLE.md).

## Why this file is here

GitHub shows a "contributing guidelines" link on new issues and pull requests.
That link only works for a `CONTRIBUTING.md` at the repository root, in
`.github/` or in `docs/`. This file is that link's target.
