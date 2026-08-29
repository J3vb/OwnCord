# B2 — Freeze server protocol, trust, and compatibility contracts

**Drafted:** 2026-08-28  
**Base commit:** `64d2e108` (`dev`, post-PR #1425); `main` @ `b7d388a3` =
`v1.2.0-alpha.4` — claims verified at `64d2e108`; the branch was rebased
onto `dd7ed091` (#1432) before merge  
**Status:** in progress — entry gate 1 of 3 met at draft time (see below); B2-0,
B2-1 and B2-8 landed 2026-08-28, B2-2 (with B2-3 and B2-4 folded in) and B2-5 on 2026-08-29 (evidence in their sections); B2-6 landed 2026-08-29 (PR #1441); B2-7 is next.
Update this line, not only the step table, when a step lands.

Primary inputs:

- [beta roadmap](repo-health-roadmap-2026-08-23.md), B2 section and HP-2
- [HP-1 scorecard](hp-1-scorecard-2026-08-27.md), "Hand-off to B2" and "Open
  items carried past B1"
- [issue register](repo-health-issue-register-2026-08-23.md) — every row
  tagged `B2`
- [requirement traceability](beta-requirements-traceability-2026-08-23.md) —
  BPR-031, 032, 040, 050, 051, 080–083

## Context

B1 made the repository discoverable and gave the protocol one owner
(`protocol/schema.json`). It changed no behaviour. B2 is the first phase that
does: it freezes the contracts every later server service and every client
must obey — the protocol epoch, the update order, the trust model, the
permission predicates, the audit surface, and the boundary of what beta does
not promise (plugins, federation, a directory).

The owner's decision on 2026-08-28: execute B2 as written rather than cut the
roadmap to ship sooner. BPR-002 (no deadline) and BPR-003 (frozen scope)
stand. Sizes below are personal estimates and never a gate; the honest total is
one to one and a half weeks with agents working steps in parallel.

## Steps at a glance

| Step     | What                                                                                                              | Size     | Parallel with          |
| -------- | ----------------------------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| **B2-0** | **Done 2026-08-28.** Alpha.4 verified; `dev` synced (#1432); `environment: release`; ENV-03; `dev` `strict: true` | hours    | —                      |
| **B2-1** | Capture the epoch-1 fixtures; retire `voice_speakers` and `member_leave`                                          | 1 day    | B2-6, B2-7             |
| **B2-2** | Protocol epoch and negotiation — **DONE 2026-08-29 (slim; absorbs B2-3, B2-4)**                                   | 1 day    | serialized, after B2-8 |
| **B2-3** | Server-first updates through the signed manifest — folded into B2-2                                               | ½ day    | after B2-2             |
| **B2-4** | Compatibility matrix — folded into B2-2                                                                           | ½ day    | after B2-2             |
| **B2-5** | One permission predicate per security property — **DONE 2026-08-29 (PR #1440)**                                   | 1–2 days | serialized             |
| **B2-6** | Safe audit coverage                                                                                               | ½ day    | B2-1, B2-7             |
| **B2-7** | Trust model, absence proofs, plugin boundary                                                                      | 1 day    | B2-1, B2-6             |
| **B2-8** | The nine B2-tagged findings                                                                                       | 1 day    | before B2-2            |
| **B2-9** | Security owners and acceptance tests                                                                              | spread   | —                      |
| **HP-2** | Protocol and threat-model sign-off                                                                                | —        | —                      |

Order: B2-0, B2-1, B2-8, then B2-2 → B2-3 → B2-4; B2-5 is serialized on its
own; B2-6, B2-7 and B2-9 run in parallel where the table allows.

## Entry gate

| Condition                                                            | State 2026-08-28                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| B1 complete; protocol source has one owner                           | **Met.** HP-1 accepted 2026-08-27; `protocol/schema.json` generates both consumers from `npm run generate`.                           |
| Confirmed security findings have private owners and acceptance tests | **B2-9.** Seven local reports under the gitignored `docs/security-findings/`, each already mapped to a public row (HP-0, question 4). |
| Alpha protocol fixtures and updater contracts are captured           | **B2-1.** Must land before any protocol change — alpha.4 is the last client that speaks the pre-epoch wire, and it is live now.       |

## What B1 carried over that B2-0 closes

| Item                                        | State                                                                                                                                   | B2-0 action                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `dev` `strict: false` (B1 exit condition 6) | 12 checks pinned; a PR can still merge without re-testing against a moved base                                                          | Flip to `true` — owner approved 2026-08-28 |
| `environment: release` absent from workflow | The `release` environment exists (1 reviewer) but `release.yml` does not name it, so the reviewer gate never fires                      | Add it to the publishing job               |
| ENV-03 `MSYS_NO_PATHCONV`                   | `Server/scripts/docker-smoke.sh` still needs the variable set by the caller; Git Bash on Windows otherwise reports a false boot failure | Export it inside the script                |

## Verify before you implement

Every claim the roadmap's B2 section rests on, re-tested against `64d2e108`.

| Claim                                         | Verdict                     | What it means for the work                                                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No protocol epoch exists                      | **Confirmed**               | `protocol/schema.json` has `"version": 1` — the schema _format_, read by `Server/cmd/genprotocol/main.go:35`. The `auth` payload (`Server/ws/serve_auth.go:46-52`) is `token`, `last_seq`, `active_channel_id`. Nothing carries a version.                   |
| The client has no "update required" path      | **Half refuted**            | `Client/src/lib/ws.ts:306-314` already treats `auth_error` as non-recoverable: sets `intentionalClose`, dispatches, disconnects. So a rejected client **does not** loop today. B2-2 rides that path and pins it with a test; it does not build a new one.    |
| The update endpoint ignores compatibility     | **Confirmed**               | `Server/api/client_update.go:34` advertises the newest GitHub release for the target. The signed manifest (`Server/updater/verify.go:29`) has `version`, `asset`, `sha256`, `assets` — no epoch.                                                             |
| WASM is disabled by default                   | **Confirmed, already done** | `Server/config/config.go` (plugins `Enabled` defaults false; the example config says "Disabled by default"). B2-7 adds wording only.                                                                                                                         |
| Reserved entries with no sender (S-15)        | **Confirmed**               | `protocol/schema.json:65` `voice_speakers`, `:75` `member_leave`. No production emit site in `Server/`.                                                                                                                                                      |
| L-08 prebuilt WASM still tracked              | **Refuted**                 | Deleted in #1418; `.gitignore` ignores it; the example's README documents the build. Only the deterministic-build gate remains, and it is blocked (B1 plan). B2-7 item 4 is that decision, not the untracking.                                               |
| Audit events exist                            | **Confirmed**               | `Server/db/audit_writer.go` (async batched writer, drops are logged); the `WriteAudit(`, `LogAudit(` and `EnqueueAudit(` call sites (a grep for `Audit(` catches all three). Invite create/revoke have none (S-02).                                          |
| Permission helpers exist but are mirrored     | **Confirmed**               | `Server/permissions/permissions.go`: `HasPerm`, `HasAnyPerm`, `HasAdmin`, `HasServerPerm`, `EffectivePerms`, `EffectiveChannelPerms`. Typing checks a weaker permission than posting (S-01); ready/refresh/ws mirror send policy by hand (S-12).             |
| Trust model has one document                  | **Refuted**                 | Pieces live in `docs/protocol.md`, `docs/architecture/voice-e2ee.md`, `docs/credential-storage.md`, `docs/security.md`. No single statement of what the operator can read.                                                                                   |
| Federation / directory / central identity     | **Absent, unproven**        | Nothing exists. B2-7 turns "nothing" into a test that fails if something appears.                                                                                                                                                                            |
| WS application close codes in use             | **Refuted**                 | None. Non-test code closes only with the library's 1000/1011. The `4000`/`4096` grep hits are unrelated constants (`CONFIRM_TIMEOUT_MS`, `maxMessageLen`, `Vec::with_capacity`, `touchThrottleMaxEntries`). `4426` will be the first application close code. |
| CI needs a new job for the compatibility test | **Refuted**                 | A Go table test runs under `go test ./...`, which the required `Server Build & Test` check already executes. No new job, no pin-script change for B2-4.                                                                                                      |

Net effect: B2-2 is smaller than the roadmap implies (the rejection path
exists), B2-4 needs no CI change, and the trust-model document is a genuine
gap.

## B2-0 — Alpha.4 out the door, `dev` synced, release hygiene

Done in this order; the tag is already pushed.

1. **Verify the release.** Run `33144028968` completed `success` 2026-08-28
   05:23 UTC. `gh release view v1.2.0-alpha.4 --json assets --jq '.assets|length'`
   → **20**, the same set alpha.3 shipped: server binary + archive + `.sig` +
   `checksums.sha256` + source snapshot + signed `server-update-manifest.json`,
   plus the AppImage/deb/NSIS client assets and their signatures. The
   workflow's own `Verify signed assets against pinned server update key` step
   passed inside that run. Record the asset list in HP-2 as the pre-epoch
   updater contract.
2. **Sync `dev`.** **Done 2026-08-28 by the owner** — #1432 "merge main into
   dev after the v1.2.0-alpha.4 release" (`dd7ed091`), the same shape as #1425.
   `main` was 5 ahead of `dev` before it. **Known trap, still live:**
   squash-merging a sync PR re-diverges `dev` from `main` by content-identical
   commits; the next release PR then shows phantom conflicts and is unblocked
   by creating `release/<tag>` with `git merge --no-ff main` (how alpha.4
   itself was unblocked). Accept the trap; it is cheaper than changing the
   merge model mid-phase.
3. **`environment: release`.** In `.github/workflows/release.yml`, add
   `environment: release` at job level on the `publish` job (its header is
   near line 490 of `release.yml`; the "Generate server update manifest" and
   signing steps live inside it). The environment
   exists with one reviewer, so the next tag waits for approval. Verify with
   `actionlint` (the hygiene job runs it in CI; locally it may be absent on
   Windows — CI is the gate).
4. **ENV-03.** Add `export MSYS_NO_PATHCONV=1` near the top of
   `Server/scripts/docker-smoke.sh`. Verify: on Git Bash, build and run the
   smoke **without** setting the variable in the shell —
   `docker build --build-arg VERSION=ci -t owncord-smoke:candidate Server/ && bash Server/scripts/docker-smoke.sh owncord-smoke:candidate`
   exits 0. Remember the build context is `Server/`, not the root.
5. **`dev` strict.** Edit `docs/plans/b0-dev-branch-protection.sh` line 63,
   `"strict": false,` → `"strict": true,`, run it
   (`bash docs/plans/b0-dev-branch-protection.sh`), and read back:
   `gh api repos/J3vb/OwnCord/branches/dev/protection --jq '.required_status_checks.strict'`
   → `true`. Repository-settings writes need a person; the owner approved this
   one on 2026-08-28. Record the read-back in HP-2.

Items 3–5 are one PR (`chore(b2-0): release hygiene`). Item 2 landed as
#1432. Item 1 is evidence, not a change.

**Evidence, 2026-08-28** — HP-2 questions 1 and 7 cite this block:

- Release: `gh release view v1.2.0-alpha.4 --json assets --jq '.assets|length'`
  → `20`, target `main`. The pre-epoch updater contract is that asset set:
  `chatserver.exe` + `.sig`, `chatserver-linux-amd64.tar.gz`,
  `checksums.sha256`, `owncord-src-v1.2.0-alpha.4.tar.gz`,
  `server-update-manifest.json` + `.sig`, the client AppImages (amd64 and
  aarch64, each with a `.tar.gz` and `.sig` pair), `.deb` (amd64, arm64), and
  the NSIS installer (`-setup.exe`, `.nsis.zip` + `.sig`).
- `dev` strict: script run 2026-08-28 07:58 UTC;
  `gh api repos/J3vb/OwnCord/branches/dev/protection --jq '.required_status_checks.strict'`
  → `true`, the 12 contexts unchanged.
- `environment: release`: one required reviewer (`J3vb`, self-review allowed),
  `deployment_branch_policy: null` (tag refs may deploy — the gate holds the
  run, it does not reject it), and no environment-scoped secrets, so nothing
  can shadow the repository secrets the build jobs sign with. actionlint
  v1.7.12 on `release.yml`: clean.
- ENV-03: from Git Bash with `MSYS_NO_PATHCONV` unset, the pre-change script
  exits 1 (`::error::container never reported healthy within 30s` — Git Bash
  had rewritten `/chatserver` into a Windows path); the changed script exits 0
  against `owncord-smoke:candidate` built from `Server/` with
  `--build-arg VERSION=ci`.

## B2-1 — Capture the epoch-1 fixtures

Lands **before** B2-2. Alpha.4 is the last client on the pre-epoch wire; once
B2-2 merges there is no clean way to record what "epoch 0/1" looked like.

1. **Golden wire transcripts.** A contract test in `Server/ws`
   (`protocol_epoch1_contract_test.go`, matching the existing
   `*_contract_test.go` tier) drives the required journeys through the
   in-process hub harness the package's tests already use (reuse it — do not
   write a second harness) and compares each journey's frame sequence with a
   JSON file under `protocol/fixtures/epoch-1/`. Journeys: fresh connect
   (`auth` → `auth_ok` → `ready`); resume with `last_seq` and a replay burst;
   `chat_send` and its fan-out; edit and delete; reaction add/remove; typing;
   `mark_read`; DM send; `voice_join` → `voice_state`, `voice_e2ee_announce`
   and `voice_e2ee_offer` relay, `voice_leave`; `ping`; failed auth
   (`auth_error`). Volatile fields (`id`, `seq`, timestamps, tokens, user ids)
   are normalised to stable placeholders before comparison, which is what lets
   the fixtures survive refactors. `go test ./ws -run TestEpoch1Fixtures -update`
   regenerates; the default run compares.
2. **Client side of the same contract.** `Client/tests/contract/ws-auth-frame.test.ts`
   pins the `auth` frame `Client/src/lib/ws.ts:447` sends today (`token`,
   `last_seq`, optional `active_channel_id`). B2-2 extends this test rather
   than replacing it.
3. **Updater contract.** Before B2-3 changes them, assert the current shapes:
   the manifest fields in `Server/updater/release_manifest_test.go`, and the
   `client-update` 200/204 bodies in the handler's test next to
   `Server/api/client_update.go`.
4. **Retire the reserved entries (S-15).** Remove `voice_speakers` and
   `member_leave` from `protocol/schema.json` via the `protocol-change` skill
   (`npm run generate`, then `git grep -nE 'VOICE_SPEAKERS|MEMBER_LEAVE|MsgTypeVoiceSpeakers|MsgTypeMemberLeave'`
   must return only the generated files' history, i.e. nothing at HEAD), and
   delete their rows from `docs/protocol.md`. Own commit, before the fixtures
   are captured, so epoch 1 does not carry dead entries.
5. **Document the fixtures** in `protocol/README.md`: what a fixture is, how to
   regenerate, and the rule that a fixture may only change with an epoch bump.

Verification: `npm run check:server` (regenerates and diffs both generators;
runs the new test under `go test ./...`), `npm run check:client`.

**Evidence, 2026-08-28** — HP-2 question 1 cites this block:

- Branch `feat/b2-1-epoch1-fixtures` from `dev` `fb6b51a0`; PR #1435 to `dev`,
  squash-merged 2026-08-28 as `1fe3df79`. Pre-squash head at merge time:
  `069412db` (`git ls-remote origin refs/pull/1435/head` →
  `069412dbbfb9fa11318a8a6f16af251563e78d09`); HP-2 question 1 cites it.
- Pre-squash commits: retirement `dd638f1c` (own commit, before capture);
  fixtures `54cae614` (capture), `c0719519` (end-of-journey barriers,
  present-form optionals), `d5fe06e5` (null forms of `auth_ok`/`member_join`
  user fields, `id` on `auth`, unsigned announce); client auth frame
  `0f15fafb`; updater shapes `8e065130`; docs `00a7b65c`, `f7c161a5`,
  `5b5b5c19`.
- Gates at `5b5b5c19`: `check:server`, `check:client`, `check:docs`,
  `check:hygiene` all exit 0; `TestEpoch1Fixtures` passes `-count=3`,
  `-race -count=3`, `-tags deadlock -count=10`; regeneration is
  byte-identical; both trailing-frame guards proven by negative control.
- Item 4 grep at HEAD hits only `docs/audit-2026-07-19.md` (dated record) and
  this file's own command text.
- Item 5 refined twice: the rule is **shape, not value** (a seeded default
  value change is regenerated in the same PR; normalising those values was
  rejected because it hides enum drift), and an epoch bump is for what older
  clients cannot process — additive keys stay within the epoch and are
  regenerated deliberately (Codex review on #1435; B2-2's negotiation fields
  are the first such regeneration). Open for B2-2/B2-4: whether the epoch-1
  transcript should also replay with additive tolerance as the "old client
  still works" check, and whether the captured wire is called epoch 0 (absent
  `epoch`) or epoch 1 — this plan currently says both.
- Scope addition: six `docs/protocol.md` statements the captured wire proved
  false were corrected in the same PR (relayed `voice_state` has no `seq`,
  `chat_message.user.display_name`, the six real `auth_error` messages,
  connect examples' `seq`, `voice_join` reply order, `voice_max_video` default
  25), plus the auth-failure close code 1008.
- Found, not fixed (behaviour change): the joiner's own `voice_state` is
  broadcast through the hub queue while the rest of the join burst is written
  directly (`Server/ws/voice_join.go:498` vs `:445`/`:523`/`:546`), so its
  position on the joiner's socket is not guaranteed (~1/30 under
  `-tags deadlock`). Documented; B2-8 / ledger candidate.

## B2-2 — Protocol epoch and negotiation

**Owner decision 2026-08-29: shipped slim.** The one-epoch policy below
replaces the three-wide window (N-2..N), the `server-info` endpoint, the
obligations table and the per-epoch fixture matrix that this section
specified on 2026-08-28. Reason: OwnCord is alpha with one maintainer; a
window is a standing promise that every future protocol change must keep two
older transcripts replaying, and nothing today needs it. Each dropped piece is
one constant or one handler away if it is ever wanted; the owner's earlier
"execute B2 as written" decision is knowingly walked back for this step only.

What shipped (branch `feat/b2-2-protocol-epoch` from `dev` `e6c6bf12`,
pre-squash SHAs for HP-2):

1. **One number, generated** — `2ac9b5ba`. `protocol/schema.json` gains
   `"protocol_epoch": 1`; `genprotocol` validates it (>= 1) and emits
   `const ProtocolEpoch = 1` and `export const PROTOCOL_EPOCH = 1;`.
   `TestProtocolEpochMatchesSchema` pins the Go constant to the schema.
2. **Handshake, server** — `77051648`. `auth` gains `epoch` (absent = 0).
   Rule: accept `minClientEpoch <= epoch <= ProtocolEpoch`, with
   `minClientEpoch = 0` for epoch 1 only (alpha.4 clients send no epoch).
   Otherwise `auth_error` with `code: "protocol_epoch_unsupported"`,
   `client_epoch`, `server_epoch`, `min_epoch`, a message naming which side
   to update, then the same 1008 close as every handshake failure — **no
   4426**, nothing reads close codes. `ready` is unchanged (fixtures
   untouched). `TestAuth_ProtocolEpoch` drives absent/0/N/N+1/-1 over a real
   socket; `TestEpoch1Fixtures` still passes unmodified, which is the
   "old client still works" check B2-1 left open — answered as: the epoch-1
   transcript replays verbatim, no additive tolerance needed because the
   accepted frames did not change.
3. **Handshake, client** — `41ef091d`. `ws.ts` sends `epoch: PROTOCOL_EPOCH`
   (`ws-auth-frame.test.ts` extended on purpose). On the refusal with a newer
   server, the dispatcher records the host in `ui.store.updateRequiredHost`
   and `main.ts` mounts `UpdateNotifier` on the connect page, so the refused
   client gets the same Update Now banner it would have had on the main page.
   No `client_version` field: nothing reads it.
4. **Server-first updates (was B2-3)** — `899c956f`. The signed
   server-update manifest gains `protocol_epoch`, written by `release.yml`
   from `jq .protocol_epoch protocol/schema.json`.
   `Updater.ReleaseProtocolEpoch` verifies the manifest through the existing
   minisign path and reads it; `GET /api/v1/client-update` answers 204 when
   the release's epoch is newer than `ws.ProtocolEpoch` or the manifest does
   not verify. Releases without a manifest are epoch 0 (advertised as
   before), so the existing updater-contract tests did not move. Dropped
   from the B2-3 spec: the "fall back to the newest compatible release"
   search — the endpoint only knows the latest release, and a held-back
   release simply waits for the server to upgrade.
   Docs: `docs/protocol.md` § Compatibility (protocol epoch), `docs/api.md`,
   `docs/deployment.md` § Upgrading, `protocol/README.md`, `CHANGELOG.md`
   Unreleased.

Answers to B2-1's open questions: the captured wire is **epoch 1**; "absent
`epoch`" is the number 0 and is accepted by epoch-1 servers only.

Not shipped, and why:

| Spec item                          | Status  | Reason                                                                                      |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| Window `max(0, N-2) <= epoch <= N` | dropped | One epoch by policy; `minClientEpoch` is the knob (`Server/ws/messages.go`)                 |
| Close code 4426                    | dropped | Payload `code` is what the client reads; 1008 keeps auth-failure uniform                    |
| `ready.protocol_epoch`             | dropped | Nothing consumes it; would regenerate every fixture carrying `ready`                        |
| `client_version` in `auth`         | dropped | Diagnostics only; add with the first reader                                                 |
| `GET /api/v1/server-info`          | dropped | B6/B8 add it when they need it; the refusal frame already carries `server_epoch`            |
| Obligations table (E2EE blob date) | dropped | Only meaningful with a window; the blob note in `docs/protocol.md` stands as written        |
| B2-4 compatibility matrix          | folded  | `TestAuth_ProtocolEpoch` is the accept/reject table; fixtures replay for the accepted epoch |
| B2-3 newest-compatible fallback    | dropped | See item 4                                                                                  |

## B2-3 — Server-first updates

Folded into B2-2 item 4 (`899c956f`). The `v1.2.0-beta.1` tag-line note for
`CHANGELOG.md`/`docs/contributing.md` was not written: the changelog entry is
under `## Unreleased` and takes the tag when one is cut.

## B2-4 — Compatibility matrix

Folded into B2-2 item 2. With one accepted epoch there is no matrix: the
table test covers absent/0/N/N+1/-1 on a real socket, and the epoch-1
fixtures replay for the accepted epoch under the required
`Server Build & Test` check. Exit evidence for BPR-032 and BG-07's server
half stands on those two tests.

## B2-5 — One permission predicate per security property

1. **Inventory.** `git grep -nE 'HasPerm|HasAnyPerm|HasServerPerm|EffectivePerms|EffectiveChannelPerms' Server/ -- ':!*_test.go'`
   plus every hand-rolled visibility/send check in `Server/ws` and
   `Server/service`. Table (file, line, property it decides) goes into the
   HP-2 scorecard.
2. **Canonical predicates** in `Server/permissions`: value-taking functions,
   no database access — `CanViewChannel`, `CanSendMessage`, `CanType` (defined
   as `CanSendMessage`), `CanModerateVoice`, `CanJoinVoice`, `CanAdmitSession`
   — each over a small struct of role bits, channel overrides, channel flags,
   DM/block state.
3. **Parity, then delegation.** For each predicate, a table test runs the old
   call site's logic and the new predicate over the same inputs and asserts
   equality; then the site delegates; then the old logic is deleted. One
   commit per property.
4. **Closes:** S-01 (typing delegates to `CanSendMessage`), S-12
   (ready/refresh/ws delegate to `CanViewChannel`/`CanSendMessage`), and the
   server half of SEC-02 (voice moderation delegates to
   `CanModerateVoice`, which takes the channel override) — the specifics are
   in the local report `docs/security-findings/voice-moderation-channel-overrides/`.
5. **Invariant rule candidate.** If, after migration, no file outside
   `Server/permissions` calls the bit helpers directly, add an
   `authz-chokepoint` rule to `Server/invariants` that fails on the first new
   one. If residual calls remain with a reason, record them in HP-2 and leave
   the rule to B3 (roadmap B3 item 15).

**Evidence, 2026-08-29** — branch `feat/b2-5-permission-predicates` from
`dev` `9c9b8be6`; PR #1440 to `dev`. HP-2 question 5 cites this block.

- Pre-squash SHAs, one commit per property: `00761523` (predicates +
  `Checker` delegation), `94aba833` (send — S-01), `0271cbbe` (view /
  session admission — S-12), `802101a0` (voice join), `aeee37e8` (voice
  moderation — SEC-02 server half).
- Predicates (`Server/permissions/predicates.go`), each pure over a
  `Subject` (role bits, both override layers, channel flags, DM membership
  and block state): `CanViewChannel`, `CanAdmitSession` (= view),
  `CanSendMessage`, `CanType` (= send), `CanJoinVoice`, `CanModerateVoice`;
  `Subject.Has` is the one value-taking bit predicate `Checker` and
  `PermissionService` route through. Refusals are sentinels
  (`ErrPermissionDenied` + bit name, `ErrArchived`, `ErrBlocked`,
  `ErrNotDMParticipant`, `ErrNotVoiceChannel`) so each site keeps its own
  status codes. Permission is checked before the archive flag everywhere, so
  an unauthorized caller learns nothing from the error.
- Parity tables (site vs predicate over the same fixture, both the
  cached-service and bare-hub branch, every override layer):
  `Server/service/predicate_parity_test.go` (`CanPost`, `HandleTyping`,
  `HandleChannelFocus`) and `Server/ws/predicate_parity_internal_test.go`
  (`channelCanSend`, `refreshChannelVisibilityCanSend`, `applySetChannelID`,
  `channelReadAudience`, `RefreshChannelVisibility`, `channelSubject`,
  `voiceJoinPrecheck`, `voiceStillAllowed`). Red before delegation: S-01 (19
  typing rows) and SEC-02 (`TestVoiceMod_ChannelOverridesApply`, three deny
  rows); every other site already agreed with its predicate.
- Decision recorded for SEC-02's open question ("READ_MESSAGES or
  CONNECT_VOICE?"): `CanModerateVoice` requires effective `READ_MESSAGES` +
  `MUTE_MEMBERS` in the target's channel — a moderator acts only where they
  can see. The base-bit `HasServerPerm` check stays as an early rejection
  (never admits), which keeps FORBIDDEN ahead of the voice-state lookup and
  means a channel allow cannot grant `MUTE_MEMBERS` to a base role lacking it.
- Inventory, step 1 grep plus the hand-rolled sites, before → after:

  | Site (before)                                                       | Property        | After                                         |
  | ------------------------------------------------------------------- | --------------- | --------------------------------------------- |
  | `permissions/checker.go` HasChannelPerm / Batch / VisibleChannelIDs | view (bit)      | `Subject.Has` / `CanViewChannel`              |
  | `service/message_perms.go:93-100` checkSendPermission               | send            | `CanSendMessage`                              |
  | `service/channel.go:132` HandleTyping (READ only — S-01)            | type            | `CanType`                                     |
  | `service/channel.go:256` HandleChannelFocus                         | admit           | `CanAdmitSession`                             |
  | `ws/serve_ready.go:149-157` channelCanSend                          | send            | `CanSendMessage`                              |
  | `ws/hub_broadcast.go:519-523` refreshChannelVisibilityCanSend       | send            | `CanSendMessage`                              |
  | `ws/hub_broadcast.go:265,283` channelReadAudience                   | view            | `CanViewChannel`                              |
  | `ws/hub_broadcast.go:422-439` RefreshChannelVisibility              | view            | `CanViewChannel`                              |
  | `ws/handlers.go:296` applySetChannelID (hasPermChecked)             | admit           | `CanAdmitSession`; helper deleted             |
  | `ws/voice_join.go:105-151` voiceJoinPrecheck (requireChannelAccess) | join            | `CanJoinVoice`; helper deleted                |
  | `ws/voice_join.go:594-612` handleVoiceTokenRefreshV2                | join            | `CanJoinVoice`                                |
  | `ws/voice_moderation.go:416-433` move destination                   | join            | `CanJoinVoice`                                |
  | `ws/hub_sweep.go:353` hasChannelPermChecked (EffectiveChannelPerms) | join (bit only) | `CanJoinVoice` (whole rule, error-aware)      |
  | `ws/voice_moderation.go:64` voiceModTarget (HasServerPerm — SEC-02) | moderate        | `CanModerateVoice` + base-bit early rejection |
  | `ws/deps.go` hasChannelAccess / hasChannelAccessLive                | join/admit glue | deleted (`channelSubject` + predicates)       |

- Residue after migration (direct bit-helper calls outside
  `Server/permissions`, non-test), each with its reason — so step 5's
  condition is not met and the `authz-chokepoint` rule stays with B3 item
  15, consistent with the 2026-08-18 measurement that dropped it (1 hit in
  `api/`, a false positive; 30 widened, 87% legitimate):
  - Server-scoped permissions with no channel — `HasServerPerm` in
    `api/middleware.go:200`, `admin/middleware.go:109`, `service/emoji.go:95`,
    `service/moderation.go:51`, `service/role.go:82`, and `HasAnyPerm`
    (`AdminPerimeter`) in `admin/middleware.go:84`. These ARE the canonical
    server-wide predicate; there is no channel to resolve a `Subject` for.
  - `HasAdmin` as a fetch short-circuit (skip the override query for admins)
    in `service/channel.go:59`, `service/message_perms.go:25`,
    `service/permission.go:224`, `ws/serve.go:780`, `ws/serve_ready.go:169`,
    `ws/voice_join.go:355`; as an authorization input in
    `admin/handlers_channel_perms.go:95,325`, `admin/logstream.go:452`,
    `api/upload_handler.go:404`, `service/role.go:104` (role hierarchy — the
    measurement's "no `Outranks`" class).
  - `& permissions.AllPerms` masks on admin input (`admin/handlers_channel_perms.go:131-358`,
    `service/role.go:210,307`) — sanitisation, not a decision.
  - `service/mentions.go:262-266,302-304` — the bulk @everyone reader walk
    resolves the role layer per role and the user layer as a set difference;
    the owner declined the mechanical `HasPerm` conversion on 2026-08-18
    (memory `owncord-invariant-rule-measurement-2026-08-18`).
  - `ws/voice_moderation.go:65` — the base-bit early rejection described
    above.
- Behaviour deltas beyond the three findings, all narrowing: the stale-voice
  sweep re-runs the whole join rule (deleted/archived channel, lost DM
  membership, new block evict too); the token refresh refuses a deleted
  channel; the bare-hub `RefreshChannelVisibility` branch fails closed on a
  lookup error like the service branch always did. Two fixtures needed
  completing, assertions untouched: the deafen-race `VoiceDeps` gain a
  `Checker`, and `TestHandleVoiceTokenRefresh_NilUser` seeds the channel it
  refreshes.
- Gates at `aeee37e8`, from `Server/`: four build-tag variants, `go vet`,
  `go test -race ./...`, `go test -tags deadlock ./ws/`, `golangci-lint run`
  — all exit 0, run before each of the five commits.
- Codex review on #1440 (P2): `CanJoinVoice`'s DM branch returned before the
  archive flag, while the old `voiceJoinPrecheck` refused every archived
  channel and the admin PATCH accepts `archived` for a DM. Fixed in
  `fdd2a3ff` (archive checked after membership and block for both kinds,
  pinned in the predicate table), same gate green; thread resolved.

## B2-6 — Safe audit coverage

1. Enumerate the security-sensitive mutations: credential and TOTP changes,
   role assignment, invite create/revoke, ban/kick/timeout, channel permission
   edits, TLS/config changes, API-token create/revoke, plugin install,
   account/message deletion. Cross with `git grep -n 'Audit(' Server/ -- ':!*_test.go'`.
2. A table test in the package that owns the handlers calls each mutation with
   a fake `db.AuditStore` and asserts an entry with the expected `action`
   arrives. Invite create/revoke fail first (S-02); add their `Audit` calls.
3. A second table asserts `detail` never carries a token, password, recovery
   secret, or message body — a denylist over the recorded corpus. Fix any hit
   at the call site, never by loosening the list.

**Evidence, 2026-08-29** — branch `feat/b2-6-audit-coverage` from `dev`
`67fdd18d`; PR #1441 to `dev`. HP-2 cites this block.

- Step 1 — the mutation inventory, crossed with the 43 non-test `Audit(` call
  sites at `67fdd18d` (`WriteAudit`, `LogAudit`, `EnqueueAudit`). "Before" is
  whether the mutation wrote an audit row at that SHA; "table" names the B2-6
  test that now asserts it (`TestAuditCoverage_*` in `service`, `api` and
  `admin`, each over a fake `db.AuditStore` from `Server/db/audittest`).

  | Mutation                  | Handler                                                        | Action                                                   | Before | Table                                                          |
  | ------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- | ------ | -------------------------------------------------------------- |
  | Password change           | `service/user.go` `ChangePassword`                             | `password_change`                                        | yes    | service                                                        |
  | Session revoke            | `service/user.go` `RevokeSession`                              | `session_revoke`                                         | yes    | service                                                        |
  | TOTP enrol                | `api/totp_handler.go` confirm                                  | `totp_enabled`                                           | yes    | api                                                            |
  | TOTP disable              | `api/totp_handler.go` disable                                  | `totp_disabled`                                          | yes    | api                                                            |
  | Role assignment           | `service/moderation.go` `ChangeUserRole`                       | `role_change`                                            | yes    | service                                                        |
  | Invite create             | `service/invite.go` `CreateInvite`                             | `invite_create`                                          | **no** | service — added (S-02)                                         |
  | Invite revoke             | `service/invite.go` `RevokeInvite`                             | `invite_revoke`                                          | **no** | service — added (S-02); actor threaded from the handler        |
  | Ban / unban               | `service/moderation.go` `BanUser` / `UnbanUser`                | `user_ban` / `user_unban`                                | yes    | service                                                        |
  | Kick (sessions)           | `service/moderation.go` `ForceLogout`                          | `force_logout`                                           | yes    | service                                                        |
  | Kick (voice)              | `ws/voice_moderation.go` `handleVoiceModKick`                  | `voice_mod_kick`                                         | yes    | existing `TestVoiceMod_Kick_RemovesFromVoiceAndNotifiesTarget` |
  | Timeout                   | — no timeout mutation exists on the server                     | —                                                        | n/a    | —                                                              |
  | Channel role overrides    | `admin/handlers_channel_perms.go` put / delete                 | `channel_perms_update` / `channel_perms_clear`           | yes    | admin                                                          |
  | Channel user overrides    | `admin/handlers_channel_perms.go` put / delete (user layer)    | `channel_user_perms_update` / `channel_user_perms_clear` | yes    | admin                                                          |
  | TLS / config change       | `admin/setup_handler.go` `setupApplyWizard`                    | `config_write` (with `server_setup`)                     | yes    | admin                                                          |
  | Settings change           | `admin/handlers_settings.go` `handlePatchSettings`             | `setting_change`                                         | yes    | admin                                                          |
  | API token create / revoke | `admin/handlers_tokens.go` (`token_cli.go` shares the actions) | `api_token_create` / `api_token_revoke`                  | yes    | admin                                                          |
  | Plugin install            | `api/plugins_handler.go` `install`                             | `plugin_install`                                         | **no** | api — added                                                    |
  | Plugin uninstall          | `api/plugins_handler.go` `uninstall`                           | `plugin_uninstall`                                       | **no** | api — added                                                    |
  | Account deletion          | `api/auth_handler.go` delete account                           | `account_deleted`                                        | yes    | api                                                            |
  | Message deletion          | `service/message_crud.go` `DeleteMessage`                      | `message_delete`                                         | yes    | service                                                        |
  | Message purge             | `service/message_purge.go` `PurgeMessages`                     | `message_purge`                                          | yes    | service                                                        |

  Call sites outside the security-sensitive list (channel CRUD, emoji,
  profile, identity key, backups, login/logout/register, `ws_connect`, the
  other three voice moderation actions) keep their existing rows and are not
  in the table; the denylist in step 3 does not run over them.

- Pre-squash SHAs, one commit per step: `ea914e66` (step 1, the table
  above), `a06499f2` (step 2, tables + the four audit calls), `6193a709`
  (step 3, denylist + its self-test). `474ec74c` and `cbbf41c1` are the
  register/CHANGELOG/security.md edits, committed from outside the session
  while the step-2 gate ran; content unchanged, kept as-is.
- Step 2 — fixture: `Server/db/audittest` installs a `db.AuditWriter` over a
  recording `AuditStore` via `SetAuditWriter`, so every `WriteAudit` through
  the test's `*db.DB` lands in memory regardless of package. Tables:
  `TestAuditCoverage_ServiceMutations` (10 rows), `TestAuditCoverage_APIMutations`
  (3), `TestAuditCoverage_PluginLifecycle` (2, package-internal fixtures),
  `TestAuditCoverage_AdminMutations` (8). Red at `ea914e66` + tests on exactly
  the four rows the table predicts — `invite_create`, `invite_revoke`,
  `plugin_install`, `plugin_uninstall` (each `no "<action>" audit entry
recorded; recorded actions: []`); every other row green before any
  production change. Green after the four calls. `RevokeInvite` gained the
  actor parameter (threaded from `handleRevokeInvite`); the plugin handler
  gained a `db.Auditor` and `admin.ActorIDFromContext` was exported so its
  rows name the `RequireAdminAuth` principal. S-02's failure half:
  `TestAuditCoverage_InviteRevokeFailureEmitsNothing`.
- Step 3 — `audittest.AssertSafeDetails` runs over the union corpus each
  table recorded: shape denylist (bcrypt/argon2 hashes, `password=` /
  `token=` / `secret=` / recovery-code key-value leaks, `otpauth://`,
  `Bearer `) plus every fixture secret the rows return (raw session and API
  tokens and their hashes, passwords, TOTP secrets and codes, invite codes,
  message bodies, the setup password). `TestAssertSafeDetails_Bites` proves
  each class rejects and ordinary details pass. Zero hits on the corpus at
  `6193a709`; no call site changed.
- Gates from `Server/` before each commit: four build-tag variants, `go vet`,
  `go test -race ./...`, `go test -tags deadlock ./ws/`, `golangci-lint run`
  (one `contextcheck` round: hoisted `ctx` in the tables, inlined),
  `sqlc generate` and `genprotocol` drift — all exit 0. Docs commits:
  `npm run check:docs`, `npm run check:hygiene`.
- Closes S-02 (register: resolved/superseded). Ledger untouched.
- Codex review on #1441, two P2s, both fixed test-first in `aadd911b`, same
  gate green: `CreateInvite` read the invite back on the request context, so
  a cancel after the committed insert failed the call and skipped
  `invite_create` — read-back and audit now run on `context.WithoutCancel`
  (`TestCreateInvite_AuditSurvivesCanceledLookup`); and
  `Registry.UninstallPlugin` is idempotent on an unknown id, so the handler
  audited uninstalls that never happened — it now checks the row first and
  answers 404 with no audit (`TestPluginsHandlerUninstallUnknownID`).

## B2-7 — Trust model, absence proofs, plugin boundary (documents)

Runs in parallel with B2-1 and B2-6.

1. **`docs/trust-model.md`** (new; BPR-050/051). Sections: what the server can
   read and why (text, files, metadata — delivery, search, moderation, backup);
   what is end-to-end encrypted (voice, video, screen share; the key-holder
   model and identity TOFU from `docs/architecture/voice-e2ee.md`; the server
   relays what it cannot read); transport (TLS modes; desktop certificate
   pinning; browser: publicly trusted or local-CA, no pinning); the desktop
   preview destination policy (C-09) — what the native boundary must own:
   resolution, redirects, destinations, time and body limits — stated as a
   contract so B7 implements it rather than rediscovers it; at rest (SQLite
   is not encrypted; secrets are hashed; desktop secrets in the OS keychain);
   what the operator can and cannot do; multi-device sessions; what beta does
   not claim. Linked from `docs/security.md`, `docs/deployment.md`,
   `docs/quick-start.md`, `docs/README.md`. Exit evidence for BPR-051 is one
   non-developer reading it and answering "who can read my messages?"
   correctly — record who and when in HP-2.
2. **Absence proofs** (BPR-040/082/083). A contract test beside
   `Server/api/client_update.go` walks the mounted router and fails if any
   route matches `federat|directory|discover|listing`; a table in
   `trust-model.md` lists every outbound host the server contacts and why
   (GitHub for updates, LiveKit download, the existing preview/GIF/YouTube
   providers on user action) so B6's network capture has a checklist. Same
   username on two servers = two unrelated identities is already true; state it.
3. **Plugin boundary** (BPR-080/081, BG-17). New
   `docs/architecture/plugins.md`, linked from `docs/architecture/server.md`
   and `docs/README.md`: WASM is experimental and disabled by default; no
   beta API promise; the post-beta candidate list (GIF/embed providers, slash
   commands and automation, webhooks, optional moderation automation with
   human authority retained, UI tabs, import/export bridges, observability
   exporters); the core list that never moves (authentication, authorization,
   TLS, safe fetch, quotas, E2EE, updates, deletion, recovery, moderation
   audit). Release-notes wording for beta goes in the same file.
4. **L-08.** B1-6 (#1418) already untracked the prebuilt example WASM,
   ignores it in `.gitignore`, and documented the TinyGo build in
   `Server/plugin/examples/hello/README.md` (pinned TinyGo 0.40.1; rejects
   Go 1.26). What remains is the register's "deterministic source build
   passes" gate, which B1-6 found blocked on a second Go SDK. B2-7 decides
   one of two: a compile-and-compare job using a second Go SDK, or
   re-tagging the gate to B10 with the reason recorded in HP-2. Doing
   neither is not an option.

## B2-8 — The B2-tagged findings

Lands **before** B2-2; they touch the same replay/resume files.

| Finding | Area                | Public summary                                                                          |
| ------- | ------------------- | --------------------------------------------------------------------------------------- |
| OC-0311 | Client voice/E2EE   | A leave from another readable voice channel can mutate the active call's peer-key state |
| OC-0315 | Client replay       | Replay-gate timestamps mix naive-UTC server values with local wall-clock parsing        |
| OC-0316 | Server/client E2EE  | Resume restores peer public keys but not a room key rotated during the outage           |
| OC-0317 | Client DM state     | Replay can regress a DM's `lastMessageId`                                               |
| OC-0318 | Server plugins      | Install-time and restart-time manifest precedence differ between JSON and TOML          |
| OC-0322 | Client connection   | TypeScript host validation accepts a hostname form the native proxy rejects             |
| OC-0328 | Client unread state | Channel badges lack the message-id replay guard DMs already have                        |
| OC-0337 | Server replay       | Cold-tier voice replay truncation can discard the newest events                         |
| OC-0338 | Server plugins      | TOML manifests can omit configured memory and CPU limits                                |

Run `bughunt-fix` on exactly these nine (test-first, per-file agents, one
`ci-check` gate, one PR). A finding that turns out to need B7 (client
platform seam) is re-tagged in the issue register with the reason, per the roadmap's
phase execution pattern, not silently skipped.

**Evidence, 2026-08-28** — branch `fix/b2-8-findings-2026-08-28` from `dev`
`1fe3df79`; PR #1436 to `dev`.

- Re-verified against HEAD first, one read-only agent per finding, before any
  fix: all nine still open; none needs B7 — the `B2/B7` tags in the issue
  register are scheduling hints, not a platform-seam dependency, so nothing
  was re-tagged. Two coordinates had drifted after #1435
  (`dispatcher.ts` 1077→1069 and 688→687); the rest were exact.
- Two `bughunt-fix` waves so the same-run overlap guard never fired: wave 1
  (OC-0311/0315, 0316, 0317, 0318, 0322, 0337, 0338 — seven file clusters),
  wave 2 (OC-0328, whose fix also edits the `dispatcher.ts` call site that
  wave 1's first cluster owned). 9/9 fixed test-first in 8 commits
  (`a231108f`, `cd4cc850`, `7c159c11`, `bbbaeed4`, `e95c57a4`,
  `7aeab0ed`, `073e8799`, `3e74c968`), each revert-proven by its prove
  agent and then independently by `verify-fixes.mjs`: 8/8 PASS, red then green (4 client, 4 server), plus a hand RED/GREEN of the wazero-tagged OC-0318 parity test that the untagged run cannot exercise.
- Test-design facts worth keeping: OC-0315's RED needs a pinned non-UTC zone
  (Asia/Tokyo via the `renderers.test.ts` probe pattern) because
  `Date.parse` and `parseTimestamp` agree under CI's UTC; OC-0338's pinning
  test decodes with `BurntSushi/toml` directly from an untagged file because
  `tryLoadPluginTOML` is `//go:build wazero`; OC-0318's default-build RED is
  the both-manifests rejection, and its install/scan precedence parity is a
  wazero-tagged test (CI runs `go test -tags wazero ./plugin/...`).
- Also in this PR: the B2-1 evidence block above records pre-squash head
  `069412db`, and ledger OC-0349 (open, low) records the `voice_join`
  ordering hazard B2-1 found (`Server/ws/voice_join.go:498` vs
  `:445/:523/:546`) — a behaviour change left for a later fix batch.
- Gates at `3e74c968`: `check:server` plus `go vet -tags wazero ./...` and
  `go test -tags wazero -count=1 ./plugin/...`, `check:client` plus
  `npx knip` (blocking in CI since 2026-08-04 but not part of
  `check:client`), `check:docs`, `check:hygiene` — all exit 0.
- Codex review on #1436 (P2): OC-0337’s cap guard treated a complete window of
  exactly `coldCap` rows as truncated and skipped the reconciliation; fixed
  test-first in the follow-up commit by fetching `coldCap+1` rows and discarding
  only when the extra row exists. The sibling `reconnectSelectReplay` keeps its
  `>=` form deliberately — there the over-approximation only costs a full
  `ready`, never data.
- Found, not fixed (workflow tooling, not B2): the `bughunt-fix` gate list
  still runs `npm run format:check` from `Client/` (removed in B1-3; the
  formatting gate is root-scoped) and omits `knip`, so every run ends with a
  phantom `gate: FAIL` — every real command passed. Recorded in the skill
  observation log for the workflow script.

## B2-9 — Security owners and acceptance tests

The seven local reports in `docs/security-findings/` (gitignored, never
committed; the directory-to-row mapping lives in its local README) and
where each goes:

| Public row | Owner phase                     | Acceptance test lives                                                                    | Lands with                            |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| S-01       | **B2**                          | landed with B2-5 (`Server/service/predicate_parity_test.go`)                             | B2-5 (PR #1440) — done                |
| SEC-02     | **B2** (server half)            | landed with B2-5 (`Server/ws/voice_moderation_overrides_test.go`)                        | B2-5 (PR #1440) — done; UI half in B5 |
| C-09       | **B2** (contract) / B7 (client) | beside the report                                                                        | contract in B2-7 docs; code in B7     |
| SEC-03     | B2 if small, else **B5**        | beside the report                                                                        | B2-9 or B5 item 11                    |
| SEC-01     | **B4**                          | private GitHub advisory (owner creates it)                                               | B4                                    |
| SEC-04     | **B3/B6**                       | private GitHub advisory (owner creates it)                                               | B6                                    |
| OC-0324    | **B4**                          | beside the report; no advisory — the tracked ledger already carries this finding in full | B4                                    |

An acceptance test demonstrates the defect, so it is exploit detail: it stays
local until its fix lands, then lands publicly in the same PR. The two
advisories (SEC-01, SEC-04) are created by the owner in the GitHub UI (Security → Advisories →
New draft), not by CLI with the report text; their IDs are recorded in
`docs/security-findings/README.md`, which is local. Public commits, issues and
PR bodies never name the mechanism (`docs/security.md`).

## HP-2 — Protocol and threat-model sign-off

`docs/plans/hp-2-scorecard-<date>.md`, in the HP-1 shape. Questions it must
answer with commands, not assertions:

1. Is the epoch wire frozen? Schema, generated constants, `auth`/`ready`/
   `auth_error` shapes, close code — with the pre-squash SHAs of B2-1's
   fixture commit and B2-2's negotiation commits.
2. Does downgrade behave? The B2-4 matrix output for every epoch case.
3. Are the trust claims true? `trust-model.md` reviewed by the owner and one
   non-developer; every claim traced to a test or a code line.
4. Are the E2EE membership and key-change rules stated and tested? A table of
   rules with the test that pins each (identity TOFU, re-pin TOCTOU, rekey on
   leave, rotation during outage from OC-0316) — existing tests inventoried,
   missing adversarial cases added.
5. Is there one predicate per property? The B2-5 inventory before and after:
   direct bit-helper calls outside `Server/permissions` → 0 or a listed
   residue with reasons.
6. Are the deferred systems bounded? The absence test, the plugin document,
   and the configuration audit (WASM off in fresh, upgraded, Docker and
   standalone configurations).
7. Is `dev` strict? The API read-back from B2-0.

The owner signs. Acceptance authorises B3 and claims nothing about beta
readiness.

## Exit gate

The roadmap's seven conditions, plus two:

| #   | Condition                                                                                                                             | Evidence                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Clients from epochs N, N-1, N-2 pass the matrix; N-3 fails safely and actionably; the bundled browser client matches the server epoch | B2-4 output (browser client: n/a until B8) |
| 2   | Protocol and update-metadata changes are generated, documented, and downgrade-tested                                                  | B2-2, B2-3, drift gate                     |
| 3   | Effective-permission and resource-existence sibling cases have parity tests                                                           | B2-5                                       |
| 4   | Voice/video/screen E2EE membership and key-change behaviour pass adversarial tests                                                    | HP-2 question 4                            |
| 5   | No central identity, directory, federation path, or required external service exists                                                  | B2-7 absence test + host table             |
| 6   | WASM disabled by default; release artifacts do not imply API stability                                                                | B2-7 plugin document + config audit        |
| 7   | No unresolved B2 security advisory remains                                                                                            | B2-9 table, B2-owned rows closed           |
| 8   | _(added)_ Epoch-1 fixtures were captured before the first protocol change, in a separate commit                                       | B2-1 SHA precedes B2-2's                   |
| 9   | _(added)_ Pre-squash SHAs recorded for the fixture and negotiation commits                                                            | HP-2 question 1                            |

## Explicitly out of scope for B2

- The BPR-033 update experience (B7). B2 ships the frame and the "no reconnect
  loop" property only.
- External-fetch policy beyond SEC-03's bounded reads (B5).
- Any database, service or domain extraction (B3).
- The client platform seam (`Client/src/platform/`, B7).
- Re-tagging or fixing findings not tagged B2, other than as B2-8 records.

## Traps carried forward

- **Docker:** build context is `Server/`; compare `docker images --format '{{.Size}}'`
  (50.1 MB), not `docker image inspect` (12.5 MB). `docker-smoke.sh` exports
  `MSYS_NO_PATHCONV=1` itself since B2-0; ad-hoc `docker exec … /path` calls
  from Git Bash still need it set.
- **Squash merges hide structure.** Record `refs/pull/<n>/head` SHAs at merge
  time for every B2 PR a hold point will review.
- **`check:docs` counts.** `docs/plans/README.md` is watched; never write two
  `<n> <status>` pairs on one line there unless they match the ledger.
- **`strict: true` after B2-0:** every open PR needs "Update branch" after
  another merges. Keep one PR in flight per hot file.
- **Schema edits go through the `protocol-change` skill**; `make` is not on
  PATH on Windows, so use `npm run generate` and `npm run check:server`.
- **Never pass `-c user.email` to git.** The identity is configured.
