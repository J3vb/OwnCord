# HP-2 — Protocol and threat-model sign-off scorecard

**Hold point:** HP-2, defined in
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md)
**Commits reviewed:** the pre-squash commits of #1435, #1438, #1440, #1443 and
the B2-9/HP-2 branch (table below)
**Measured at:** `83a535c3`, the `feat/b2-9-hp2` branch off `dev` `88c7a824`
**Measured:** 2026-08-29
**Evidence base:**
[b2-protocol-trust-compat-2026-08-28.md](b2-protocol-trust-compat-2026-08-28.md)
(every B2-_n_ evidence block), [hp-1-scorecard-2026-08-27.md](hp-1-scorecard-2026-08-27.md)
(open items carried in)

**Decision: ACCEPTED — 2026-08-29 by J3vb (repository owner).**

All nine exit conditions are evidenced below. Condition 1 is accepted **at
the slim one-epoch scope** the owner chose for B2-2; condition 4 is accepted
**with the first-contact membership gap recorded and disclaimed**, not fixed
— it stays under "What beta does not claim" (Question 4's recommendation,
taken). The BPR-051 non-developer read (Question 3) and the SEC-01/SEC-04
advisory IDs (B2-9 block) remain owner follow-ups and do not gate B3.
**B2 is complete and B3 may begin.**

HP-2 asks seven questions. Each is answered below with the command that
produces the evidence and what it printed on the measured tree, not with an
assertion. Then the B2 exit gate's nine conditions are walked. It follows the
shape of [hp-1-scorecard-2026-08-27.md](hp-1-scorecard-2026-08-27.md).

Acceptance authorises B3 to begin. It claims nothing about beta readiness.

## The commits under review are not on `dev`

`dev` is squash-merge only. The commit structure HP-2 reviews — fixtures
captured _before_ the first protocol change, one commit per permission
property, one commit per trust-model item — survives only on the pull-request
refs:

```bash
git fetch origin 'refs/pull/1435/head:pr-1435' 'refs/pull/1438/head:pr-1438' \
                 'refs/pull/1440/head:pr-1440' 'refs/pull/1443/head:pr-1443'
```

| PR                            | On `dev`   | Pre-squash commits                                                                                                                                     |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1435 — B2-1 epoch-1 fixtures | `1fe3df79` | `dd638f1c` retirement, `54cae614` capture, `c0719519` barriers, `d5fe06e5` null forms; head `069412db`                                                 |
| #1438 — B2-2 negotiation      | `9c9b8be6` | `2ac9b5ba` schema + constants, `77051648` server handshake, `41ef091d` client handshake, `899c956f` server-first updates                               |
| #1440 — B2-5 predicates       | `67fdd18d` | `00761523` predicates, `94aba833` send, `0271cbbe` view, `802101a0` voice join, `aeee37e8` voice moderation, `fdd2a3ff` Codex fix                      |
| #1443 — B2-7 trust model      | `88c7a824` | `a4cd077b` trust model, `083d87d9` absence proofs, `cbfcf702` plugin boundary, `56f23a36` L-08 decision; 11 Codex rounds after, all documentation-only |
| this PR — B2-9 + HP-2         | —          | `355b1fc1` records #1443's SHA, `be8454d0` SEC-03 verdict, `a51e2e89` Q4 tests, `83a535c3` table closure, and the commit carrying this file            |

Every SHA above resolves on the fetched refs (`git log -1 <sha>` for each of
the nineteen, 2026-08-29; dates in Question 1).

## Question 1 — is the epoch wire frozen?

