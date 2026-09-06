# HP-5 — Abuse and privacy review scorecard

**Hold point:** HP-5, defined in
[b5-community-content-moderation-2026-09-04.md](b5-community-content-moderation-2026-09-04.md)
§HP-5 (roadmap
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md), B5)
**Commits reviewed:** the six steps in front of HP-5, squash-merged on `dev`
(table below)
**Measured at:** `dev` `a504d61e` (#1545, B5-4), branch `docs/hp-5-scorecard`
**Measured:** 2026-09-06 (drafted overnight; the B5-4, B5-5 and B5-12 rows
carry their PR numbers)
**Evidence base:**
[community-services.md](../architecture/community-services.md) (the abuse
cases, data ownership and lifecycle for every B5 service, and its HP-5 topic
index); the plan's B5-0..B5-5 evidence blocks; the adversarial suites named
per topic below; the schema drafts in [hp-5-drafts/](hp-5-drafts/README.md)

**Decision: ACCEPTED 2026-09-06** — the owner merged this scorecard as #1547
(`0013de70`) and, the same morning, B5-11's PR #1548, with every decision in
Question 9 standing; the signature lines below were filled in by a follow-up
docs PR at the owner's instruction. Acceptance authorises B5-6 → B5-7,
B5-8 → B5-9 → B5-10, and B5-11; it claims nothing about beta readiness.

The roadmap names twelve topics to review "before exposing the endpoints".
Six are reviewed **against shipped code and real adversarial tests** (the
steps in front of HP-5 hardened surfaces that were already exposed); six are
reviewed **against schema and state-machine designs**, because the endpoints
they concern do not exist yet — that is the point of the hold. Each answer
below names the command or test that produces the evidence, in the shape of
[hp-4-scorecard-2026-09-02.md](hp-4-scorecard-2026-09-02.md).

## The chain under review

`dev` is squash-merge only; each step's pre-squash commits survive on its
pull-request ref (`git fetch origin 'refs/pull/<n>/head:pr-<n>'`).

| PR    | Step                                                                                     | On `dev`   | Pre-squash head |
| ----- | ---------------------------------------------------------------------------------------- | ---------- | --------------- |
| #1540 | B5-0 — abuse cases, data ownership and lifecycle for every B5 service                    | `a60c6ca9` | `a5948f00`      |
| #1541 | B5-1 — `Server/safefetch`, adopted by the GIF proxy and the plugin `http` capability     | `af473ff4` | `1f7b6be0`      |
| #1542 | B5-3 — browser-client hosting off by default, proved by a route walk and a wire probe    | `5c7a0f4a` | `81cb6402`      |
| #1543 | B5-2 — per-user upload quotas, one reserved-headroom floor, tick reconciliation (SEC-04) | `123b07d8` | `8a1594a2`      |
| #1545 | B5-4 — Web Push subscription storage, nothing dispatched                                 | `a504d61e` | `2de7c3a0`      |
| #1544 | B5-5 — rich-content inventory, GIF result-URL hygiene, S-03 pinned                       | `1311fee9` | `212ce942`      |
| #1546 | B5-12 — register and roadmap reconciliation                                              | `2b187b64` | `2cf163c3`      |
| this  | HP-5 — this scorecard and the schema drafts                                              | —          | —               |

B5-2's two-commit structure (the `maintenanceTick` extraction `f3f7c6f5`,
then the feature `63250a15`) is the one this review depends on: the
step-order test and the sweep seam B5-4 reused were introduced by the first
commit, not the second.

## The steps behind the hold

None of these may merge before this scorecard is signed; they may be built
on draft pull requests marked `[behind HP-5]`, on the branches below.

| Step  | Branch                              | PR         |
| ----- | ----------------------------------- | ---------- |
| B5-6  | `feature/b5-6-message-requests`     | #1549      |
| B5-7  | `feature/b5-7-nsfw-acknowledgement` | PR pending |
| B5-8  | `feature/b5-8-reports`              | PR pending |
| B5-9  | `feature/b5-9-moderator-actions`    | PR pending |
| B5-10 | `feature/b5-10-appeals`             | PR pending |
| B5-11 | `feature/b5-11-push-dispatch`       | #1548      |

## Question 1 — the six topics against shipped code

