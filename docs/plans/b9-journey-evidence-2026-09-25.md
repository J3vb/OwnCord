# B9-26 — cross-feature journey evidence manifest

**Measured:** 2026-09-25
**Base commit:** `0a3e7183cad253a1a5b2d19573add9ed7b9c783d` (`dev`, after the root
agent guides merged as [#1796](https://github.com/J3vb/OwnCord/pull/1796); the
B9 chain's head before that was `7732f969`, B9-25 as
[#1795](https://github.com/J3vb/OwnCord/pull/1795))
**Journey head:** `66da915a0cdc4b1d8fc2bde632e8ca7099e1cfca` on `fm/b9-26-impl`;
the fullstack results below are the 9-passed run at that commit. The review
round after it tightened assertions in journeys B, F, G, H and I (no journey
was removed or loosened); that revision is **pending the `client-fullstack` CI
run** at the PR head, since this host has no Go toolchain to build the server.
**Branch:** `fm/b9-26-impl`
**Plan:** [`.claude/plans/b9-26-cross-feature-journeys.plan.md`](../../.claude/plans/b9-26-cross-feature-journeys.plan.md)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md)
**Requirements:** BPR-052/BPR-054 client half, BPR-060, BPR-061, BPR-062,
BPR-063, BPR-064, BPR-070, BPR-071, BPR-072, BPR-073, BPR-090, BPR-091,
BPR-092 (desktop half)
**Owner decisions applied:** Q1 (accessibility bar; manual NVDA/Orca
screen-reader check **dropped** 2026-09-24), Q2, Q3, Q4, Q6, Q10, Q13.

This is a qualification lane: it adds journey tests and evidence and fixes
only defects the journeys expose. No production code changed in this PR.

## Environment

| Tool       | Version                                 | Note                                                                     |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Host       | Ubuntu 24.04.5 LTS, Linux 6.8.0, x86_64 | Headless agent host: no display, desktop session or screen reader.       |
| Node       | 26.9.0                                  | `nvm use 26`                                                             |
| Playwright | 1.63.0, bundled Chromium                | Fullstack suite. Windows native suite is CI-only (no Windows host here). |
| Go         | 1.26.7 linux/amd64                      | The real test server binary (`npm run test:e2e:build-server`).           |

## Inventory re-read at this base (Task 0)

The plan's inventory rows were re-read at the base:

| #   | Plan claim                                                                  | Verdict                                                            |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Distinct unit/contract/frontend/native/fullstack commands exist.            | Holds (`Client/package.json`).                                     |
| 2   | The accessibility smoke uses mocked Tauri and cannot prove native traffic.  | Holds (`Client/tests/e2e/a11y-smoke.spec.ts`).                     |
| 3   | Consent/moderation evidence obligations are named in the B5 exit follow-up. | Holds; the B5 exit was accepted 2026-09-24 at exit SHA `458301fd`. |

**Drift recorded:** the plan was drafted at `0beee8e4c50ca18823750e381d3a1d6e327029b8`.
That commit is an ancestor of this base with 84 commits between them, including
the whole B9-1..B9-25 chain and the root agent guides (#1796). No inventory row
changed meaning. B9-25 (the plan's last dependency) is merged, so B9-26 is
unblocked. `origin/dev` was merged into the lane (merge, not rebase) before the
fix commit, as the 2026-09-25 instruction required.

## Failing control, then the fix

This lane adds no production fix; the journeys pass at the base. The
"failing control" for a qualification lane is that the join is **not** already
covered by a per-lane spec: the journeys below chain features that only have
isolated coverage today (`b9-reports.spec.ts`, `b9-moderation-actions.spec.ts`,
`b9-moderation-notices.spec.ts`, `b9-personal-appeals.spec.ts`,
`b9-appeal-review.spec.ts`, `b9-message-requests.spec.ts`,
`b9-account-settings.spec.ts`, `nsfw-consent.spec.ts`). The journey spec asserts
the seam, not the endpoints.

## Journey matrix

Command for every fullstack row, from `Client/`:
`npx playwright test --config playwright.config.fullstack.ts tests/e2e/fullstack/b9-journeys.spec.ts --workers=1`
— **9 passed** at `66da915a`.

| #   | Journey                                                                                                                              | Requirements                                  | Allowed roles                                  | Refused roles                                               | Network              | Platform                   | Result                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Report → warn → notice → appeal → appeal decision, chained in the client                                                             | BPR-070, BPR-071, BPR-072, BPR-073            | owner (alice), reporter (carol), subject (bob) | —                                                           | online throughout    | fullstack (real Go server) | Pass (8.4 s)                                                                                                                                                                                           |
| B   | Retention disclosed → reported + appealed subject self-erases → observer's content and membership gone, report outcome survives      | BPR-052/BPR-054 client half, BPR-070, BPR-090 | owner (alice), reporter (carol), subject (bob) | —                                                           | online throughout    | fullstack (real Go server) | Pass at `66da915a` (11.4 s); tightened revision pending `client-fullstack` CI                                                                                                                          |
| C   | First-contact text-only request → accept → block from member menu → composer gates                                                   | BPR-060                                       | member (bob)                                   | stranger blocked, new DM refused 403                        | online throughout    | fullstack (real Go server) | Pass (5.4 s)                                                                                                                                                                                           |
| D   | Second device signs in → first shows "Signed in elsewhere" → "Use here" takes it back                                                | BPR-090 lifecycle/compatibility               | member (bob), second device                    | first device displaced                                      | online throughout    | fullstack (real Go server) | Pass (5.9 s)                                                                                                                                                                                           |
| E   | Recovery-kit enrolment → logout → recovery from the connect page                                                                     | BPR-090 account lifecycle                     | member (bob)                                   | spent kit refused (401)                                     | online throughout    | fullstack (real Go server) | Pass (7.1 s)                                                                                                                                                                                           |
| F   | Transport cut mid-session → B9-25 notice says this server is unreachable + Retry → reconnect, state kept                             | BPR-090, BPR-092                              | member (bob)                                   | —                                                           | **cut and restored** | fullstack (real Go server) | Pass at `66da915a` (5.9 s); tightened revision pending `client-fullstack` CI                                                                                                                           |
| G   | Member refused the queue, a queue action and another account's appeal, in UI and by the server                                       | BPR-071                                       | owner (alice)                                  | member (bob): queue, assign, close, list and decide all 403 | online throughout    | fullstack (real Go server) | Pass at `66da915a` (6.5 s); tightened revision pending `client-fullstack` CI                                                                                                                           |
| H   | Labelled channel's evidence waits for the moderator's own acknowledgement; revoke takes it away                                      | BPR-063, BPR-071                              | owner (alice), reporter (carol)                | —                                                           | online throughout    | fullstack (real Go server) | Pass at `66da915a` (6.6 s); tightened revision pending `client-fullstack` CI                                                                                                                           |
| I   | Integrated accessibility matrix: joined inbox + Moderation Center at 940×500 with 20 px text, contrast, keyboard, reduced motion     | BPR-091                                       | member (bob), owner (alice)                    | —                                                           | online throughout    | fullstack (real Go server) | Pass at `66da915a` (7.0 s); tightened revision pending `client-fullstack` CI                                                                                                                           |
| J   | External-content consent gates the native broker; warm re-entry after consent does not refetch; destinations confined through logout | BPR-061, BPR-062, BPR-092 (desktop)           | member (alice)                                 | —                                                           | online throughout    | native (Windows WebView2)  | **CI-only**; spec in `Client/tests/e2e/native/b9-journeys.spec.ts`. Not run on this headless host, so **pending the `client-native` CI run** — not claimed as desktop-qualified until it passes there. |

Requirement coverage map (BPR-060..064, 070..073, 090..092):

| Requirement | Journey row(s) | Notes                                                                                                                                                                   |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-060     | C              | first-contact preview, accept, block, sender refused                                                                                                                    |
| BPR-061     | J (native)     | existing link/GIF/media set with consent; the per-lane rich-content evidence is `b9-rich-content.spec.ts`                                                               |
| BPR-062     | J (native)     | bounded retrieval + destination confinement; server half is B5-1/B7 (not re-qualified here)                                                                             |
| BPR-063     | H              | server-backed acknowledgement before protected reads; inherit/revoke; the per-lane gate evidence is `b9-nsfw-consent.spec.ts` + `fullstack/nsfw-consent.spec.ts`        |
| BPR-064     | existing       | English catalogs/formatting: `Client/tests/unit/ui-strings.test.ts`, `src/i18n/format.test.ts`, `Client/tests/e2e/b9-text-expansion.spec.ts` (no new text in this lane) |
| BPR-070     | A, B           | report message/user/attachment; own status only                                                                                                                         |
| BPR-071     | A, B, G, H     | permission-gated queue/evidence; role-loss cleanup; confidential DTOs                                                                                                   |
| BPR-072     | A              | warning outcome; recipient outcome; narrow controls                                                                                                                     |
| BPR-073     | A, B           | one appeal per action; status and decision; erasure                                                                                                                     |
| BPR-090     | B, D, E, F, I  | lifecycle/compatibility, recovery, session switching, budgets                                                                                                           |
| BPR-091     | I + per-lane   | automated ARIA name/role and keyboard/focus per lane (named below); no manual screen reader (owner 2026-09-24)                                                          |
| BPR-092     | F, J           | desktop network/offline honesty; unsupported-browser half stays with B8                                                                                                 |

### What each journey proves

**A — the moderation join.** A member's report reaches the queue as
authorized evidence; the owner takes and acts on it; the warning reaches the
recipient live as a notice with no actor identity; the recipient files and
tracks an appeal in Safety using only member-safe routes; the owner decides it
in the Appeals tab; the decision reaches the recipient, clears the notice, and
the server's `/appeals/mine` agrees.

**B — the lifecycle join.** The observer reads the server-default retention
sentence from `server-info` (this server keeps indefinitely). The subject is
reported and warned and appeals first, then erases their own account through the
client; the server refuses the erased credential, hard-deletes the content, the
report's outcome row survives rewritten (`state: subject_erased`, no subject)
and is no longer in the open queue, bob's own appeal (listed for the owner
before the erasure) is gone from both the open and decided appeal lists, and
`member_ban` drops the live observer's member row. No tombstone is owed live, so the rendered message persists until
the next authoritative re-read; the join is that re-reading the channel no
longer returns it.

**C — the first-contact join.** A stranger with a tracker avatar sends a first
DM. The request arrives as plain text: the row renders no `<img>` and the test
watches every browser request and native broker call, asserting none targets
`tracker.invalid` and no broker invocation happens. Accepting opens the held
message; blocking the sender from the member context menu is the same state the
DM composer reads; the server refuses a new DM from the blocked sender.

**D — session switching.** A second real client (a second browser context with
its own transport) signs bob in; the server keeps one live socket per account,
so the first device is displaced and shows "Signed in elsewhere" with "Use
here". Taking the session back reconnects the first device, clears the notice,
and leaves the composer usable.

**E — the recovery lifecycle.** bob enrols a recovery kit (secret shown once);
logging out returns to sign-in; recovering from the connect page with that
secret and a new password signs him in. The kit is single-use: the old password
no longer signs in, the new one does, and a second redemption of the same secret
is the uniform 401 `UNAUTHORIZED` (`service.ErrRecoveryKitInvalid`), not a 500 or
429 that any `>= 400` would accept.

**F — network loss and recovery.** The transport is cut mid-session
(`bobTransport.offline()` fails every dial); the B9-25 notice first says
"Reconnecting...", then says this server is unreachable, with a Retry, once a
dial has failed, and never claims the device itself is offline.
Restoring the transport clears the notice; the pre-cut message is still rendered
and a new send lands, confirmed from the server's own history.

**G — refused roles.** A member is denied the queue, taking and closing a
report (queue actions), the appeals list and an appeal decision by the server
(403), and the client offers no Moderation Center entry. The owner, who holds the permission, still sees the appeal and can decide
it — the refusal was the role, not the contract.

**H — consent to evidence.** A labelled channel's evidence is concealed until
the moderator's own acknowledgement, which is recorded with the server before
the evidence is read; revoking it from another session regates the evidence.

**I — integrated accessibility matrix.** The plan's Task 3 matrix, run on the
joined surfaces: the Message Requests inbox and the Moderation Center reflow at
the 940×500 minimum window with 20 px text (no horizontal scroll, no clipped
control), their text meets the Q1 4.5:1 contrast bar, the focused queue row
opens with Enter and Escape returns focus to it, and no running animation is
required under reduced motion.

**J — desktop privacy (native).** The genuine Tauri IPC is observed (a
`window.fetch` to `ipc.localhost`); a link reaches the external-content broker
only after consent, "Ask each time" admits exactly the activated item (a length
assertion, so a duplicate fails), a warm-cache re-entry after consent does not
refetch, every first-party HTTP destination is the configured server, and logout
keeps that confinement. Runs in `client-native` on Windows in CI; it cannot run
on this headless Linux host, so it is **pending that CI run**, not claimed.

### Automated accessibility evidence (BPR-091)

The owner dropped the manual NVDA/Orca screen-reader check (2026-09-24), so the
automated ARIA name/role and keyboard/focus evidence is the acceptance record.
Each B9 lane already carries it; this lane names the owning spec per area and
runs its own integrated matrix (journey I):

| Area (lane)                                   | Automated BPR-091 evidence                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shared primitives/tokens (B9-1/B9-2)          | `Client/tests/e2e/b9-primitives.spec.ts`                                                                        |
| Message Requests inbox/decisions (B9-5/6)     | `Client/tests/e2e/b9-message-requests.spec.ts`, `fullstack/b9-message-requests.spec.ts`                         |
| NSFW consent gate (B9-7)                      | `Client/tests/e2e/b9-nsfw-consent.spec.ts`, `fullstack/nsfw-consent.spec.ts`                                    |
| External-content consent (B9-8)               | `Client/tests/e2e/b9-content-consent.spec.ts`, `native/b9-content-consent.spec.ts`                              |
| Rich content states (B9-9)                    | `Client/tests/e2e/b9-rich-content.spec.ts`                                                                      |
| Reports (B9-10)                               | `Client/tests/e2e/b9-reports.spec.ts`, `fullstack/b9-reports.spec.ts`                                           |
| Moderation queue (B9-11)                      | `Client/tests/e2e/b9-moderation-queue.spec.ts`                                                                  |
| Moderation workflow (B9-12)                   | `Client/tests/e2e/b9-moderation-workflow.spec.ts`                                                               |
| Warning/timeout + removal/kick/ban (B9-13/14) | `Client/tests/e2e/b9-moderation-actions.spec.ts`                                                                |
| Moderation notices (B9-15)                    | `Client/tests/e2e/b9-moderation-notices.spec.ts`                                                                |
| Personal appeals (B9-16)                      | `Client/tests/e2e/b9-personal-appeals.spec.ts`                                                                  |
| Appeal review (B9-17)                         | `Client/tests/e2e/b9-appeal-review.spec.ts`                                                                     |
| English text seam (B9-18/19/20)               | `Client/tests/e2e/b9-text-expansion.spec.ts`, `Client/tests/unit/ui-strings.test.ts`, `src/i18n/format.test.ts` |
| Shell polish (B9-21)                          | `Client/tests/e2e/b9-shell-polish.spec.ts`, `Client/tests/browser/reconcile-focus.test.ts`                      |
| Messaging polish (B9-22)                      | `Client/tests/e2e/b9-messaging-polish.spec.ts`                                                                  |
| Account/settings polish (B9-23)               | `Client/tests/e2e/b9-account-settings.spec.ts`                                                                  |
| Voice/media polish (B9-24)                    | `Client/tests/e2e/b9-voice-polish.spec.ts`                                                                      |
| Desktop capabilities (B9-25)                  | `Client/tests/e2e/b9-desktop-capabilities.spec.ts`                                                              |
| This lane (B9-26)                             | `Client/tests/e2e/fullstack/b9-journeys.spec.ts` (journey I)                                                    |

The integrated matrix is automatable on this host; the native journey J is the
CI-only one.

## Bundle and runtime ratchet (Task 4)

B9-26 is the agreed re-baseline point. `npm run build:budget && npm run check:budgets`,
from `Client/`, at this head (deterministic across two runs):

One rule for every budget (owner decision 2026-09-25), never raising one:
new budget = min(current budget, measured + 1,000 B rounded up to the next 500 B).

| Chunk                 | Measured  | Rule result           | Budget (was)            | Headroom |
| --------------------- | --------- | --------------------- | ----------------------- | -------- |
| startup closure       | 96,606 B  | min(97,000, 98,000)   | 97,000 B (97,000)       | 394 B    |
| MainPage              | 62,433 B  | min(64,000, 63,500)   | **63,500 B (64,000)**   | 1,067 B  |
| livekit (lazy)        | 133,372 B | min(135,000, 134,500) | **134,500 B (135,000)** | 1,128 B  |
| livekitSession (lazy) | 23,008 B  | min(24,000, 24,500)   | 24,000 B (24,000)       | 992 B    |

No budget was raised; two were lowered. Startup headroom is tight (394 B)
ahead of B9-27. `Client/bundle-budgets.json` records the rule once and each
figure in its note.

**Startup.** The accepted B7 baseline is a Windows 11 desktop with
`npm run tauri dev` (`docs/plans/b7-0-client-baseline-2026-09-19.md`): 598 ms to
the connect form, 380 MB WebView RSS. That method needs a real desktop session
and is **not measurable on this headless Linux host** (B9-0 records the same
limit). The automatable proxy measured here is the production bundle: build:budget
at the base and the per-chunk gzip figures above, with no regression.

**Interaction.** The accepted B9-21 baseline is a keyed reconciler that replaces
only the changed row: `Client/tests/unit/reconcile.test.ts` (7 tests) proves an
unchanged re-render builds 0 rows, a single changed signature rebuilds only that
row, and focus survives a replaced row. Re-run at this head: 7 passed. This is
the automatable interaction measurement on this host.

**Memory.** The CDP lifecycle soak (`Client/tests/e2e/fullstack/long-session.spec.ts`,
`support/lifecycle-probe.ts`) is the automatable memory measurement, but it needs
`OWNCORD_E2E_LIVEKIT_BINARY` and is excluded by this host's resource limits (one
fullstack run at a time, no LiveKit here). It gates every `client-fullstack` PR
in CI and is not re-run in this lane; recorded as a CI gate, not a result.

## B8 deferrals and limits

- Browser/PWA/mobile product and responsive-device qualification are deferred
  with B8; not qualified here.
- Journey J (native) runs only in `client-native` on Windows in CI; not observed
  on this host, so its matrix row is documented as pending that run.
- The owner's OS 200 % zoom checks remain owner items where a lane lists them;
  journey I covers the automatable 940×500 / 20 px reflow and contrast, but
  not OS zoom.
- No new ledger finding was opened: the journeys exposed no defect. The one
  pre-existing limitation (a deleted message is not tombstoned live; the
  observer sees it gone on the next read) is existing accepted behaviour,
  asserted as such in journey B.

## Validation commands

From `Client/`, at `66da915a` (the fullstack re-run of the review-round
revision is pending `client-fullstack` CI):

- `npx tsc -p tsconfig.e2e.json --noEmit` — the E2E specs typecheck.
- `npx playwright test --config playwright.config.fullstack.ts tests/e2e/fullstack/b9-journeys.spec.ts --workers=1` — 9 passed.
- `npx vitest run tests/unit/reconcile.test.ts` — 7 passed (interaction baseline).
- `npm run build:budget && npm run check:budgets` — all budgets ok.
- `npm run test:e2e:fullstack` is the CI job's command; CI runs the full suite.