| Element                  | Where                                                                                       | Value on the measured tree                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The number               | `protocol/schema.json:4`                                                                    | `"protocol_epoch": 1`                                                                                         |
| Go constant (generated)  | `Server/ws/message_types.go:11`                                                             | `const ProtocolEpoch = 1`                                                                                     |
| TS constant (generated)  | `Client/src/lib/protocolTypes.ts:12`                                                        | `export const PROTOCOL_EPOCH = 1;`                                                                            |
| Constant ↔ schema pin    | `Server/ws/protocol_contract_test.go:234`                                                   | `TestProtocolEpochMatchesSchema` — PASS                                                                       |
| `auth` shape             | client sends `epoch: PROTOCOL_EPOCH` (`Client/src/lib/ws.ts:452`); absent = 0               | server accepts `[minClientEpoch, ProtocolEpoch]` = `[0, 1]` (`Server/ws/serve_auth.go:62`, `messages.go:385`) |
| `auth_error` shape       | `Server/ws/messages.go:389-408`                                                             | `code: "protocol_epoch_unsupported"`, `client_epoch`, `server_epoch`, `min_epoch`, message naming which side  |
| Client reads the refusal | `Client/src/lib/dispatcher.ts:295-298`                                                      | `server_epoch > PROTOCOL_EPOCH` → `updateRequiredHost` → Update Now banner on the connect page                |
| `ready` shape            | unchanged by B2-2                                                                           | the epoch-1 fixtures replay verbatim (Question 2)                                                             |
| Close code               | 1008, the same as every handshake failure                                                   | no 4426 — nothing reads close codes (B2-2 evidence block, "not shipped")                                      |
| Update metadata          | signed manifest `protocol_epoch`; `GET /api/v1/client-update` answers 204 for a newer epoch | `Server/updater/release_epoch_test.go:27` `TestReleaseProtocolEpoch` — 4/4 PASS                               |

```bash
grep -n protocol_epoch protocol/schema.json            # 4:  "protocol_epoch": 1,
grep -n ProtocolEpoch Server/ws/message_types.go       # 11:const ProtocolEpoch = 1
grep -n PROTOCOL_EPOCH Client/src/lib/protocolTypes.ts # 12:export const PROTOCOL_EPOCH = 1;
git grep -nE 'minClientEpoch|protocol_epoch_unsupported' -- 'Server/ws/*.go' ':!*_test.go'
```

**Ordering — fixtures before the first protocol change (exit condition 8):**

```bash
for s in 54cae614 c0719519 d5fe06e5 069412db 2ac9b5ba 77051648; do git log -1 --format='%h %ci %s' $s; done
```

```
54cae614 2026-08-28 12:37:34 +0200 test(ws): capture the epoch-1 wire fixtures
c0719519 2026-08-28 13:19:23 +0200 test(ws): harden the epoch-1 fixtures against trailing frames and absent op
d5fe06e5 2026-08-28 14:25:11 +0200 test(ws): freeze the null forms of auth_ok and member_join user fields
069412db 2026-08-28 15:31:43 +0200 test(client): compare auth-frame key sets order-independently
2ac9b5ba 2026-08-29 06:32:50 +0200 feat(b2-2): declare protocol_epoch in the schema and generate both constants
77051648 2026-08-29 06:35:14 +0200 feat(b2-2): check the client's protocol epoch in the auth handshake
```

#1435 merged 2026-08-28 13:43 UTC as `1fe3df79`; #1438 merged 2026-08-29
05:23 UTC as `9c9b8be6`. The capture precedes the first negotiation commit by
eighteen hours and one merge, in its own PR.

**Verdict: PASS.** One number, generated into both consumers, pinned to the
schema by a test; every handshake shape anchored; fixtures captured first and
their pre-squash SHAs recorded (exit condition 9).

## Question 2 — does downgrade behave?

By the owner's 2026-08-29 decision B2-2 shipped **one accepted epoch**: the
window is `[minClientEpoch, ProtocolEpoch]` = `[0, 1]`, where 0 is "absent
`epoch`" — the alpha.4 client. So the roadmap's N, N-1, N-2 rows collapse to
two: this epoch and the epoch-less client before it. The matrix is
`TestAuth_ProtocolEpoch`, driven over a real socket, plus the fixture replay
that proves the accepted client is byte-compatible:

