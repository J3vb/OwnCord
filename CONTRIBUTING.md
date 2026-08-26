# Contributing to OwnCord

The full guide lives in **[docs/contributing.md](docs/contributing.md)** —
environment setup, the branch model, coding standards, and how to run the
checks CI runs.

This file exists so GitHub can find it: the contributing-guidelines link that
appears on new issues and pull requests only resolves `CONTRIBUTING.md` at the
repository root, in `.github/`, or in `docs/`.

Three things worth knowing before you open a pull request:

- **Branch from `dev` and target `dev`.** `main` carries releases only. See
  [Branch and PR model](docs/contributing.md#branch-and-pr-model).
- **Run the checks first.** `npm run check` from the repository root, or the
  per-stack commands in [docs/contributing.md](docs/contributing.md). CI takes
  about 15 minutes and enforces more than a plain build and test.
- **Report security issues privately**, through GitHub Security Advisories —
  never a public issue or pull request. See [SECURITY.md](SECURITY.md) and
  [docs/security.md](docs/security.md).

New to the codebase? [docs/README.md](docs/README.md) indexes everything, and
[docs/architecture/](docs/architecture/README.md) explains how the server and
client fit together.
