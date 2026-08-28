# B2 — Freeze server protocol, trust, and compatibility contracts

**Drafted:** 2026-08-28  
**Base commit:** `64d2e108` (`dev`, post-PR #1425); `main` @ `b7d388a3` =
`v1.2.0-alpha.4` — claims verified at `64d2e108`; the branch was rebased
onto `dd7ed091` (#1432) before merge  
**Status:** in progress — entry gate 1 of 3 met at draft time (see below); B2-0,
B2-1 and B2-8 landed 2026-08-28 (evidence in their sections); B2-2 is next.
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
| **B2-2** | Protocol epoch and negotiation                                                                                    | 1 day    | serialized, after B2-8 |
| **B2-3** | Server-first updates through the signed manifest                                                                  | ½ day    | after B2-2             |
| **B2-4** | Compatibility matrix                                                                                              | ½ day    | after B2-2             |
| **B2-5** | One permission predicate per security property                                                                    | 1–2 days | serialized             |
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

Design fixed 2026-08-28; the numbers and names below are the contract.

1. **One number, generated.** `protocol/schema.json` gains
   `"protocol_epoch": 1` beside `"version": 1` (schema format stays 1).
   `Server/cmd/genprotocol/main.go` reads it (`ProtocolEpoch int` on the schema
   struct at lines 34–37) and emits `const ProtocolEpoch = 1` into
   `Server/ws/message_types.go` and `export const PROTOCOL_EPOCH = 1` into
   `Client/src/lib/protocolTypes.ts`. Follow the `protocol-change` skill; the
   drift gate covers both outputs. Own commit.
2. **Handshake, server.** In `Server/ws/serve_auth.go` the auth payload gains
   `` Epoch int `json:"epoch"` `` and `` ClientVersion string `json:"client_version"` ``.
   Rule, with N = `ProtocolEpoch`: absent → 0; accept when
   `max(0, N-2) ≤ epoch ≤ N`; otherwise `buildAuthError`
   (`Server/ws/messages.go:368`) with `code: "protocol_epoch_unsupported"`,
   `server_epoch`, `min_epoch`, `update_url` (the server's own
   `/api/v1/client-update` origin), then close with code **4426**. A client
   newer than the server gets the same frame. `ready`
   (`Server/ws/serve_ready.go:361`) gains `protocol_epoch`. Table test over
   epoch ∈ {absent, N-3, N-2, N-1, N, N+1} in `Server/ws`.
3. **Handshake, client.** `Client/src/lib/ws.ts:447` sends `epoch:
PROTOCOL_EPOCH` and `client_version` (from the app metadata the settings
   Logs tab already reads). `AuthPayload`/`AuthErrorPayload` in
   `Client/src/lib/types.ts` gain the fields. On
   `code === "protocol_epoch_unsupported"` the dispatcher
   (`Client/src/lib/dispatcher.ts:293`) shows one plain line naming
   `server_epoch` and whether the client or the server is the older one; the
   existing non-recoverable path (`ws.ts:306`) already stops reconnecting —
   add the unit test that proves no reconnect timer is armed after the frame.
   Extend `Client/tests/contract/ws-auth-frame.test.ts` from B2-1.
4. **`GET /api/v1/server-info`.** New unauthenticated handler beside
   `Server/api/client_update.go`, returning
   `{ "version", "protocol_epoch", "min_client_epoch" }`, rate-limited the way
   `client-update` is (`Server/api/constants.go:67`). Handler test; row in
   `docs/api.md`. B6 adds the browser-hosting flag here; B8 reads it.
5. **`docs/protocol.md` § Compatibility** (new section) and a pointer in
   `protocol/README.md`: within an epoch changes are additive (new optional
   fields; new message types the other side may ignore — unknown server→client
   types are ignored, unknown client→server types get an `error` frame; both
   pinned by tests); a breaking change is a new epoch; the epoch-1 fixtures
   replay against the server for as long as epoch 1 is in the window, and a
   failing fixture means "bump the epoch", not "fix the fixture". An
   **obligations table** with dates, first row: the headerless E2EE key-offer
   blob (`docs/protocol.md` ~line 1235 today says "scheduled for removal in the
   next release") stays parseable until epoch 0 leaves the window, i.e. until
   N = 3. It is client↔client through a relay, so the server's epoch cannot
   police it; a written date does.
6. **Scope of "negotiation".** Epoch only. No capability flags at beta; a
   client either speaks the epoch or it does not. The roadmap's "protocol
   changelog" is the obligations table above plus the `CHANGELOG.md` entry
   that ships the epoch.

Four commits (schema+generator; server; client; server-info+docs). Record the
pre-squash SHAs in HP-2 — the fixture commit from B2-1 and the negotiation
commits must be reviewable apart.

## B2-3 — Server-first updates

1. `releaseManifest` (`Server/updater/verify.go:29`) gains
   `` ProtocolEpoch int `json:"protocol_epoch,omitempty"` `` and
   `` ClientVersion string `json:"client_version,omitempty"` ``. A missing field
   is epoch 0.
2. `.github/workflows/release.yml`, step "Generate server update manifest"
   (~line 568): write both fields, reading the epoch from
   `jq .protocol_epoch protocol/schema.json` so the workflow cannot drift from
   the generated constant.
3. `Server/api/client_update.go`: before advertising a release, fetch and
   verify its manifest through the updater's existing signature path and
   require `manifest.ProtocolEpoch <= ws.ProtocolEpoch`; otherwise fall back
   to the newest compatible release; otherwise 204. Tests: newer-epoch
   candidate skipped → older compatible advertised → none → 204; unsigned or
   tampered manifest → candidate ignored.
4. Docs: `docs/api.md` client-update section (the filter and the manifest
   fields); one paragraph "the server upgrades first" in `docs/deployment.md`;
   and the next tag line, `v1.2.0-beta.1`, recorded as the heading
   `CHANGELOG.md`'s next entry will use and in one sentence in
   `docs/contributing.md` (no release-procedure document exists today; do
   not create one for this).

## B2-4 — Compatibility matrix

Extend `Server/ws/protocol_epoch1_contract_test.go` from B2-1 into the matrix:
for each client epoch in {absent, N-3, N-2, N-1, N, N+1} connect and, for
accepted epochs, replay every epoch-1 fixture; for rejected ones, assert the
`protocol_epoch_unsupported` frame and close code 4426. It runs under
`go test ./...`, inside the required `Server Build & Test` check — **no new CI
job and no pin-script change.** Exit evidence for BPR-032 and BG-07's server
half.

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
- Found, not fixed (workflow tooling, not B2): the `bughunt-fix` gate list
  still runs `npm run format:check` from `Client/` (removed in B1-3; the
  formatting gate is root-scoped) and omits `knip`, so every run ends with a
  phantom `gate: FAIL` — every real command passed. Recorded in the skill
  observation log for the workflow script.

## B2-9 — Security owners and acceptance tests

The seven local reports in `docs/security-findings/` (gitignored, never
committed; the directory-to-row mapping lives in its local README) and
where each goes:

| Public row | Owner phase                     | Acceptance test lives                                                                    | Lands with                        |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| S-01       | **B2**                          | beside the report until B2-5 merges                                                      | B2-5                              |
| SEC-02     | **B2** (server half)            | beside the report until B2-5 merges                                                      | B2-5; UI half in B5               |
| C-09       | **B2** (contract) / B7 (client) | beside the report                                                                        | contract in B2-7 docs; code in B7 |
| SEC-03     | B2 if small, else **B5**        | beside the report                                                                        | B2-9 or B5 item 11                |
| SEC-01     | **B4**                          | private GitHub advisory (owner creates it)                                               | B4                                |
| SEC-04     | **B3/B6**                       | private GitHub advisory (owner creates it)                                               | B6                                |
| OC-0324    | **B4**                          | beside the report; no advisory — the tracked ledger already carries this finding in full | B4                                |

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