```bash
cd Server && go test -count=1 -run 'TestAuth_ProtocolEpoch$|TestEpoch1Fixtures$|TestProtocolEpochMatchesSchema$' -v ./ws/
```

```
--- PASS: TestProtocolEpochMatchesSchema (0.00s)
--- PASS: TestEpoch1Fixtures (6.17s)
    --- PASS: TestEpoch1Fixtures/fresh-connect (0.62s)
    --- PASS: TestEpoch1Fixtures/auth-failure (0.01s)
    --- PASS: TestEpoch1Fixtures/ping (0.31s)
    --- PASS: TestEpoch1Fixtures/chat-send-fanout (0.62s)
    --- PASS: TestEpoch1Fixtures/chat-edit-delete (0.61s)
    --- PASS: TestEpoch1Fixtures/reaction-add-remove (0.61s)
    --- PASS: TestEpoch1Fixtures/typing (0.61s)
    --- PASS: TestEpoch1Fixtures/mark-read (0.31s)
    --- PASS: TestEpoch1Fixtures/dm-send (0.62s)
    --- PASS: TestEpoch1Fixtures/resume-replay (1.22s)
    --- PASS: TestEpoch1Fixtures/voice-join-e2ee-leave (0.62s)
--- PASS: TestAuth_ProtocolEpoch (0.06s)
    --- PASS: TestAuth_ProtocolEpoch/absent (0.01s)
    --- PASS: TestAuth_ProtocolEpoch/zero (0.01s)
    --- PASS: TestAuth_ProtocolEpoch/current (0.01s)
    --- PASS: TestAuth_ProtocolEpoch/newer (0.01s)
    --- PASS: TestAuth_ProtocolEpoch/negative (0.01s)
ok  	github.com/J3vb/OwnCord/Server/ws	7.446s
```

| Client epoch     | Case       | Outcome                                                                  | Actionable?                                                  |
| ---------------- | ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| absent (alpha.4) | `absent`   | accepted as 0; every epoch-1 fixture replays unchanged                   | n/a — it works                                               |
| 0                | `zero`     | accepted                                                                 | n/a                                                          |
| 1 (= N)          | `current`  | accepted                                                                 | n/a                                                          |
| 2 (newer)        | `newer`    | `auth_error` `protocol_epoch_unsupported`, `server_epoch: 1`, close 1008 | yes — message says update the server; client keeps its login |
| −1               | `negative` | `auth_error` `protocol_epoch_unsupported`, close 1008                    | yes — message says update the client; Update Now banner      |
| browser client   | —          | **n/a until B8** — no bundled browser client exists                      | exit condition 1 records this as n/a, as the plan does       |

The update side of downgrade — a client release newer than the server's epoch
is withheld, a tampered manifest is refused — is `TestReleaseProtocolEpoch`
(`signed_manifest_declares_the_epoch`, `manifest_without_the_field_is_epoch_0`,
`release_without_a_manifest_is_epoch_0`, `tampered_manifest_is_an_error`), all
PASS.

**Verdict: PASS, at the slim scope the owner chose.** Both accepted client
generations are tested on a real socket, the refused ones fail with a coded
frame that names the side to update, and the client turns that frame into the
same Update Now flow it already had. A three-wide window and its matrix are
one constant away (`minClientEpoch`) if a future epoch bump needs them.

## Question 3 — are the trust claims true?

`docs/trust-model.md` carries **119** `path:line` anchors and names **20**
distinct Go tests plus the vitest cases in its E2EE table. The mechanical half
of the question is whether every anchor still resolves on the measured tree:

```bash
python docs/plans/hp-2-trust-model-anchors.py
```

```
119 path:line anchors checked (24 short-form resolved by unique basename), 0 unresolvable
```

