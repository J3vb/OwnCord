# auto-loop

Runs the roadmap unattended overnight. A bash loop polls GitHub every five
minutes and launches short-lived `claude -p` workers only when something
actually changed. The loop itself spends no model tokens.

Design and rationale: [`docs/plans/auto-loop-2026-09-04.md`](../../docs/plans/auto-loop-2026-09-04.md).

## Start

Double-click `scripts\auto\auto.cmd`, or:

```
bash scripts/auto/loop.sh
```

Leave the window open. **Keep the machine plugged in** — on battery it sleeps
after ten minutes and the loop sleeps with it.

Before the first unattended night, do a rehearsal. It classifies every PR and
prints what it would do, without launching a worker or merging anything:

```
bash scripts/auto/loop.sh --dry-run
```

## Stop

Close the window, press Ctrl+C, or — to stop it from anywhere, cleanly, after
the current tick:

```
touch .claude/auto/STOP
```

Delete that file before starting again.

## Steer

One line, one file:

```
.claude/auto/cursor
```

It names the roadmap task to work on next — `B5-PLAN`, `B5-0`, and so on. The
coder reads it, finds that task in `docs/plans/`, and builds it. When its PR
merges, the loop advances the cursor to whatever the PR body's `Next-Cursor:`
line names.

Change the cursor and the robot changes direction. Nothing else steers it.

## Read

| File                      | What it tells you                           |
| ------------------------- | ------------------------------------------- |
| `.claude/auto/journal.md` | the night, in order                         |
| `.claude/auto/STUCK.md`   | what it gave up on — check this first       |
| `.claude/auto/logs/`      | a full transcript per worker, plus its cost |

Everything under `.claude/auto/` is untracked scratch. Deleting it is safe;
the loop rebuilds it.

## What it will and will not do

Touches only PRs whose branch starts with `auto/`, targeting `dev`. Your own
PRs and Dependabot's are invisible to it.

Merges only when CI is green, no review thread is both unresolved and still
applicable, there is no conflict, and the last commit has had fifteen minutes
for a reviewer to respond. **The shell performs the merge — no model can
reach that button.** `main` is refused outright.

Gives up on a PR after three failed fix attempts: it labels it `auto: stuck`,
writes a line to `STUCK.md`, and never touches it again.

Stops itself at 50 sessions a night, after five consecutive worker failures,
or when the run window closes.

## Tuning

The config block at the top of `loop.sh` — run window, poll interval, session
cap, worker count, models. Edit and restart.

The prompts in `prompts/` decide behaviour. `rules.md` is shared by all three
roles and holds the hard rules; the rest are per-role. Changing a prompt takes
effect on the next worker — no restart needed.
