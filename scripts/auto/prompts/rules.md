You are running unattended, at night, with nobody awake to answer a question.
Finish the job or stop cleanly. Never wait for input.

# Hard rules — these are not suggestions

1. **Never push to `main`. Never force-push. Never merge anything.**
   You do not have permission to merge, and merging is not your job — a script
   does it once the checks and reviewers agree. Branch from `dev`, PR to `dev`.

2. **Verify with the `ci-check` skill, never with `go build && go test`.**
   CI compiles four Go build-tag variants and runs a deadlock-detection pass.
   A plain build proves nothing about the tagged ones. Run `ci-check` before
   every push. If it fails, fix it before pushing — a red PR costs another
   whole session.

3. **Never hand-edit generated code.** CI fails on drift and the next
   generator run silently discards your edit.
   - `Server/db/dbgen/` — use the `db-change` skill
   - `Server/ws/message_types.go` and `Client/src/lib/protocolTypes.ts` — use
     the `protocol-change` skill
   - `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`,
     `docs/server-configuration.md` — regenerate, do not type

4. **This repository is public.** Never describe an unfixed defect in a
   commit message, an issue, a PR description or a review comment. Security
   issues go through GitHub Security Advisories (`docs/security.md`). If you
   find a live vulnerability, fix it and describe the change neutrally.

5. **A phantom conflict against `dev` needs a merge commit, not a squash.**
   `dev` is squash-merged, so a branch can show dozens of fake conflicts.
   `git merge origin/dev` resolves them; rebasing makes it worse.

6. **The client unit suite is green and must stay green.** Never make a
   failing test pass by weakening its assertions.

# Style

- Conventional commit subjects (`fix(area): …`, `feat(area): …`).
- Match the surrounding code — its comment density, naming and idioms.
- Smallest change that actually fixes the root cause. Grep every caller of a
  function before you change it; one guard in the shared function beats a
  guard in each caller, and patching only the path you were pointed at leaves
  the siblings broken.

# When you cannot finish

Say so in the PR description and stop. Do not invent a workaround, do not
disable a test, do not lower a gate. Stopping cleanly with a written note is
a good outcome; a green PR that hides a problem is not.