(The 24 short forms are the document's `file.go:NN` after a full path in the
same sentence; each resolves to exactly one tracked file. The checker has no
extension allowlist — Codex on #1444 caught the first version skipping the
`.sh` anchor, and `Server/Dockerfile:13` with it; 117 became 119.) Line-range drift
after a future edit is not caught by this check — it proves the file and the
line exist, not that the line still says what the sentence claims; the 11
Codex rounds on #1443 were the line-by-line read, every finding accepted and
fixed in the document (B2-7 evidence block).

The human half:

- **Owner review** of `docs/trust-model.md` at `88c7a824`: 2026-08-29, with
  the acceptance of this scorecard.
- **Non-developer read** of "The short answer" — BPR-051's exit evidence.
  Reader: **\_\_\_\_**. Date: **\_\_\_\_**. Answer given to "who can read my
  messages?": **\_\_\_\_**. (Quoted from the B2-7 evidence block, where the
  owner fills it in; both places must agree.)

**Verdict: PASS on the mechanical half; the human half is the signature.**
Two claims in the document are absences with no positive test — the server
holds no room key; text is not encrypted — and the document says so rather
than inventing a test for nothing.

## Question 4 — are the E2EE membership and key-change rules stated and tested?

The rules are the table in `docs/trust-model.md` §"What is end-to-end
encrypted". Inventory of what pinned each before HP-2, and the three
adversarial cases HP-2 added (`a51e2e89`, all in
`Client/tests/unit/livekit-e2ee.test.ts` under "HP-2 adversarial membership
and key-change rules"):

| Rule                                                                           | Pinned by (before HP-2)                                                                                                                       | Added by HP-2                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Room key made on a participant's machine                                       | `livekit-e2ee.test.ts` "setupKeyExchange as key holder generates the room key…"                                                               | —                                                                                                           |
| Key holder wraps for each peer (ECDH + AES-GCM)                                | `e2eeCrypto.test.ts` "round-trips a room key between two keypairs"                                                                            | —                                                                                                           |
| Frames encrypted before leaving; SFU relays ciphertext                         | `livekit-session.test.ts` "enables E2EE on the room created by createRoom (OC-0095)"                                                          | —                                                                                                           |
| Server relays wrapped keys opaquely, to channel members only                   | `TestE2EE_Offer_KeyHolderCanSend`, `_RejectsNonKeyHolder`, `_TargetChannelCheckAtomicWithLookup`                                              | —                                                                                                           |
| Server holds no room key                                                       | absence — stated, no positive test                                                                                                            | —                                                                                                           |
| Identity TOFU: pin on first sight, block on change                             | `livekit-session.test.ts` "pins the peer identity key on first sight…", "blocks and emits identity-tofu when the pinned identity key changed" | —                                                                                                           |
| Re-pin TOCTOU: re-pin the key the human saw                                    | `livekit-session.test.ts` "re-pins the verified key, not a store re-read a malicious server mutated (TOCTOU)"                                 | —                                                                                                           |
| Rekey on leave (forward secrecy)                                               | `livekit-session.test.ts` "rotates the room key when a keyed peer leaves while I stay key holder"                                             | —                                                                                                           |
| Timed rotation                                                                 | `livekit-e2ee.test.ts` "[T-47] arms the periodic rotation timer…"                                                                             | —                                                                                                           |
| Rotation during outage (OC-0316), server side                                  | `TestRegisterNow_ReannouncesOwnKeyOnResume`                                                                                                   | —                                                                                                           |
| Rotation during outage (OC-0316), **holder side**                              | receiver side only (`[OC-0007] confirms the room key after a reconnect re-announce…`)                                                         | "[HP-2 / OC-0316] a peer whose socket dropped across a rotation is re-keyed with the rotated key…"          |
| Second device overwrites the one-per-account pin; first device then mismatches | stated in the document (Codex round 6), untested                                                                                              | "[HP-2] a second device's key, once trusted, overwrites the account pin — the first device then mismatches" |
| **Known gap:** modified server adds an unknown member at first contact         | stated under "What beta does not claim" (Codex round 7), untested                                                                             | "[HP-2 known gap] a modified server that adds an unknown member at first contact gets the room key…"        |
| Server decides who may join and publish                                        | `TestE2EE_VoiceToken_IncludesIsKeyHolder`; `voice_moderation_overrides_test.go`                                                               | —                                                                                                           |

All three were written test-first. The RED each produced:

**Known gap** — written first against the _desired_ rule (no offer, no pin
for a first-sight peer the client has no independent membership evidence for;
the voice roster does not even list them):

```
× [HP-2 known gap] a modified server that adds an unknown member at first contact gets the room key wrapped to it
AssertionError: expected [ { type: 'voice_e2ee_offer', …(1) } ] to have a length of +0 but got 1
```

That is the gap, measured: the holder wraps the room key to whoever the server
says is a member, because membership is server-controlled and the client
accepts any first-sight identity (`livekitE2EE.ts` `verifyPeerAnnounce`). The
test now pins **today's** behaviour — offer sent, key pinned, peer "verified"
— with a comment saying it inverts when authenticated membership (or "refuse
unrecognised participants") lands. That fix has its RED waiting.

**Second device** — proven able to fail by temporarily disabling the pinned-key
mismatch block (`if (false && pin !== null && …)`), then restored with
`git checkout`:

```
× [HP-2] a second device's key, once trusted, overwrites the account pin — the first device then mismatches
AssertionError: expected last "vi.fn()" call to have been called with [ ObjectContaining{…} ]
```

**Rotation during outage, holder side** — proven able to fail by temporarily
making a duplicate announce skip the re-offer (`!isDuplicate && this._isKeyHolder …`),
then restored. The first version of this test did not fail under that
mutation: the file's `exportPublicKey` mock returns one fixed string, so the
replayed announce took the "key changed" path instead of the duplicate path
the rule is about. Fixed by round-tripping import/export as the OC-0001 test
does, after which:

```
× [HP-2 / OC-0316] a peer whose socket dropped across a rotation is re-keyed with the rotated key when the server replays its announce
AssertionError: expected [] to have a length of 1 but got +0
```

Restored tree: `Tests 3 passed | 59 skipped (62)` for the `-t "HP-2"` filter;
the full client gate is in "The gate run" below.

**Verdict: PASS with one known gap recorded, not hidden.** Every rule the
document states has a test; the one adversarial case the model cannot defend
against today — a modified server inserting a member at first contact — is
pinned as current behaviour so the fix cannot land silently, and stays under
"What beta does not claim". It is not assigned a phase: the owner decides at
signature whether beta claims it (then B4 or B6 needs an authenticated
membership item) or keeps the disclaimer. The recommendation is to keep the
disclaimer for beta — the fix needs a server-side membership proof the client
can verify, which is a protocol change and belongs after B3.

## Question 5 — is there one predicate per property?

Before: the B2-5 evidence block's inventory table, thirteen decision sites
across `permissions/checker.go`, `service/` and `ws/`, each deciding view,
send, type, admit, join or moderate by hand. After: six predicates in
`Server/permissions/predicates.go`, each site delegating, with parity tables
(`Server/service/predicate_parity_test.go`,
`Server/ws/predicate_parity_internal_test.go`) that ran the old logic and the
predicate over the same fixture before the old logic was deleted.

Residue — direct bit-helper calls outside `Server/permissions`, non-test, at
the measured tree:

```bash
git grep -nE 'HasPerm|HasAnyPerm|HasServerPerm|EffectivePerms|EffectiveChannelPerms|HasAdmin' \
  -- 'Server/*.go' ':!Server/*_test.go' ':!Server/permissions/*'
```

28 lines print; 7 are comments (`admin/handlers_channel_perms.go:143,230,430`,
`admin/middleware.go:99`, `api/middleware.go:186`, `db/channel_queries.go:158`,
`service/mentions.go:286`). The **21 code hits**, each in a class the B2-5
block already lists with its reason:

| Class                                                           | Hits                                                                                                                                                                                   | Why it is not a channel predicate                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server-scoped permission, no channel to resolve a `Subject` for | `HasServerPerm` ×6: `api/middleware.go:200`, `admin/middleware.go:109`, `service/emoji.go:95`, `service/moderation.go:51`, `service/role.go:82`; `HasAnyPerm` `admin/middleware.go:84` | these _are_ the canonical server-wide predicate                                       |
| `HasAdmin` as a fetch short-circuit (skip the override query)   | `service/channel.go:59`, `service/message_perms.go:25`, `service/permission.go:224`, `ws/serve.go:780`, `ws/serve_ready.go:169`, `ws/voice_join.go:355`                                | optimisation before the predicate, not a decision                                     |
| `HasAdmin` as an authorization input                            | `admin/handlers_channel_perms.go:95,325`, `admin/logstream.go:452`, `api/upload_handler.go:404`, `service/role.go:104`                                                                 | role hierarchy / admin perimeter — the 2026-08-18 measurement's "no `Outranks`" class |
| Bulk @everyone reader walk                                      | `service/mentions.go:262,263,266`                                                                                                                                                      | per-role layer walk; owner declined the mechanical conversion 2026-08-18              |
| Base-bit early rejection ahead of `CanModerateVoice`            | `ws/voice_moderation.go:65`                                                                                                                                                            | never admits; keeps FORBIDDEN ahead of the voice-state lookup (B2-5 decision)         |

Zero hits outside those five classes. The plan's step 5 condition ("no file
outside `Server/permissions` calls the bit helpers") is **not met** and was
not expected to be — the `authz-chokepoint` invariant rule stays with B3 item
15, where the residue above is the allowlist it starts from.

**Verdict: PASS as "listed residue with reasons".** Every channel-scoped
security property has exactly one predicate; what remains is server-scoped,
an optimisation, or a declined conversion, each named.

## Question 6 — are the deferred systems bounded?

**Absence.** Three contract tests walk the mounted router, the WebSocket wire
types in `protocol/schema.json`, and every `koanf` key of `config.Config`,
failing on `(?i)federat|directory|discover|listing`:

```bash
cd Server && go test -count=1 -run TestAbsenceContract -v ./api/
```

```
--- PASS: TestAbsenceContract_NoFederationDirectoryOrListingRoutes (0.02s)
--- PASS: TestAbsenceContract_NoFederationDirectoryOrListingWireTypes (0.00s)
--- PASS: TestAbsenceContract_NoFederationDirectoryOrListingConfigKeys (0.00s)
ok  	github.com/J3vb/OwnCord/Server/api	1.352s
```

Each was proven able to fail in B2-7 (a temporary `/api/v1/directory` route; a
temporary `directory_list` wire type — outputs in the B2-7 evidence block).
The bound is stated in `trust-model.md`: vocabulary at three boundaries,
network by the outbound-host table (ten server rows, each with trigger,
purpose, condition-plus-control and anchor — B6's capture checklist),
semantics by review.

**Plugins.** `docs/architecture/plugins.md` §"Status: off, twice — and not in
the release at all" is the configuration audit:

| Shape                      | Verdict | Why                                                                                                                           |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Fresh install              | off     | default `false` (`config.go:352`); generated `config.yaml` block commented out (`:452-457`)                                   |
| Upgraded install           | off     | no `plugins` key in an older file; koanf loads defaults first; a misspelled key is warned and ignored (`:520`)                |
| Docker                     | off     | image built without the tag (`Dockerfile:13`); the env flag can flip `plugins.enabled` but the binary cannot execute a module |
| Standalone release binary  | off     | no tag (`release.yml:261`, `:268`)                                                                                            |
| Source build with the flag | **on**  | `go build -tags wazero` **and** `plugins.enabled: true` together — the developer path and the only one                        |

Read back on the measured tree: `release.yml:261` and `:268` are plain
`go build -o chatserver… -ldflags "-s -w -X main.version=$VERSION" .`;
`Server/Dockerfile:12-13` is `CGO_ENABLED=0 GOOS=linux go build -o /chatserver`.
No `-tags wazero` on any shipped path. "No API promise" is the document's
second section; the beta release-notes paragraph is in the same file.

**L-08** (WASM example build gate): re-tagged B1/B10 by the B2-7 decision,
reason recorded there — compare-in-CI cannot pass in principle (TinyGo embeds
host paths, no `-trimpath`), compile-only needs a second Go SDK on every PR,
and the subsystem is compiled out of every artifact a release contains.

**Verdict: PASS.** Federation, directory and listing are absent by test at
three boundaries; WASM is off by default, off on upgrade, and cannot execute
in any shipped artifact.

## Question 7 — is `dev` strict?

```bash
gh api repos/J3vb/OwnCord/branches/dev/protection --jq '{strict: .required_status_checks.strict, checks: (.required_status_checks.contexts|length), enforce_admins: .enforce_admins.enabled, approvals: .required_pull_request_reviews.required_approving_review_count, force: .allow_force_pushes.enabled, del: .allow_deletions.enabled}'
```

```json
{
  "approvals": 0,
  "checks": 12,
  "del": false,
  "enforce_admins": true,
  "force": false,
  "strict": true
}
```

The twelve required checks: Server Build & Test (ubuntu-latest), Server Build
& Test (windows-latest), Client Static Checks, Client Unit Tests, Rust Unit
Tests, Client E2E (Playwright), Client E2E (parity subset, blocking), Analyze
(go), Analyze (javascript-typescript), Analyze (actions), Repository Hygiene,
Docs & Ledger Consistency.

**Verdict: PASS.** This closes HP-1's condition 6, accepted there as a stated
limitation: with `strict: true` every squash that lands on `dev` was tested
against the base it lands on. The cost HP-1 predicted — an "Update branch" on
every open PR when another merges — has been paid on every B2 PR since B2-0
and is the reason the plan keeps one PR in flight.

## B2 exit gate

| #   | Condition                                                                                                                             | Status                    | Evidence                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Clients from epochs N, N-1, N-2 pass the matrix; N-3 fails safely and actionably; the bundled browser client matches the server epoch | **met at the slim scope** | Question 2 — one accepted epoch by owner decision; both accepted generations tested; browser client n/a until B8             |
| 2   | Protocol and update-metadata changes are generated, documented, and downgrade-tested                                                  | **met**                   | Question 1 (`npm run generate` drift gate in `check:server`), `TestReleaseProtocolEpoch`, `docs/protocol.md` § Compatibility |
| 3   | Effective-permission and resource-existence sibling cases have parity tests                                                           | **met**                   | Question 5 — two parity tables, red before delegation for S-01 and SEC-02                                                    |
| 4   | Voice/video/screen E2EE membership and key-change behaviour pass adversarial tests                                                    | **met, one gap recorded** | Question 4 — every stated rule pinned by a test; the first-contact membership gap pinned as current behaviour and disclaimed |
| 5   | No central identity, directory, federation path, or required external service exists                                                  | **met**                   | Question 6 — three absence tests + outbound-host table                                                                       |
| 6   | WASM disabled by default; release artifacts do not imply API stability                                                                | **met**                   | Question 6 — configuration audit, no `-tags wazero` in any shipped build, "No API promise"                                   |
| 7   | No unresolved B2 security advisory remains                                                                                            | **met**                   | B2-9 evidence block — zero B2-owned rows open; SEC-01/SEC-04 advisories are B4/B6 rows the owner creates                     |
| 8   | _(added)_ Epoch-1 fixtures were captured before the first protocol change, in a separate commit                                       | **met**                   | Question 1 — `54cae614` (08-28 12:37) precedes `2ac9b5ba` (08-29 06:32), separate PRs                                        |
| 9   | _(added)_ Pre-squash SHAs recorded for the fixture and negotiation commits                                                            | **met**                   | The table at the top; every SHA resolved on the fetched refs                                                                 |

### The gate run

Measured 2026-08-29 on the branch, before each commit, per the `ci-check`
skill. Every step exited 0.

| Step                                                          | Result                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run check:client` (vitest, `tsc --noEmit`, eslint)       | pass — **193 files, 5273 tests**, the three Q4 cases included              |
| `npx knip` (blocking in CI, not part of `check:client`)       | pass — four configuration hints, exit 0                                    |
| `npm run check:docs`                                          | pass — 21 claims across 9 watched documents agree with the ledger          |
| `npm run check:hygiene`                                       | pass — prettier clean; shellcheck/actionlint skipped locally, CI runs them |
| `go test ./ws/ ./api/ ./updater/` (Questions 2 and 6 subsets) | pass — outputs above                                                       |

No Go or Rust source changed on this branch, so the four build-tag variants,
`-race`, `-tags deadlock` and `golangci-lint` were not re-run locally; CI's
required checks run them on the PR.

## Open items carried past B2

Recorded, not fixed. None blocks B3's entry.

| Item                                 | State                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2EE first-contact membership gap    | **open, disclaimed.** Question 4. Pinned as current behaviour; owner decides at signature whether beta claims it (needs a phase) or keeps the disclaimer. |
| SEC-03 — bounded preview/media reads | **B5 item 11**, re-tagged by B2-9 with the sizing reason; shape is the C-09 contract clause 6.                                                            |
| SEC-01, OC-0324                      | **B4.** SEC-01's private advisory is the owner's to create; ID line in the B2-9 block.                                                                    |
| SEC-04                               | **B6.** Same — advisory ID line in the B2-9 block.                                                                                                        |
| C-09 client code                     | **B7** — the native fetch broker implements the contract written in B2-7.                                                                                 |
| `authz-chokepoint` invariant rule    | **B3 item 15**, allowlist = the Question 5 residue.                                                                                                       |
| L-08 WASM example build gate         | **B10**, by the B2-7 decision.                                                                                                                            |
| OC-0349 `voice_join` ordering hazard | **open, low** — ledger; a later fix batch.                                                                                                                |
| BPR-051 non-developer read           | **pending owner** — the `____` line in the B2-7 block and Question 3.                                                                                     |
| `bughunt-fix` workflow gate list     | tooling — phantom `gate: FAIL` (`format:check` gone, `knip` missing); observation logged, not B2.                                                         |
| Release binaries lack `-tags wazero` | **by design**, now stated in `plugins.md`; revisit only if a release is ever meant to run a plugin.                                                       |

## Hand-off to B3

The roadmap's current slice: when HP-2 closes, B3 opens with the "First
actionable slice" of
[developer-experience-layout-refactor-2026-08-29.md](developer-experience-layout-refactor-2026-08-29.md)
— inventory, before-state graph, auth characterization tests, the auth
vertical slice, HP-3. Nothing from that plan touches the client before B7.
B3 item 15 (`authz-chokepoint`) starts from Question 5's residue table.

## What acceptance does and does not authorise

Accepting HP-2 authorises B3 to begin. It does **not** claim:

- that OwnCord is beta-ready — every B2 exit condition is a contract frozen,
  not a product qualified;
- that the E2EE model resists a modified server — it resists an operator who
  reads; the first-contact membership gap is pinned and disclaimed (Question 4);
- that a three-wide epoch window exists — one epoch is accepted by policy
  (Question 2);
- that every direct bit-helper call is gone — the residue is listed with
  reasons (Question 5);
- that the deferred security rows are fixed — they are owned and scheduled
  (B2-9 table), not resolved.

**Signed:** J3vb (repository owner), 2026-08-29 — accepted in session, recorded
by this commit.