Each verdict cites the test that would go red if the control were removed.
"Server" means the paths the server itself fetches or stores; the desktop
client's own fetches are C-09/B7 and are inventoried, not claimed
([rich-content-inventory.md](../architecture/rich-content-inventory.md)).

| Topic                          | Verdict                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private-address resolution** | **Closed, server**                      | `Server/safefetch/classify_test.go`: `TestClassifyAddr_RejectsEveryNonGlobalClass`, `_UnwrapsNAT64`, `_RejectsZonedAddresses`; `destination_test.go`: `TestFetch_BlockedResolutionNeverDials`, `_MixedAnswerSetRefusesEverything`, `_CNAMEChainJudgedOnFinalAddresses`, `_AddressChangeBetweenValidationAndConnect`, `_DialBindingRejectsAnUnvettedAddress`; both call sites: `TestGIFProductionPolicyRefusesLoopback`, `TestHTTPDo_AllowlistedHostResolvingPrivateIsDenied`                                     |
| **Redirects**                  | **Closed, server**                      | `Server/safefetch/response_test.go`: `TestFetch_RedirectToPrivateTarget`, `_RedirectSchemeDowngrade`, `_RedirectSchemeDowngradeEndToEnd` (the real TLS chain — the plain `_RedirectSchemeDowngrade` uses a stub), `_RedirectLoop`, `_AuthorizationDroppedCrossHost`, `_AllowHostAppliesToEveryHop`, `_ZeroRedirectBudgetRefusesImmediately`; `TestGIFUpstreamRedirectIsRefused`                                                                                                                                  |
| **Decompression**              | **Closed, server**                      | `TestFetch_DecompressionBomb`, `_GzipUnderCeilingSucceeds`, `_UnexpectedContentEncodingIsRefused`, `_IdentityContentEncodingIsPlain`, `_ByteCeilingIsExact`, `_DecompressedCeilingIsExact` — two ceilings, before and after inflation; the wire ceiling's boundary cases run ceiling−1..ceiling+2, the inflated ceiling's start at the ceiling itself, not ceiling−1                                                                                                                                             |
| **Oversized streams**          | **Closed, server**                      | `TestFetch_LyingContentLength`, `_CeilingBeatsHonestContentLength`, `_EndlessBodyIsCutOffEarly`, `_SlowLorisBodyHitsTheDeadline`, `_SlowLorisHeadersHitTheDeadline`, `_ConcurrencyCap`, `_ProcessGateBoundsEveryFetcher`; `TestGIFOversizedUpstreamBecomesBadGateway`                                                                                                                                                                                                                                            |
| **Malicious previews**         | **Closed, server; inventoried, client** | Server: the GIF proxy is the only server-side preview-shaped fetch, and its upstream is a constant (`TestGIFWrongContentTypeBecomesBadGateway`, `TestGIFResultURLsAreHTTPSWithoutCredentials`, `TestGIFOfflineUpstreamIsBadGatewayWithoutLeak`). Client: every renderer fetch is a row in the inventory with its bounds and its owning phase (B7 for the broker, B9 for the render gate); decision 3 keeps previews client-fetched, and this scorecard records that as accepted (Question 8)                     |
| **Storage exhaustion**         | **Closed, server**                      | Uploads (B5-2): `TestUploadQuota_ConcurrentRacersThroughTheHandler`, `_LowDiskIs507BeforeTheBodyIsSpooled`, `_ChargeReleasedWhenTheWriteFails`, `_ChargeReleasedOnPanicAfterTheWrite`, `TestEveryFileStoreSaveIsReserved`, `TestChargeUserStorage_GuardIsExactAtTheBoundary`, `TestEmojiUpload_IsFloorGatedButNotCharged`. Subscriptions (B5-4): `TestPushSubscriptions_DeviceCapEvictsOldest`, `TestPushSweep_UsesTheConfiguredWindow`. Report evidence (B5-8): by reference only, never bytes — see Question 3 |

**Two things this table does not claim.** The desktop renderer's own fetches
(previews, inline images, YouTube) have no resolved-address check, follow
redirects unchecked and buffer whole bodies — measured in the inventory, owed
to B7 under C-09. And the plugin `http` capability is closed at the boundary
but has **no caller wired into any build** (`plugins.enabled` defaults false,
the allowlist defaults empty), so its rows are a proof about code that cannot
yet run.

