# B9-26 — cross-feature journey evidence manifest

**Measured:** 2026-09-25
**Base commit:** `7732f9693bfe7632717042dcea67ae1137c0e62d` (`dev`, after B9-25 merged as [#1795](https://github.com/J3vb/OwnCord/pull/1795))
**Branch:** `fm/b9-26-impl`
**Plan:** [`.claude/plans/b9-26-cross-feature-journeys.plan.md`](../../.claude/plans/b9-26-cross-feature-journeys.plan.md)
**PRD:** [b9-unified-experience-accessibility-polish.prd.md](b9-unified-experience-accessibility-polish.prd.md)
**Requirements:** BPR-052/BPR-054 client half, BPR-060, BPR-070, BPR-071, BPR-072, BPR-073, BPR-090, BPR-091
**Owner decisions applied:** Q1 (accessibility bar; manual NVDA/Orca screen-reader check **dropped** 2026-09-24), Q2, Q3, Q4, Q6, Q10, Q13.

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

The plan's inventory rows were re-read at `7732f969`:

| #   | Plan claim                                                                  | Verdict at `7732f969`                                              |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Distinct unit/contract/frontend/native/fullstack commands exist.            | Holds (`Client/package.json:20-45`).                               |
| 2   | The accessibility smoke uses mocked Tauri and cannot prove native traffic.  | Holds (`Client/tests/e2e/a11y-smoke.spec.ts:1-24`).                |
| 3   | Consent/moderation evidence obligations are named in the B5 exit follow-up. | Holds; the B5 exit was accepted 2026-09-24 at exit SHA `458301fd`. |

**Drift recorded:** the plan was drafted at `0beee8e4c50ca18823750e381d3a1d6e327029b8`.
That commit is an ancestor of this base with 83 commits between them, including
the whole B9-1..B9-25 chain. No inventory row changed meaning. B9-25 (the plan's
last dependency) is merged, so B9-26 is unblocked.

## Failing control, then the fix

This lane adds no production fix; the journeys all pass at the base. The
"failing control" for a qualification lane is that the join is **not** already
covered by a per-lane spec: the four journeys below chain features that only
have isolated coverage today (`b9-reports.spec.ts`, `b9-moderation-actions.spec.ts`,
`b9-moderation-notices.spec.ts`, `b9-personal-appeals.spec.ts`, `b9-appeal-review.spec.ts`,
`b9-message-requests.spec.ts`, `b9-account-settings.spec.ts`, `nsfw-consent.spec.ts`).
The new spec asserts the seam, not the endpoints.

## Journey matrix

Command for every row, from `Client/`:
`npx playwright test --config playwright.config.fullstack.ts tests/e2e/fullstack/b9-journeys.spec.ts --workers=1`

| #   | Journey                                                                                                                           | Requirements                                | Roles                                                 | Platform                   | Result at `7732f969`                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- | -------------------------- | -------------------------------------------------------------- |
| A   | Report → warn → notice → appeal → appeal decision, chained in the client                                                          | BPR-070, BPR-071, BPR-072, BPR-073          | owner (alice), member/subject (bob), reporter (carol) | fullstack (real Go server) | Pass (8.5 s)                                                   |
| B   | Retention disclosure read → self-erasure → subject content and membership gone for the observer                                   | BPR-052/BPR-054 client half, BPR-090        | owner (alice), subject (bob)                          | fullstack (real Go server) | Pass (10.3 s)                                                  |
| C   | First-contact text-only request → accept → block from member menu → composer gates                                                | BPR-060                                     | member (bob), stranger                                | fullstack (real Go server) | Pass (4.4 s)                                                   |
| D   | Session displacement: a second device signs in, the first shows "Signed in elsewhere", "Use here" takes it back                   | BPR-090, lifecycle/compatibility            | member (bob), second device                           | fullstack (real Go server) | Pass (5.9 s)                                                   |
| E   | Recovery-kit enrolment → logout → recovery from the connect page                                                                  | BPR-090, account lifecycle                  | member (bob)                                          | fullstack (real Go server) | Pass (7.2 s)                                                   |
| F   | External-content consent gates the native broker; re-entry cannot bypass; destinations confined; logout stops first-party traffic | BPR-061, BPR-062, BPR-092 (desktop privacy) | member (alice)                                        | native (Windows WebView2)  | CI-only; spec in `Client/tests/e2e/native/b9-journeys.spec.ts` |

### What each journey proves

**A — the moderation join.** A member's report reaches the queue as
authorized evidence (`About bob`); the owner takes and acts on it; the warning
reaches the recipient live as a notice with no actor identity; the recipient
files and tracks an appeal in Safety using only member-safe routes; the owner
decides it in the Appeals tab; the decision reaches the recipient, clears the
notice, and the server's `/appeals/mine` agrees. This is the one place all five
moderation milestones must agree, so a DTO seam between them cannot hide.

**B — the lifecycle join.** The observer reads the server-default retention
sentence from `server-info` (this server keeps indefinitely). The subject erases
their own account through the client; the server refuses the erased credential,
hard-deletes the content (`/channels/{id}/messages` no longer holds it), and
sends `member_ban` so the live observer's member row drops. No tombstone is owed
live, so the rendered message persists until the next authoritative re-read; the
join is that re-reading the channel no longer returns it. No retention window is
promised for erasure (it is immediate and permanent).

**C — the first-contact join.** A stranger's first DM arrives as a text-only
request. Accepting opens the held message as an ordinary conversation. Blocking
the sender from the member context menu (which routes through the same server
`PUT /blocks/{id}`) is the same state the DM composer reads: the composer gates
with "You've blocked this user. Unblock to send messages.", and the server
refuses a new DM from the blocked sender. This joins the request decision
(B9-6) to block (B5) and composer gating (B13).

**D — session switching.** A second real client (a second browser context with
its own transport) signs bob in; the server keeps one live socket per account,
so the first device is displaced and shows the "Signed in elsewhere" banner
with "Use here". Taking the session back reconnects the first device, clears
the notice, and leaves the composer usable. This qualifies the lifecycle and
compatibility clause of BPR-090 without violating the one-live-socket rule.

**E — the recovery lifecycle.** bob enrols a recovery kit (the secret is shown
once); logging out returns to sign-in; recovering from the connect page with
that secret and a new password signs him in without the second factor. The kit
is single-use: the old password no longer signs in, the new one does, and a
second redemption of the same secret is refused. This qualifies the account
lifecycle's recovery path with the client's real `POST /auth/recover` flow.

**F — desktop privacy (native).** The genuine Tauri IPC is observed (a
`window.fetch` to `ipc.localhost`); a link reaches the external-content broker
only after consent, a warm-cache re-entry cannot bypass the gate, "Ask each
time" admits exactly the activated item, every first-party HTTP destination is
the configured server (no provider traffic direct), and logout keeps that
confinement. Runs in `client-native` on Windows in CI; it cannot run on this
headless Linux host.

### Automated accessibility evidence (BPR-091)

Each B9 lane already carries its own ARIA name/role and keyboard/focus tests;
this lane does not re-assert them per feature. Its own added UI interactions
use the same accessible affordances the lane specs use (named buttons, focusable
rows, keyboard activation) and add no new user-visible control, string or
token. The manual NVDA/Orca screen-reader check is **dropped** by the owner
(2026-09-24); the automated evidence is the acceptance record, not a pending
manual pass.

## Bundle and runtime ratchet (Task 4)

`npm run build:budget && npm run check:budgets`, from `Client/` at this head:

| Chunk                 | Measured  | Budget    | Headroom |
| --------------------- | --------- | --------- | -------- |
| startup closure       | 96,606 B  | 97,000 B  | 394 B    |
| MainPage              | 62,433 B  | 64,000 B  | 1,567 B  |
| livekit (lazy)        | 133,372 B | 135,000 B | 1,628 B  |
| livekitSession (lazy) | 23,008 B  | 24,000 B  | 992 B    |

No production change was made, so these are the base's figures; no budget was
raised. The budget notes in `Client/bundle-budgets.json` name B9-26 as the
re-baseline point; this lane confirms both shared budgets hold with the headroom
above and does not raise them.

## B8 deferrals and limits

- Browser/PWA/mobile product and responsive-device qualification are deferred
  with B8; not qualified here.
- The native journey (E) runs only in `client-native` on Windows in CI; it is
  not observed on this host.
- The owner's OS 200 % zoom checks remain owner items where a lane lists them;
  they are not closed here.
- No new ledger finding was opened: the journeys exposed no defect. The one
  pre-existing limitation (a deleted message is not tombstoned live; the
  observer sees it gone on the next read) is existing accepted behaviour, not a
  defect, and is asserted as such in journey B.

## Validation commands

From `Client/`, at this head:

- `npx tsc -p tsconfig.e2e.json --noEmit` — the E2E specs typecheck.
- `npx playwright test --config playwright.config.fullstack.ts tests/e2e/fullstack/b9-journeys.spec.ts --workers=1` — 5 passed.
- `npm run test:e2e:fullstack` is the CI job's command; CI runs the full suite.
- `npm run build:budget && npm run check:budgets` — all budgets ok.