```bash
go test -C Server -count=1 -race ./safefetch/ ./api/ ./plugin/ ./db/ ./service/ -run 'TestClassifyAddr|TestFetch_|TestGIF|TestUploadQuota|TestPushSub|TestPushSweep|TestHTTPDo_|TestEveryFileStoreSaveIsReserved|TestChargeUserStorage_|TestEmojiUpload_'
```

## Question 2 — the six topics against designs

Nothing here is routed. Each verdict names the draft that encodes it and the
step that owes the test.

| Topic                      | Verdict as designed                                                                                                                                                                                                                                                                                                    | Draft                       | Owed by |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------- |
| **Spam**                   | One `message_requests` row per (sender, recipient) pair ever; a re-send after `ignored` creates no second request and no notification; the sender's view is byte-identical across `pending`, `ignored` and `deleted` (decision 5). The gate sits at `service/message_crud.go`'s `OpenDM` accumulation, not `CreateDM`. | `message_requests.up.sql`   | B5-6    |
| **Block bypass**           | A blocked sender cannot create a request (the existing `IsEitherBlocked` refusal runs first, and it must fail **closed** on a lookup error — the B5-0 finding that it fails open today is fixed in the same step); a recipient who cannot receive DMs gets no request; acceptance cannot resurrect swept content.      | `message_requests.up.sql`   | B5-6    |
| **Report confidentiality** | Question 4.                                                                                                                                                                                                                                                                                                            | `reports.up.sql`            | B5-8    |
| **Moderator privilege**    | Question 5.                                                                                                                                                                                                                                                                                                            | `moderation_actions.up.sql` | B5-9    |
| **Appeal abuse**           | `UNIQUE (action_id)`: one appeal per action, ever; the per-user rolling-window cap in `auth.RateLimiter`; the acting moderator may not decide where another eligible one exists; "blocked" = over the window cap (decision 8, read as recorded in Question 9).                                                         | `appeals.up.sql`            | B5-10   |
| **Notification leakage**   | Question 6.                                                                                                                                                                                                                                                                                                            | `push_dispatch_state.md`    | B5-11   |

## Question 3 — the schema drafts, each with its rollback

**Every migration B5-6..B5-10 will apply has its reversal written now**, in
[hp-5-drafts/](hp-5-drafts/README.md), because B4's exit found nine of
twelve migrations without one. Each `up` and `down` was applied in order,
then reversed in order, against a migrated in-memory database before this
draft was committed.

| Draft                                 | Step  | Migration | Shape                                                                                                                                                                                                               |
| ------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_requests.{up,down}.sql`      | B5-6  | 046       | `trusted_senders(recipient, sender, source ∈ accepted/sent_first/grandfathered)`; `message_requests` one row per pair with a five-state `CHECK`; every existing one-to-one DM pair grandfathered in both directions |
| `nsfw_acknowledgements.{up,down}.sql` | B5-7  | 047       | `(user_id, channel_id)` primary key, both halves cascading; clearing a channel's label deletes its rows so a re-label re-prompts; never swept                                                                       |
| `reports.{up,down}.sql`               | B5-8  | 048       | `reports` with two bare-id-plus-token principals (the 038/041 pattern), `report_evidence` keyed `(report_id, seq)` with attachments **by reference**, `report_notes`; no foreign key on any principal, on purpose   |
| `moderation_actions.{up,down}.sql`    | B5-9  | 049       | the action ledger every action writes — warning, timeout, removal, kick, ban — with `expires_at` for timeouts and `acknowledged_at` for warnings; `target_id` cascades, `actor_id` is bare-plus-token               |
| `appeals.{up,down}.sql`               | B5-10 | 050       | `action_id UNIQUE` — one appeal per action, ever; appellant cascades; the deciding moderator is bare-plus-token                                                                                                     |
| `push_dispatch_state.md`              | B5-11 | none      | no table: an attempt succeeds, is retried in-process, or answers `404`/`410` and deletes the row; no per-user delivery history                                                                                      |

**Decision 7, ruled as designed.** On the subject's erasure the evidence
snapshot's content is hard-deleted (every `report_evidence` row of every
report about them, and every row they authored as context in someone else's
report), and the `reports` row survives with `subject_id = 0`, the marker
token, `detail` and `target_ref` cleared, and — if still open — `state` and
`outcome` set to `subject_erased`. The surviving row is action, time, order
and token, nothing else. B5-8 owes both halves as tests, and the negative
control for the second: an implementation that deletes the row passes the
first test and must fail the second. Two consequences are recorded rather
than defended: the outcome row lives in the SQLite file, so it is durable
against erasure and **not** against a restore of an older backup; and a
report's content is bounded by a retention window (180 days after close,
`moderation.report_retention_days`) while its outcome row is not.

**The surrounding-context rule.** Five messages either side of the reported
one, captured at report time; a message already deleted or swept away is
absent, not placeholdered. For a DM report the snapshot carries the reported
message and its context **only when the reporter is a participant** — this
is the one path into DM content that no permission otherwise grants, and it
opens exactly as wide as the reporter's own view, no wider.

## Question 4 — the report-confidentiality model

**Who can see a reporter's identity:** a holder of the moderation permission
(`MODERATE_MEMBERS`, bit 22, Question 5) reading the queue, and the reporter
themself reading their own report's status. **Nobody else** — and in
particular the reported user cannot, by any of four routes, each of which
B5-8 owes as a test:

1. **No surface.** No endpoint returns a report to its subject; the subject's
   own `GET` of a report id answers `404`, indistinguishable from a
   non-existent id (authorization before existence, the moderation service's
   standing rule).
2. **No signal.** Filing a report emits no socket frame to the subject, changes
   nothing the subject can read, and produces no error-code or timing
   difference on the subject's own requests — proved decision 5's way, by
   comparing responses across states rather than asserting an absence.
3. **No leak through the action.** A moderation action taken on a report
   carries `report_id` as a bare integer in the ledger. The target-facing
   `reason` is bounded at runtime — at most 500 runes, no control characters
   — and the `audit_log` row for the action gets a fixed phrase, never the
   `reason` text itself; B5-9 implements and tests both bounds.
   `audittest.AssertSafeDetails` is a test helper, not a runtime control — it
   runs after the fact, over the recorded corpus, and proves the audit rows
   stay clean once the runtime bound and the fixed phrase are in place. The
   action payload the target sees carries the reason and never the reporter.
4. **No leak through erasure.** The reporter's own erasure sets
   `reporter_id = 0` and fills `reporter_token`; the subject's erasure clears
   the report's content (Question 3). Neither path exposes the other principal.

The queue read itself is gated on bit 22 through the canonical predicate
path (`Server/permissions/checker.go`), which
`Server/invariants/authz_chokepoint.go` keeps to one code path. Internal
notes are visible to bit-22 holders only, never to either party — the name
is the contract.

## Question 5 — the moderator-privilege matrix

**The permission ladder** (decision 6):

| Action                              | Permission                        | Mechanism                                                      |
| ----------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| Read the queue, assign, note, close | `MODERATE_MEMBERS` (bit 22, new)  | B5-8                                                           |
| Warning                             | `MODERATE_MEMBERS`                | B5-9, new row kind                                             |
| Timeout (text, reactions)           | `MODERATE_MEMBERS`                | B5-9, new row kind; voice half defers to `MUTE_MEMBERS` (20)   |
| Content removal                     | `MANAGE_MESSAGES` (existing)      | `message_purge.go` / `DeleteMessage`, now writing a ledger row |
| Kick (force-logout)                 | `KICK_MEMBERS` (existing)         | `ForceLogout`, now writing a ledger row                        |
| Ban                                 | `BAN_MEMBERS` (existing)          | `BanUser`, now writing a ledger row                            |
| Decide an appeal                    | `MODERATE_MEMBERS`, not the actor | B5-10                                                          |
| TLS, backups, updates               | **Owner only** — unchanged        | B5-9 proves it by test, not assertion                          |

Bit 22 stays **out** of `AdminPerimeter`: a warning-only moderator must not
inherit the perimeter's read surface (`/stats`, the `/users` list, `/me`),
which re-checks nothing by design.

**Adversarial cases B5-9 owes, each as a test:**

| Case                                      | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self                                      | Every action on oneself is refused (`BanUser`'s existing self-ban refusal, extended to warning and timeout)                                                                                                                                                                                                                                                                                                                                     |
| Peer (same top role)                      | Refused by `requireOutranks`, before existence                                                                                                                                                                                                                                                                                                                                                                                                  |
| Superior                                  | Refused the same way                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The owner as target                       | Refused: the owner outranks everyone                                                                                                                                                                                                                                                                                                                                                                                                            |
| Concurrent role change                    | The rank comparison runs inside the same transaction as the write; a target promoted between the check and the write is refused, not sanctioned — the property test drives both orderings                                                                                                                                                                                                                                                       |
| A moderator deciding their own appeal     | Refused where another eligible moderator exists; allowed on a one-moderator install, and the audit row says so                                                                                                                                                                                                                                                                                                                                  |
| A plugin capability taking an action      | Impossible: workstream 10's absence proof — no host import reaches the moderation service, and B5-9 refuses a non-human actor at the service boundary (there is no schema `CHECK` on `actor_id` — one would forbid the erasure transition to 0), so every moderation audit row carries a human actor token by construction, tested directly                                                                                                     |
| A moderator quoting content into `reason` | Refused by the audit detail denylist                                                                                                                                                                                                                                                                                                                                                                                                            |
| The four-file bit                         | `TestAdminPanelPermGridCoversEveryPermissionBit` checks only two of the four files — it ORs `admin/static/index.html`'s grid against `permissions.AllPerms` (`permissions.go`) and fails if they disagree. `docs/schema.md`'s bit map and `Client/src/lib/types.ts`'s enum have no such gate; B5-8 owes one, since the four-file edit lands with the bit grant in 048 (the same doc-gate is owed by B5-8's own plan entry, not duplicated here) |

## Question 6 — the notification-leakage defaults for B5-11

The roadmap's parallelism rule blocks dispatch on these; they are decided
here so B5-11 implements rather than designs.

1. **Off by default, behind its own key.** `push.dispatch_enabled`, default
   false, **separate from** B5-4's `push.enabled`. An operator who enabled
   subscription storage in the B5-4 era must not acquire dispatch by upgrade;
   two keys make the second consent explicit. `TestNoAutomaticTelemetry_Capture`
   stays green on compiled defaults because both keys are off.
2. **Generic content, no option to widen it in beta.** The payload is
   `{"t":"activity"}` plus nothing: no message text, no channel name, no
   sender, no counts. The client fetches the detail from its own server after
   waking. A per-channel or per-message payload is a post-beta decision, not
   a config key.
3. **Dispatch-time permission check.** Before pushing for an event in a
   channel, the canonical predicate (`CanViewChannel`) is re-evaluated for
   the subscriber at dispatch time; a subscriber who lost access between the
   event and the dispatch receives nothing — even a generic ping is a timing
   oracle for a channel they cannot read.
4. **NSFW.** No push is emitted for a labelled channel the subscriber has not
   acknowledged (B5-7's row), and the payload is generic regardless.
5. **The egress row.** `Server/invariants/egress_sites.go` gains a
   `config`-triggered row, gate `push.dispatch_enabled`, destination "the
   push service named in each stored subscription endpoint", sites listed;
   `TestEgressAllowIsLive` stays green.
6. **Through `safefetch`.** Dispatch builds a `Fetcher` with a push-shaped
   `Policy` (https/443, `POST`, zero redirects, a small byte ceiling, the
   content types a push service answers with), so a hostile endpoint that
   resolves to a private address is refused by the same classifier the GIF
   proxy uses.
7. **Failure handling.** `404`/`410` deletes the row; other failures retry
   in-process with a bounded budget and are dropped on restart; nothing is
   persisted per attempt (`push_dispatch_state.md`).
8. **No relay.** Every endpoint is the one the subscriber's browser handed
   over; the server never talks to an OwnCord-operated host. B5-11 owes the
   absence proof in B4-2's style.

## Question 7 — the protocol verdict for B5-6..B5-10, once

**Extend, never mutate — epoch 1 stays.** All five steps add server-to-client
notification frames and add no client-to-server commands: every mutation
(accept a request, acknowledge a channel, file a report, take an action,
submit an appeal) is a REST call, so the socket carries only what changed.
The new frame names are additive to epoch 1's registry, each with a new
fixture capture, and no existing fixture is mutated. Names avoid the
absence-contract regex (`(?i)federat|directory|discover|listing`): the
report queue is `queue`. B5-6's first-contact gate sits **above**
`GetOrCreateDMChannel`, so the epoch-1 `dm-send.json` fixture proves nothing
about it — B5-6 writes its own coverage and does not read the green fixture
as evidence.

| Step  | Frames (server → client)                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------- |
| B5-6  | `dm_request` (created / accepted / ignored / deleted / blocked, recipient only; the sender sees nothing) |
| B5-7  | `nsfw_ack` (acknowledged / revoked, to the user's other devices)                                         |
| B5-8  | `mod_queue` (a change in the queue, to bit-22 holders)                                                   |
| B5-9  | `mod_action` (a warning or timeout applied to the target)                                                |
| B5-10 | `appeal_status` (to the appellant)                                                                       |

The `protocol-change` skill governs every one; the generated
`Server/ws/message_types.go` and `Client/src/lib/protocolTypes.ts` are
regenerated, never edited.

## Question 8 — the two narrowed exit conditions (decision 14)

Exit condition 2 is met at the server only (B5-1, already on `dev`). Exit
condition 3 **will be met at the server by B5-7 once this scorecard is
signed** — B5-7 is one of the steps behind this hold and has not been built
yet, so condition 3 is not met today. Both conditions' client halves are
B7's (the native broker, C-09) and B9's (the render gate and consent UI).
B5-12 records the re-tags of BG-18 and BG-19 that mark where those halves
live, narrowing the roadmap's wording to match under one standard; B5-12
(#1546) merged to `dev` as `2b187b64`.

**Owner's acceptance of the narrowed exit condition 2:** Accepted 2026-09-06, at the owner's instruction, with the scorecard's merge as #1547.
**Owner's acceptance of the narrowed exit condition 3:** Accepted 2026-09-06, at the owner's instruction, with the scorecard's merge as #1547.

## Question 9 — decisions this scorecard records

Made under the owner's 2026-09-04 delegation, open to reversal at signature:

1. **B5-11 dispatch has its own key** (`push.dispatch_enabled`), not B5-4's.
2. **Report retention:** content (evidence, notes, the reporter's free text)
   180 days after close, the row indefinite; open reports never pruned.
3. **Evidence attachments by reference**, never bytes — a snapshot neither
   pins nor dangles into storage.
4. **Context window:** five either side, absent rows absent.
5. **Timeout and warning rows retire** 90 days after expiry or
   acknowledgement unless an appeal references them; ban, kick and removal
   rows stay with the account.
6. **"A blocked appellant"** (decision 8) is read as an appellant over the
   rolling-window cap; an erased one has no account to submit from.
7. **Rotation of the VAPID key is an operator action** (B5-4): replace the
   file, restart, and the rows under the old key are hidden at once and swept
   at the next boot. No endpoint.

## Pre-squash SHAs of the chain's PRs

The already-merged steps' PR refs are in the chain table above. Recorded as
B5-4, B5-5 and B5-12 land:

| Step  | Branch                                | Pre-squash head                                                                                   | PR    |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------- | ----- |
| B5-4  | `feature/b5-4-push-subscriptions`     | `2de7c3a0` → squash `a504d61e`; Codex round in `3ef5bfc6`, floor tests in `2de7c3a0`              | #1545 |
| B5-5  | `feature/b5-5-rich-content-inventory` | `212ce942` → squash `1311fee9`; Codex round fixed in `00a2398b`, verification round in `212ce942` | #1544 |
| B5-12 | `docs/b5-12-register-roadmap`         | `2cf163c3` → squash `2b187b64`; Codex round fixed in `2cf163c3`                                   | #1546 |

**Signed:** Accepted 2026-09-06 — the owner merged this scorecard as #1547
(`0013de70`) and instructed that the signature be recorded; recorded by a
follow-up docs PR, not signed in the owner's name. Acceptance authorises
B5-6 → B5-7, B5-8 → B5-9 → B5-10, and B5-11, and claims nothing about beta
readiness.
