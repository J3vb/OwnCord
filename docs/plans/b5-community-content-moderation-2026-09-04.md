# B5 — Add community, content, and moderation services

**Drafted:** 2026-09-04  
**Base commit:** `e1781086` (`dev`; B4's exit was accepted 2026-09-03 at
`0a14554` and today's CI-gate work — #1534, #1536, #1537 — is merged on top)
— claims below verified at `e1781086`  
**Status:** DRAFT — not started. No implementation has landed. **All fourteen
decisions were settled 2026-09-04** (the owner delegated them; thirteen as
drafted, decision 7 strengthened), so no step is blocked on an unanswered
question. Two owner _actions_ remain and neither is due before the exit.

**Roadmap section:** ["B5 — Add community, content, and moderation
services"](repo-health-roadmap-2026-08-23.md) — objective, entry gate, eleven
workstreams, HP-5, exit gate, required evidence, safe parallelism.  
**Primary requirements:** BPR-060..BPR-063 and BPR-070..BPR-073
([requirements](beta-product-requirements-2026-08-23.md),
[traceability](beta-requirements-traceability-2026-08-23.md)).  
[README.md](README.md) is the status authority; if this header and the README
row disagree, this header is stale.

**Objective, restated from the roadmap:** complete the **server-side**
services needed for safe community operation _before_ building their full
cross-client experience. The client _experience_ is B7/B8/B9; the service, the
schema, the permissions, the audit, and the tests are B5. One caveat that cost
this plan a redraft: "client surface" does not mean "everything with a
rendered pixel". `Server/admin/static/` is server-embedded and is B5's, and
BPR-071 — which the first draft placed wholly out of scope — has a **service
half that the traceability matrix assigns to B5** and that B5-8 closes.

Six of the fifteen B5-tagged register rows are written "B5/B8" or "B5/B9"
(BG-01 and BG-05 to B8; BG-13, BG-14, BG-18 and BG-19 to B9). Four more are
multi-phase for other reasons — three look backwards to B3 (OC-0323, OC-0357,
S-03) and BG-12 spans B4/B5/B9.

**This draft was rewritten once**, after an adversarial pass refuted its step
order, its hot-file table, its HP-5 placement, and its exit-gate scoping. The
refuted claims are kept in "Verify before you implement" rather than deleted,
because the corrections are the useful part.

## Steps at a glance

| Step      | What                                                                                                                       | Size     | Migration | Protocol |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | -------- |
| **B5-0**  | Abuse cases and data ownership for every B5 service — closes entry-gate item 3, and is HP-5's input                        | 2 days   | —         | none     |
| **B5-1**  | `Server/safefetch`: one bounded, SSRF-resistant server outbound-content boundary (SEC-03 server half, BPR-062 server half) | 3 days   | —         | none     |
| **B5-2**  | Durable upload quotas, reserved disk headroom, cleanup, operator-visible pressure (workstream 4, **SEC-04**)               | 4–5 days | `044`     | none     |
| **B5-3**  | BG-01 server posture: browser-client hosting off by default; disabled mode exposes no route and no asset                   | 1 day    | —         | none     |
| **B5-4**  | Web Push subscription **storage** only — per server/device, opt-in, revocable, VAPID rotation, stale cleanup               | 2 days   | `045`     | none     |
| **B5-5**  | Rich-content inventory behind B5-1's boundary (BPR-061, BG-19 server half), and S-03's rune contract                       | 1–2 days | —         | none     |
| **HP-5**  | **Abuse and privacy review — the owner signs.** Gates every step below it                                                  | —        | —         | —        |
| **B5-6**  | Message Requests state machine and the server-local trusted-sender relationship (BPR-060, BG-13 server half)               | 4–5 days | `046`     | **yes**  |
| **B5-7**  | NSFW label plus per-user acknowledgement enforced server-side (BPR-063, BG-18 server half)                                 | 6–8 days | `047`     | **yes**  |
| **B5-8**  | Local report intake and queue service (BPR-070, **BPR-071 server half**, BG-14 server half a)                              | 4 days   | `048`     | **yes**  |
| **B5-9**  | Narrowly permissioned moderator actions: warning, timeout, content removal, kick, ban (BPR-072)                            | 4 days   | `049`     | **yes**  |
| **B5-10** | Rate-limited appeals: submission, transitions, decisions, user-visible status, audit (BPR-073)                             | 2–3 days | `050`     | **yes**  |
| **B5-11** | Web Push **dispatch**: generic-content defaults, owner enablement, egress inventory row (BG-05 server half b)              | 2 days   | —         | none     |
| **B5-12** | Register **and roadmap** reconciliation                                                                                    | 1 day    | —         | none     |

### Order, and why HP-5 sits where it does

**HP-5 gates the steps whose topics it names.** The roadmap says HP-5 reviews
"spam, block bypass, malicious previews, private-address resolution,
redirects, decompression, oversized streams, storage exhaustion, report
confidentiality, moderator privilege, appeal abuse, and notification leakage
**before exposing the endpoints**", and the B4 precedent is exact: roadmap
HP-4 read "**before enabling deletion or retention cleanup**", and B4 put
B4-9/10/11 behind it while B4-1/B4-3/B4-7 shipped in front — because none of
those three was in HP-4's named scope.

So everything HP-5 names goes behind it. **Spam and block bypass are Message
Requests' entire subject matter** (B5-6's first bypass test is "a blocked
sender cannot create a request", and decision 4 is an anti-spam
argument), and NSFW consent is exit condition 3's server half — so **B5-6 and
B5-7 are behind HP-5**, not in front. An earlier draft of this plan put them
in front and argued the point away; that was wrong, and it is recorded here so
the argument is not re-made.

In front of HP-5 sits only work that **exposes no new abuse surface**:
B5-0 (a document), B5-1 and B5-5 (hardening the GIF proxy and the plugin
fetch capability, both already exposed), B5-2 (hardening the already-exposed
upload path), B5-3 (proving a route stays unmounted), and B5-4 — which the
roadmap explicitly sanctions: "Push storage may proceed independently but
dispatch waits for those privacy defaults."

### Two lanes, not six

The first draft claimed six foundation steps could run beside each other. A
touch-set audit refuted it: they collide on five shared files. The honest
shape is **two lanes**.

**Before HP-5:**

| Lane                      | Steps                 | Why it is one lane                                                                                 |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| **A — content & storage** | B5-1 → B5-5, and B5-2 | B5-1 and B5-5 share `safefetch` and the GIF proxy; B5-2 owns the upload path and `maintenanceTick` |
| **B — posture & storage** | B5-3, then B5-4       | Both add config keys and B5-4 adds a service; neither touches lane A's files                       |

**After HP-5:** **B5-6 → B5-7** run serially (B5-7's NSFW gate lands in
`UploadService.Authorize` and `handleServeFile`, and both steps add services
and store methods), the moderation chain **B5-8 → B5-9 → B5-10** runs serially
on `Server/service/moderation.go`, and **B5-11** runs beside the chain.
**B5-12** any time after B5-0.

### Hot files — the real list

The first draft's table named six files and missed the five that actually
matter. These are shared by construction, verified by opening them:

| File / surface                                                                                                        | Who collides                              | Handling                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server/service/service.go` (`Services` struct, `New()`)                                                              | B5-4, B5-6, B5-7, B5-8                    | Every new service joins both. Small, mechanical, but a conflict every time — rebase, don't serialize                                                                                                                 |
| `Server/service/datastore.go` (the 301-line `Store` interface)                                                        | B5-2, B5-4, B5-6, B5-7, B5-8, B5-9, B5-10 | Same                                                                                                                                                                                                                 |
| `Server/api/router.go` (`NewRouter`, the `Mount*Routes` calls)                                                        | B5-3, B5-4, B5-7, B5-8, B5-10, B5-11      | Same — plus B5-3's mount-order constraint below                                                                                                                                                                      |
| `Server/config/config.go` **and its `defaultYAML` template**                                                          | B5-1, B5-2, B5-3, B5-4, B5-11             | Same. See the validation-seam trap: there is no single place to put a range check                                                                                                                                    |
| `Server/internal/app/maintenance.go` (`maintenanceTick`)                                                              | B5-2, B5-4, B5-11                         | **Serialize.** ~76 lines against a `funlen` budget of 100 / 50 statements and `cyclop` 20 — the first arrival probably has to extract it, and the second then inherits a structural conflict on top of a textual one |
| `Server/api/upload_handler.go`, `Server/service/upload.go`                                                            | B5-2 (quota), B5-7 (NSFW attachment gate) | **Serialize** — already separated by HP-5                                                                                                                                                                            |
| `Server/service/message_crud.go`                                                                                      | B5-6 (first contact), B5-7 (read gate)    | **Serialize** — B5-6 then B5-7                                                                                                                                                                                       |
| `Server/service/moderation.go`                                                                                        | B5-8, B5-9, B5-10                         | **Serialize**, strictly                                                                                                                                                                                              |
| `Server/permissions/permissions.go` + `Server/admin/static/index.html` + `Client/src/lib/types.ts` + `docs/schema.md` | B5-9 alone                                | One new bit is **four** edits; `perm_grid_test.go` fails the build if you do only the first                                                                                                                          |
| `Server/invariants/egress_sites.go`                                                                                   | B5-1 (**unconditional**), B5-11           | B5-1 moves the dialing out of `gif_handler.go` and `host_http.go`, which kills two listed rows — `TestEgressAllowIsLive` fails a listed file that _stops_ dialling as loudly as an unlisted one that starts          |

### Generated surfaces serialize too — including three the first draft missed

Migration numbers are reserved in plan order (B5-2 `044`, B5-4 `045`, B5-6
`046`, B5-7 `047`, B5-8 `048`, B5-9 `049`, B5-10 `050`) so the schema steps
need not queue behind each other. But the first draft then claimed migrations
"do not serialize", and that is **false**: they serialize through CI-gated
generated documentation.

| Generated                                                                                                                                                                      | Regenerated from               | Who rewrites it                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------- |
| `Server/db/dbgen/`                                                                                                                                                             | `db/queries/*.sql`, migrations | every schema step                                               |
| `gendocs:schema` in `docs/schema.md` — **one alphabetical index carrying a hard-coded table count**                                                                            | migrations                     | every schema step                                               |
| `gendocs:routes` in `docs/api.md` — **a hard-coded route count**                                                                                                               | `api/router.go`                | every route-adding step                                         |
| `gendocs:config` in `docs/server-configuration.md` — **a hard-coded key count**, and gendocs exits non-zero if a key is undocumented in the hand-written prose above the block | `config/config.go`             | every config-adding step — **twice**: the block, then the prose |
| `Server/ws/message_types.go` + `Client/src/lib/protocolTypes.ts`                                                                                                               | `protocol/schema.json`         | every step with a `yes` in the protocol column                  |

`make docs-verify` and `make protocol-verify` are hard CI steps
(`.github/workflows/ci.yml:68-77`). **The rule for all five is identical:**
the last action before every push is rebase on `dev`, re-run the generator,
re-run `ci-check`. Never resolve a generated conflict by hand.

**Every step:** branch from `dev`, one PR per step, squash merge with a
conventional subject, verify with the `ci-check` skill before pushing,
migrations only through the `db-change` skill, protocol changes only through
the `protocol-change` skill, and append a dated evidence block to this plan in
the step's own PR. `dev` is `strict: true`. Steps that HP-5 or the exit
reviews for commit structure record their pre-squash `refs/pull/<n>/head` SHA
at merge time (pattern rule 3).

## Entry gate

The roadmap lists three conditions. **Two are met; the third is not evidenced
and opens as B5-0**, the B3-0 / B4-0 precedent.

| Condition                                                               | State 2026-09-04                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4 identity, audit, deletion, retention, and session behavior is stable | **Met.** B4's exit was accepted by the owner on 2026-09-03 (PR #1528, `dev` `0a14554`); the "B4 exit" section of [hp-4-scorecard-2026-09-02.md](hp-4-scorecard-2026-09-02.md) records the seven roadmap conditions and pattern rule 2 met, with the gates re-run on the exit SHA.                                                                    |
| Canonical permission predicates and bounded-work primitives exist       | **Met, on the primitives — not on the invariants.** `Server/permissions/` holds `predicates.go` and `checker.go` with unit, fuzz and user-override suites (B2-5, PR #1440). Two runtime bounded-work primitives exist and run by default: `auth.AdmissionBudget` (B4-4) and `ws.TopicRateLimiter`. See the evidence block for what does _not_ count. |
| Abuse cases and data ownership for each service are documented          | **Not evidenced.** No repository document models abuse of, or names the data owner for, message requests, external retrieval, uploads and quota, reports, moderator actions, appeals, or push. **B5-0 closes this item.**                                                                                                                            |
| _(context)_ `dev` is at or past B4's exit commit                        | **Met.** `git merge-base --is-ancestor 0a14554 HEAD` exits 0 on `dev`; `e1781086` is three CI-gate commits past it (#1535, #1536, #1537 — none touching a B5 surface).                                                                                                                                                                               |

**Entry evidence, 2026-09-04, measured at `e1781086`:**

- **B4 stability (item 1).** The thirteen B4 steps (B4-0..B4-12) plus HP-4 and
  the exit are all merged, and every B4-tagged `OC-*` row is `fixed` in the
  ledger. The services B5 builds on are live: erasure
  (`Server/service/erasure.go`, `Server/db/erasure.go`), deletion markers
  (`data/erasure/markers.sqlite`, replayed on every start-up), retention with
  its restart-safe sweep on the maintenance tick
  (`Server/internal/app/maintenance.go`, `migrations/039_retention.sql`), the
  actor-token audit rows (`migrations/041`/`042`), and the session contracts.
  The rollback set exists too: `Server/rollback/` holds one reversal per
  migration, rehearsed forward and back by
  `TestMigrationRollbackRehearsalOnAlphaSnapshot`. **B5 inherits that
  obligation** — each of B5's seven migrations owes a rehearsed reversal.
- **Predicates and bounded work (item 2).** Canonical predicates:
  `Server/permissions/predicates.go` and `checker.go`, with
  `predicates_test.go`, `predicates_fuzz_test.go`, `permissions_fuzz_test.go`,
  `checker_test.go` and `user_override_test.go`; the effective-permission
  decision is one code path, and `Server/invariants/authz_chokepoint.go` is
  the standing rule that keeps it one. Bounded-work primitives — the two that
  are real and run: B4-4's atomic admission budget
  (`Server/auth/ratelimit.go`, `security.expensive_auth_concurrency`, default
  twice the core count) and `Server/ws/topic_rate_limiter.go`.
  **Do not credit `Server/invariants/` here.** Its five rules
  (`invariants.go`, `var Rules`) are all `go/ast` source rules over mutex
  types, source line counts, import layering, the authz chokepoint and the
  egress inventory. Not one checks a runtime work bound. Neither primitive is
  a **byte** budget — B5-1 builds that, which is the point of workstream 11.
- **Abuse cases and data ownership (item 3).** At the base commit `e1781086`,
  `grep -rlie 'abuse case|abuse-case|data ownership|data owner' docs/`
  returned three files, all of them planning documents that _use_ the phrase
  (this roadmap, the traceability matrix and the B4 plan) — none is such a
  model. (On this branch it returns five: the README row and this plan add
  themselves. Re-run it against `e1781086`, or the measurement includes its
  own report.) `docs/architecture/` holds `data-lifecycle.md` (B4-0) and
  `diagnostics.md` (B4-8), which are the right shape but cover B4's data
  classes only — message requests, reports, appeals, moderation actions, push
  subscriptions and preview cache entries appear in neither.
  `docs/trust-model.md` discloses operator powers and carries the C-09
  preview-destination contract, but is a disclosure, not an abuse model.
  **Not met; B5-0 is the closure**, and its output is what HP-5 reviews
  against.

## Verify before you implement

Every claim the roadmap's B5 section rests on, re-tested against `e1781086`.
Verdicts a step depends on are repeated in that step's spec. **Refutations are
the point of this section** — read them before writing code.

| Claim                                                                            | Verdict                                                        | What it means for the work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The fifteen B5-tagged register rows gate the exit (pattern rule 2)               | **Refuted in part**                                            | The list is right — `OC-0323, OC-0327, OC-0349, OC-0351, OC-0357, SEC-02, SEC-03, S-03, BG-01, BG-05, BG-12, BG-13, BG-14, BG-18, BG-19` — but **all five `OC-*` rows are already `fixed` in `.superpowers/findings-ledger.json`**, closed by the B3-8/B3-9 batches. Rule 2 names `OC-*` findings, so **rule 2 is satisfied at the base commit.** B5-12 records that instead of re-fixing anything.                                                                                                                                                                                                                                                                            |
| **SEC-04 is not a B5 concern**                                                   | **Refuted — the registers disagree with each other**           | `repo-health-issue-register-2026-08-23.md:195` carries SEC-04, P1, confirmed: "Durable per-user/server storage quotas and disk headroom… low-disk behavior fails safely and is exercised by restart/concurrency tests" — **B5-2's deliverable and B5 exit condition 5, word for word**. It is tagged **B3/B6**, and the B4 plan's out-of-scope list, `hp-2-scorecard-2026-08-29.md:430` and `b2-protocol-trust-compat-2026-08-28.md:849,886` all call it B6's. It also carries an unfilled advisory ID (`GHSA-____-____-____`), which collides with exit condition 7. Owner decision 12.                                                                                       |
| Workstream 2 — "retain and polish the existing link-preview … set" (server work) | **Refuted — it is client code**                                | Link previews and Open Graph fetching live in `Client/src/components/message-list/embeds.ts` and fetch third-party hosts **directly from the renderer** via `@tauri-apps/plugin-http`; `media.ts` and `attachments.ts` do the same for inline media. Grep for `Embed`/`embed_` across `service/ api/ ws/ db/` returns only `embed.FS` and `go:embed`. There is no server-side preview set to retain. B5-5 shrinks to the inventory, S-03, and B5-1's boundary.                                                                                                                                                                                                                 |
| Workstream 11 / SEC-03 — bounded preview/media reads, in B5                      | **Confirmed, split-phase — and the two sources already agree** | `docs/trust-model.md:252` says C-09's "implementation B7", and its eight clauses describe a **native fetch broker in the desktop client**. The roadmap does not contradict that: item 11 says "implement the byte accounting once, **at the boundary B7's native broker will own**". So decision 1 is a **confirmation of scope, not a blocking contradiction**, and does not gate B5-1's start. What it gates is the honest wording of exit condition 2.                                                                                                                                                                                                                      |
| Today's desktop external-fetch posture is capability-scope-only                  | **Confirmed**                                                  | `Client/src-tauri/capabilities/default.json` allows `http:allow-fetch` to `https://*:*`, `https://*` and `http://127.0.0.1:*`. A URL-pattern control, not a DNS control: no address classification, no redirect policy, no byte ceiling, no content-type list, no concurrency cap.                                                                                                                                                                                                                                                                                                                                                                                             |
| The server has **one** outbound content path                                     | **Refuted — there are two**                                    | `Server/api/gif_handler.go` fetches `gifAPIBase = "https://api.klipy.com/v2"`, a **hard-coded constant**, already address-guarded via `plugin.GuardedDialContext()`, redirect-refusing, 10 s-bounded and 2 MiB-limited. The **second** is `Server/plugin/host_http.go` `(*Registry).HTTPDo` — an arbitrary plugin-supplied URL, any method, any body, guarded only by an operator host allowlist, following up to five redirects, 5 MiB body cap. Both are in `egress_sites.go` beside nine fixed-destination paths. B5-1 must cover both.                                                                                                                                     |
| `ipAllowed` is a complete non-global address classifier                          | **Refuted**                                                    | `Server/plugin/host_http.go:227-250` rejects loopback, private, link-local, unspecified, multicast and carrier-grade NAT, and **does not** reject the documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`), the benchmarking range (`198.18.0.0/15`) or the other reserved non-global blocks. `docs/trust-model.md` already says so.                                                                                                                                                                                                                                                                                                    |
| **Message Requests' gate point is `CreateDM`**                                   | **Refuted — and this one would have shipped broken**           | `CreateDM` is not where first contact happens on the recipient's side. `MessageService.SendMessage` calls `s.st.OpenDM(...)` per participant and accumulates `result.OpenedDMFor` (`Server/service/message_crud.go:265-285`), which `Server/ws/handlers_chat.go:96` turns into a `DMChannelOpenEvent` and which bumps the hub's global visibility watermark. **A gate confined to `service/dm.go` is bypassed by the sender's first message** — the actual event Message Requests exists to intercept. B5-6's real home is `message_crud.go`.                                                                                                                                  |
| Blocks exist and are enforced in the transport                                   | **Confirmed in the service, not the transport**                | `auth.IsEffectivelyBanned` at `Server/service/dm.go:126` and `IsEitherBlocked` → `ErrForbidden` at `:130-136`, both inside `CreateDM`. `api/dm_handler.go` is an adapter; its block references are the block/unblock routes. Put new gates beside the existing two, in the service.                                                                                                                                                                                                                                                                                                                                                                                            |
| Workstream 5 — NSFW must be enforced server-side                                 | **Confirmed — flag only, and the gate is not one place**       | `migrations/025_channel_nsfw.sql` stores the flag. `db/admin_queries.go:163` says "stored and broadcast only; it drives no server-side content behaviour"; `admin/handlers_channels.go:124` says "stored, broadcast **and audited**" — the audit is real (`service/channel_admin.go:243-253`). There is no acknowledgement storage and no read gate. See B5-7 for the four independent leak paths; this is why its size went from 2 days to 6–8.                                                                                                                                                                                                                               |
| Workstream 4 — durable quotas must be built                                      | **Confirmed in part — half already exists**                    | **Present:** `Server/diskutil/` probes real free space on every platform (`free_unix.go` `syscall.Statfs`, `free_windows.go` `GetDiskFreeSpaceExW`); `api/router.go:483-486` already enforces a reserved-headroom floor (`healthMinFreeDiskBytes = 256 << 20`, `"degraded","disk"` below it); `api/metrics_handler.go` publishes `disk_free_mb`; `internal/app/banner.go:74-92` warns at 1 GiB and errors at 256 MiB. **Absent:** any durable per-user byte counter, and any headroom check **on the upload path** (`api/upload_handler.go:167-183` has only `upload.max_size_mb`, the BUG-131 rate limit and a `MaxBytesReader`).                                             |
| An attachment-row byte counter is a sufficient quota                             | **Refuted — evadable, and not transactional today**            | `(*DB).CreateAttachment` (`db/attachment_queries.go:37`) is a bare non-transactional insert, so "maintained transactionally with the attachment rows" means converting a hot write path, not adding to it — and the decrement half lands in `DeleteOrphanedAttachments` (`:208`), `service/erasure.go` and `service/retention.go`. Worse, **emoji uploads write to the same `FileStore` with no attachment row** (`api/emoji_handler.go:150` `store.Save`, `svc.Emoji.Create`), and avatars are exempted by `IsAvatarFileURL`. A counter hung off attachment rows is evadable by uploading emoji. Count at the `FileStore` boundary, or declare the exclusions and bound them. |
| Workstream 6 — report intake must be built                                       | **Confirmed — greenfield**                                     | Zero hits for `moderation_report` or a reports table in any migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **BPR-071 is wholly a client requirement**                                       | **Refuted**                                                    | The traceability matrix assigns BPR-071's **primary phase as B5** (`:35`, `:124`), and its evidence column has a server half: "**Service tests** cover queue, evidence/context, assignment, status, notes, action links, immutable history, retention, and **deletion unlinking**". Only the Moderation Center UI is B9. B5-8 closes the service half, deletion unlinking included.                                                                                                                                                                                                                                                                                            |
| Workstream 7 — warning, timeout, removal, kick, ban                              | **Confirmed, and uneven**                                      | **Ban exists**: `BanUser` checks `BAN_MEMBERS`, verifies existence, refuses self-ban, enforces `requireOutranks`, and takes `expires *time.Time`. **Content removal exists** (`service/message_purge.go`). **Kick exists under another name**: `KICK_MEMBERS` gates admin force-logout (`admin/api.go:46`, `TestForceLogout_RequiresKickMembers`). **Warning and timeout have no implementation.** But "no permission bit covers them" is **wrong for the voice half**: `MUTE_MEMBERS` (bit 20) already gates durable server mute/deafen (`ws/voice_moderation.go:65`, `predicates.go:156-166`, `migrations/021`). Owner decision 5.                                           |
| A permission bit is available for the new moderator authority                    | **Confirmed, but documented as reserved and costs four edits** | Used bits (`permissions.go:9-27`): 0, 1, 5, 6, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 24, 25, 26, 27, 30. **Bit 22 (`0x400000`) is unused** repo-wide. Two catches: `docs/schema.md:926` lists bits "13-15, **22-23**, 28-29, 31" as **reserved**, so taking 22 changes a published contract; and `Server/admin/perm_grid_test.go:50-59` fails the build unless the bit also reaches `PERM_GROUPS` in `Server/admin/static/index.html`, `Client/src/lib/types.ts`, and `docs/schema.md`'s bit map.                                                                                                                                                                             |
| Workstream 8 — appeals must be built                                             | **Confirmed — greenfield**                                     | Zero hits for `appeal` in `Server/`. Rate-limiting primitives exist in `api/middleware.go` and `ws/topic_rate_limiter.go`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Workstream 10 (automation optional, human authority core) is a no-op**         | **Refuted**                                                    | The repo ships a plugin host with `chat_command` dispatch, `plugin_broadcast` and `host_http`, and `internal/app/hub.go:75-79` wires `pluginRegistry.Sink().SetBroadcaster(hub.BroadcastToChannel)` so plugins receive message payloads. With B5-9 adding moderation actions and a permission bit, the testable half — no plugin capability can take a moderation action, and every action carries a human actor token — is real work. B5-9 owns it.                                                                                                                                                                                                                           |
| Workstream 9 — Web Push must be built, "no OwnCord relay"                        | **Confirmed, with a collision**                                | Zero hits for `webpush`, `web_push` or `vapid`. The collision: dispatch opens outbound connections to whatever push service each subscription names, and B4-8's `egress-sites` invariant fails any production file that dials and is not inventoried, with every existing row manual, config-gated or loopback. Owner decision 8.                                                                                                                                                                                                                                                                                                                                              |
| SEC-02's remaining half is B5 work                                               | **Refuted — mis-citation**                                     | The register says SEC-02 is `resolved/superseded`, its server half landed in B2-5 (PR #1440), and the remainder is "UI half only… **(B5 item 11)**". B5 item 11 is the SEC-03 bounded-reads item, unrelated. The remaining half is a client surface (B9). B5-12 corrects it.                                                                                                                                                                                                                                                                                                                                                                                                   |
| BG-12 (retention + attachment cleanup) still has a B5 share                      | **Confirmed, but small**                                       | B4-11 delivered the server half. B5's share is that **each new data class B5 adds** declares its retention and deletion behaviour — B5-0's lifecycle table plus a per-step integration test, not a step of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| BG-01 (optional server-hosted browser client) is partly B5                       | **Confirmed — posture only**                                   | The server hosts no browser client; the only `http.FileServer` is the admin panel from an `embed.FS` (`admin/admin.go:60`). `plugin/host_ui.go:58` `AssetHandler` is never mounted in production. BG-01's first two clauses are a server security posture and belong in B5; "enabled mode passes upgrade/security smoke" needs a browser build and is B8. Owner decision 9.                                                                                                                                                                                                                                                                                                    |
| S-03 (channel name/topic/category rune contract) is open                         | **Confirmed**                                                  | Register row 229, P2, `confirmed`, tagged B3/B5; B3 did not close it. Small shared-validation fix; rides B5-5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Epoch-1 protocol fixtures constrain B5-6                                         | **Refuted — and that is a warning, not a relief**              | `dm-send.json` replays through `r.db.GetOrCreateDMChannel` (`ws/protocol_epoch1_contract_test.go:926`), **below** the service layer, so a service-level first-contact gate will not break the fixture. Which means the fixture **proves nothing** about the gate — B5-6 owes its own coverage and must not read a green fixture as evidence.                                                                                                                                                                                                                                                                                                                                   |

**Net effect.** B5 is smaller in defect-fixing than the tag list suggests (all
five `OC-*` rows are closed) and larger in greenfield service work than
"retain and polish" implies. Workstreams 1, 6, 8 and 9 are greenfield;
workstream 5 is a four-path enforcement problem behind a flag that today does
nothing; workstream 4 is half-built and its counting point is wrong in the
obvious design; workstream 2 is client code; workstream 10 is an absence
proof, not a no-op; workstream 3/11 splits across B5 and B7; and entry-gate
item 3 is honest new work.

## Decisions — settled 2026-09-04

The owner delegated all fourteen ("you are in charge of picking the best
ones"), so each is settled here rather than left open, and **no step is
blocked on a decision any more**. Thirteen are the proposal as drafted; **7
was strengthened** on review and is marked. Each records what was chosen and
why, so a later reader can overturn one on its reasoning rather than
rediscovering the question.

**Two items remain genuinely the owner's, and neither is due yet** — they are
actions, not decisions: filling SEC-04's advisory ID (decision 12; needed at
the exit, and the same shape as SEC-01's row in B4), and signing HP-5's
scorecard, which carries the exit-condition acceptance in decision 14.

1. **SEC-03 / C-09 phase split.** **Settled: split, as drafted.** B5 builds
   the server boundary (`Server/safefetch`: parse, resolve, classify,
   connect-to-validated-address, no-automatic-redirect, time/byte/type
   ceilings), adopted by the GIF proxy and `plugin/host_http.go`. C-09 clauses
   1, 7 and 8 — the desktop native broker owning renderer fetches, returning a
   typed minimum, and narrowing the `https://*` capability — stay **B7**.
   _Why:_ this is not a real fork. `docs/trust-model.md:252` and roadmap item
   11 already say the same thing in different words; the split was written
   down before this plan existed. **Consequence accepted:** exit condition 2
   is met for server-side fetch paths only (decision 14).
2. **How much of SEC-03's aggregate machinery is B5's.** **Settled: the
   per-fetch policy only.** B5-1 ships the classifier extension, content-type
   allowlist, streaming byte ceiling, redirect policy and per-process
   concurrency cap. **Aggregate cross-caller budgets and byte-weighted cache
   eviction defer to B7**, with the interface shaped so B7 adds them without a
   rewrite. _Why:_ the server's outbound surface is one hard-coded host plus a
   default-empty operator allowlist — there is close to nothing to aggregate,
   and the consumer that needs it is B7's broker. Building it here would be
   machinery with no load and no test that could fail honestly. B5-1 is 3 days
   because of this.
3. **Link previews do not move server-side.** **Settled: no.** Previews stay
   client-fetched, through B7's broker. _Why:_ a server-side unfurl proxy
   makes the server fetch attacker-chosen URLs on every message containing a
   link — new SSRF and amplification surface, and a reversal of the "your
   server does not phone home" property B4-8 proved and locked with
   `egress-sites`. **The trade-off is real and is accepted knowingly:**
   client-side fetching exposes the _viewer's_ IP to the linked host, which is
   what C-09's broker exists to bound. Server-side would move that exposure to
   the operator instead. OwnCord is self-hosted, so the operator is often one
   person and their IP is already the server's — the trade does not buy what
   it costs. GIF search stays server-proxied because it already is, and its
   upstream host is a constant.
4. **Message Requests scope.** **Settled as drafted.** One-to-one DMs only;
   group-DM invitations out of beta scope. A request is created on the first
   message from a sender with no trusted-sender row — **at
   `service/message_crud.go`'s `OpenDM` accumulation, not `CreateDM`**. States
   `pending / accepted / ignored / deleted / blocked`. "Safely previewed"
   means the recipient sees the sender's profile and the message text with all
   automatic media, embed and preview fetching suppressed. Acceptance writes
   the trusted-sender row. Existing DM pairs are grandfathered as trusted at
   migration `046`, so no live conversation breaks on upgrade.
5. **Ignoring or deleting a request tells the sender nothing.** **Settled:
   silent.** The sender sees "sent" in every state, and the three states are
   byte-identical from the sender's side. _Why:_ a distinguishable rejection
   turns the inbox into an oracle for probing which accounts exist, which are
   live, and which recipients respond — the exact spam-reconnaissance loop
   HP-5 reviews. Silence costs the sender nothing they are entitled to.
6. **Warning, timeout and kick.** **Settled as drafted, and one new bit is
   justified.** _Warning_ = an audited notice the user must acknowledge on
   next connect. _Timeout_ = a time-boxed restriction row (cannot send, react,
   or connect to voice) distinct from a ban, reusing `BanUser`'s existing
   `expires` shape. _Kick_ keeps its current meaning — force-logout, already
   gated by `KICK_MEMBERS` — and is documented rather than reinvented, because
   OwnCord is single-server and "remove from guild" has no referent.
   - **The overlap with `MUTE_MEMBERS` (bit 20):** timeout's voice half
     **defers to `MUTE_MEMBERS`**. A timeout suppresses text and reactions
     directly and reuses the existing server-mute mechanism for voice rather
     than adding a second path to the same effect.
   - **Why a new bit at all, given `BAN_MEMBERS` already exists:** BPR-072
     requires actions "according to **narrowly assigned** role permissions".
     Gating a gentle warning on the ability to ban inverts the moderation
     ladder — the mildest action would need the heaviest permission. One new
     `MODERATE_MEMBERS` bit (22, `0x400000`, unused repo-wide) covers warning
     and timeout, granted to the Moderator role by default.
   - **`docs/schema.md:926` lists bits 22-23 as reserved.** Taking 22 is
     exactly what "reserved" is for; B5-9 updates that line as part of its
     four-file edit.
7. **Report evidence versus B4-9 erasure. _(Strengthened — this is not what
   was originally proposed.)_** **Settled: erase the content, keep an
   unlinkable outcome row.** The original proposal erased the report whole,
   which is safe for B4 but hands a bad actor a clean exit: report someone,
   they erase their account, and every trace that the report existed goes with
   it. B4-10 already solved this shape for audit — it keeps action, time and
   order with the marker's token in place of the id. Apply the same pattern:
   - the evidence snapshot's **content** is hard-deleted with the account,
     like every other class, so B4-9's signed exit condition holds;
   - the report's **outcome row survives as an unlinkable audit row** —
     action, time, order, marker token, no content and no identity;
   - the open report closes as `subject_erased`.
     _Why the change:_ it costs nothing against B4 (the surviving row is
     already the shape B4-10 blessed) and it closes an abuse path the original
     answer left open. B5-8 owes a test for both halves.
8. **Appeal rate limit and repeat policy.** **Settled as drafted.** One open
   appeal per moderation action; a decided appeal cannot be re-appealed; a
   per-user rolling-window cap on submissions; a blocked or erased appellant
   submits nothing. The moderator who took the action may not decide its
   appeal where another eligible moderator exists.
9. **Web Push dispatch and the `egress-sites` invariant.** **Settled as
   drafted.** Dispatch ships **off by default**, gated on an owner-set
   configuration key, and is added to `Server/invariants/egress_sites.go` as a
   `config`-triggered row with the destination recorded as "the push service
   named in each stored subscription endpoint". `TestNoAutomaticTelemetry_Capture`
   stays green on compiled defaults, because the default is off. _Why not
   simply skip the inventory row:_ B4-8's invariant is the machine-checked
   form of "no automatic telemetry"; routing around it would make the claim
   untrue and the gate a formality.
10. **BG-01's B5 share.** **Settled: posture in B5, build in B8.** An owner
    opt-in key, default off, with a test proving that in the disabled state no
    app route is mounted and no asset is served. The browser build and its
    enabled-mode upgrade and security smoke are B8, which also inherits the
    mount-order, CSP and build-order constraints B5-3 records. _Why:_ a
    disabled-by-default hosting surface is a security property, and it is
    far cheaper to prove before the assets exist than after.
11. **Storage quota shape, counting point and defaults.** **Settled as
    drafted, including the counting point.** Count at the **`FileStore`
    boundary**, not at the attachment row, so emoji and avatar writes cannot
    evade the quota. A per-user total-bytes quota plus a server-wide
    reserved-headroom floor; an upload crossing either is refused with `507`
    and a distinct error code; the maintenance sweep reconciles on erasure and
    retention. **Defaults:** per-user quota **unlimited**, so no existing
    install changes behaviour on upgrade — an operator who wants a cap sets
    one. **Headroom mints no third constant:** promote
    `banner.go`'s 256 MiB critical value to a configuration key with that
    default, shared by the health check (`api/router.go:483-486`), the
    start-up banner and the upload path, so the three can never disagree about
    what "low disk" means. Pressure is already `disk_free_mb` on the metrics
    surface — extend it, do not add an endpoint.
12. **SEC-04 belongs to B5.** **Settled: build it in B5-2 and re-tag SEC-04
    from `B3/B6` to `B3/B5`.** _Why:_ B5's exit condition 5 restates SEC-04's
    closure line word for word. A phase cannot honestly claim a condition
    while the work that satisfies it sits in a later phase, so either the
    condition moves or the work does — and moving the work is the smaller,
    truer change. The alternative (drop B5-2 to B6) would need exit condition
    5 reworded, which is a roadmap amendment for no gain. **Owner action, not
    due until the exit:** SEC-04's advisory ID (`GHSA-____-____-____`) must be
    filled or the row closed, because exit condition 7 is "no unresolved B5
    security advisory remains" — the same shape as SEC-01's row in B4.
13. **NSFW acknowledgement storage and revocation.** **Settled as drafted.**
    One row per user per channel, server-side, so a new device inherits the
    acknowledgement without re-prompting. Message, attachment, search and
    socket delivery on a labelled channel carry no content until the row
    exists. The user may revoke, which deletes the row and takes effect on the
    next read. A moderator viewing reported content acknowledges like anyone
    else. The row is a B5 data class and follows decision 7's erasure rule.
14. **The two narrowed exit conditions.** **Settled as the plan's position;
    the signature is still owed at HP-5.** Conditions 2 and 3 are met at the
    server only, with the client halves owed by B7 and B9 respectively, and
    **both carry the same standard** — the first draft narrowed 3 silently
    while caveating 2, which was the inconsistency worth fixing. B5-12 re-tags
    BG-18 and BG-19 in the register to record where the remaining halves live,
    following B4's precedent of pairing a narrowed condition with a re-tagged
    row. _What is left for the owner:_ HP-5's scorecard carries the acceptance
    line, and a hold-point signature is not something a plan can grant itself.

## B5-0 — Abuse cases and data ownership for every B5 service

**Closes:** entry-gate item 3. **Input to:** HP-5, and to every step's
retention and erasure obligations. **Size:** 2 days. **Protocol effects:**
none. **Parallel with:** everything — documentation, no production code.

**Deliverable:** `docs/architecture/community-services.md`, in the shape
B4-0's [data-lifecycle.md](../architecture/data-lifecycle.md) established,
covering the seven services B5 adds or changes:

1. Message Requests and trusted-sender relationships
2. External content retrieval (server-side, and the desktop path B7 will own)
3. Uploads, quotas and reserved headroom
4. NSFW labelling and acknowledgement
5. Report intake, the queue, and evidence snapshots
6. Moderator actions and appeals
7. Web Push subscriptions and dispatch

For each service, three tables:

- **Abuse cases** — the adversary, the goal, the mechanism, the control, and
  where the control is tested. At minimum HP-5's twelve names: spam, block
  bypass, malicious previews, private-address resolution, redirects,
  decompression, oversized streams, storage exhaustion, report
  confidentiality, moderator privilege, appeal abuse and notification leakage.
  Each row cites a test path or is marked as owed by a named step.
- **Data ownership** — for every new data class: who may read it, who may
  write it, who may delete it, what the subject can see of it, whether the
  operator can see it, and where it appears in a backup.
- **Lifecycle** — the class's retention default, its behaviour under B4-9
  erasure and B4-10 markers, and its behaviour under B4-11 retention sweeps.
  This is BG-12's whole B5 share, so the table is what closes it — but the
  roadmap asks for **integration tests**, not a table, so each step also owes
  one (see the exit gate).

**Also in this step:** a short "what B5 does not defend against" section, so
HP-5 reviews an honest boundary. Any advisory-worthy abuse case follows B4-0's
precedent — counted here, described in a GitHub Security Advisory, never in
the repository (`docs/security.md`).

**Acceptance:** the document exists; every B5 workstream appears in all three
tables; every "tested at" cell either cites a path that exists at HEAD or
names the step that owes it; and a doc gate keeps the class list in step with
the migrations B5 adds (the row-locking pattern from #1536 — run it with
`-count=1`, because Go's test cache does not track files outside the `Server`
module).

## B5-1 — `Server/safefetch`: one bounded server outbound-content boundary

**Closes:** SEC-03's server half; BPR-062's server half. **Decisions:** decisions 1, 2 and 3 — settled. **Size:** 3 days. **Protocol effects:** none.
**Migration:** none. **Lane A**, first.  
**Owns:** `Server/safefetch/`, `Server/api/gif_handler.go`,
`Server/plugin/host_http.go`, **and `Server/invariants/egress_sites.go`
unconditionally** — see below.

**Verified premises — there are TWO paths here, not one.**

1. `Server/api/gif_handler.go` fetches `gifAPIBase = "https://api.klipy.com/v2"`,
   a **hard-coded constant**. It already has address classification via
   `plugin.GuardedDialContext()`, refuses redirects with `ErrUseLastResponse`,
   a 10 s total `Timeout`, and a 2 MiB `io.LimitReader` on decode. It returns
   upstream `media_formats.*.url` values verbatim — **the client fetches the
   actual media**, which is why exit condition 2 is narrow (decision 1).
2. `Server/plugin/host_http.go` `(*Registry).HTTPDo` — **an arbitrary
   plugin-supplied URL**, any method, any body, guarded only by an operator
   host allowlist that defaults to empty, following up to five redirects, with
   a 5 MiB body cap. The wider of the two, and easy to miss because the word
   "preview" appears nowhere in it.

`ipAllowed` (`host_http.go:227-250`) misses the documentation, benchmarking
and other reserved non-global ranges. Neither path has a content-type
allowlist or cache accounting.

**Build** — the per-fetch policy, once: URL parse with a scheme and port
allowlist and no embedded credentials; resolution of every A and AAAA answer
with IPv4-mapped normalisation; rejection if **any** address is non-global,
extending `ipAllowed` with the documentation ranges (`192.0.2.0/24`,
`198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`), the benchmarking range
(`198.18.0.0/15`) and the remaining reserved blocks; connection only to the
validated addresses with the hostname kept for SNI and certificate validation,
and no second unconstrained lookup; automatic redirects disabled, with at most
a small fixed number followed by hand re-running the whole check and rejecting
scheme downgrades; a total deadline; a **streaming** byte ceiling enforced
while reading (a `Content-Length` header is not a limit); a decompressed-size
ceiling; a content-type allowlist checked against the **sniffed** type, not
only the declared one; and a per-process concurrency cap.

**Deliberately deferred to B7** (decision 2): aggregate cross-caller
byte budgets and byte-weighted cache eviction. The server's outbound surface
is one hard-coded host plus a default-empty allowlist — there is almost
nothing to aggregate, and the broker that needs it is B7's. Shape the
interface so B7 adds them without a rewrite, and say so in the package doc.

**The egress edit is mandatory, not conditional.** `EgressAllow` lists
`api/gif_handler.go` with sites `["(file scope)", "fetchGIFs"]` and
`plugin/host_http.go` with `["(*Registry).HTTPDo", "(file scope)"]`. Moving
the dialing into `Server/safefetch/` kills both rows, and
`TestEgressAllowIsLive` fails a listed file that **stops** dialling as loudly
as an unlisted one that starts.

**Acceptance:** adversarial tests for names resolving into each blocked class,
a public name redirecting to a private target, mixed answer sets, CNAME
chains, an address that changes between validation and connect, a lying
`Content-Length`, a decompression bomb, a slow-loris body, a redirect loop, a
scheme downgrade, a **sniffed type disagreeing with the declared type**, and
the concurrency cap under `-race`; plus **cancellation, residual buffering
(no full body reaches memory before the ceiling is applied), and offline
behaviour** — the three BPR-062 names the first draft omitted. Cache
partition and expiry are **not** in scope here and are recorded as B7's,
because this boundary fills no cache.

**Evidence, 2026-09-04** — branch `feature/b5-1-safefetch` from `dev`
`cbebd37c`; PR to `dev` #PR_NUMBER (draft). Both premises were re-verified at
that base before any code was written, and both held: `gif_handler.go` had
`GuardedDialContext`, `ErrUseLastResponse`, a 10 s `Timeout` and a 2 MiB
`LimitReader` on decode; `(*Registry).HTTPDo` took an arbitrary
plugin-supplied URL with any method and body, guarded only by the
default-empty operator host allowlist, following five redirects under a 5 MiB
cap.

- **The package.** `Server/safefetch` — `doc.go`, `policy.go`, `errors.go`,
  `classify.go`, `destination.go`, `fetch.go`, `body.go`. One `Fetcher` per
  call site, built from a `Policy` that `New` refuses when any ceiling is
  missing, so a call site cannot end up unbounded by omission. Per hop, in
  order, before a packet leaves: scheme and port allowlists; no embedded
  credentials; every A and AAAA answer resolved and classified with
  IPv4-mapped normalisation, refusing if **any** is non-global; the connect
  bound to exactly those addresses, carried on the request context, with the
  hostname kept for SNI and no second lookup — a dial that arrives without
  them, or for a host they do not name, fails closed. Automatic redirects are
  off (`http.ErrUseLastResponse`); hops are followed by hand, re-running the
  whole check, refusing scheme downgrades and dropping credential headers
  across an origin (scheme+host+**port**, stricter than net/http's
  hostname-only rule). One total deadline covers connect through last byte.
  Two independent byte ceilings are enforced while reading — one before
  decompression, one after — and an encoding that is neither gzip nor
  identity, or a doubled `Content-Encoding` header, is refused rather than
  returned as opaque bytes. The media type is checked as declared **and** as
  sniffed from the bytes received. Concurrency is capped twice: per Fetcher,
  and once for the process, so more Fetchers do not buy more sockets.
- **Classifier.** `ClassifyAddr` adds what `ipAllowed` missed: the
  documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
  `2001:db8::/32`, `3fff::/20`), benchmarking (`198.18.0.0/15`, and IPv6
  benchmarking inside `2001::/23`), and `0.0.0.0/8`, `192.0.0.0/24`,
  `192.88.99.0/24`, `240.0.0.0/4`, `2001:20::/28`, `2002::/16`,
  `64:ff9b:1::/48`, `100::/64`, `5f00::/16`. `TestIPAllowedAcceptsPublic`
  asserted `203.0.113.5` was **allowed**; that assertion was wrong and is
  gone with the function it tested.
- **Adoption 1 — the GIF proxy.** `gifClient` is replaced by a `Fetcher`:
  https on 443 only, zero redirects (the upstream host is a constant), the
  same 10 s deadline, 2 MiB on the wire and after inflation, JSON-only
  content types, 8 concurrent. `fetchGIFs` unmarshals a body that is already
  bounded and typed. The test seam swaps the Fetcher, not an `http.Client`,
  and relaxes exactly two things — loopback and the stub's scheme/port —
  keeping every ceiling. Four `api`-level cases prove the boundary is in the
  handler's path and not only in the package: a 64 MiB upstream body becomes
  a 502 with the upstream cut off long before it finishes writing, an HTML
  page declared as JSON becomes a 502, a 302 is not followed (the upstream
  sees exactly one request), and the **production** Fetcher — pointed at the
  loopback stub with only the base URL swapped — refuses it.
- **Adoption 2 — the plugin `http` capability.** `HTTPDo` keeps the operator
  allowlist and hands everything else to the same package. The allowlist now
  rides `Request.AllowHost`, so it is re-checked on **every** hop rather than
  only on the URL the plugin supplied, and `ErrHTTPHostDenied` stays the
  sentinel callers test for. `ipAllowed`, `GuardedDialContext`,
  `lookupIPAddr` and `dialContext` are deleted; their coverage moved to
  `Server/safefetch` and to four new `TestHTTPDo_*` cases. Three deliberate
  tightenings on this path: a port other than 80 or 443, embedded credentials
  in the URL, and a media type outside a fixed list are all refused now and
  none was checked before. Blast radius today is nil — `plugins.enabled`
  defaults false, the allowlist defaults empty, and no wazero host import is
  wired, so no guest code can reach `HTTPDo` at all.
- **The egress edit, as predicted.** Removing the dialing left
  `api/gif_handler.go` and `plugin/host_http.go` with zero outbound
  constructs, and `TestEgressAllowIsLive` failed both rows exactly as this
  step said it would. Both are dropped and replaced by `safefetch/policy.go`
  (`New`, `defaultDial`) and `safefetch/fetch.go` (`(*Fetcher).roundTrip`);
  `docs/architecture/diagnostics.md`'s prose table is in step. The callers'
  gates did not move, so the compiled defaults still reach nowhere.
- **Acceptance, all of it.** 47 tests in `Server/safefetch`, green under
  `-race`: every blocked class by name including IPv4-mapped forms; a
  reachable host redirecting to a blocked target, asserting the hop was
  refused by re-validation and not merely by the dial binding; mixed answer
  sets; CNAME chains judged on the final answer with exactly one lookup; an
  address that changes between validation and connect (one lookup, and the
  dial goes to the validated address); a lying `Content-Length` (a hijacked
  connection declaring 10 bytes and streaming 4 MiB); a decompression bomb;
  a slow-loris body and a slow-loris header; a redirect loop; a scheme
  downgrade; a sniffed type disagreeing with the declared one; the
  concurrency cap and the process gate; cancellation; residual buffering (an
  endless body, asserting the upstream never got to write it); and offline
  behaviour for both a resolve failure and a dial failure, each
  distinguishable from a policy refusal.
- **Every control was revert-proved.** Twenty-four reverts across five
  rounds: each control was deleted or neutered, its named test confirmed red
  for the right reason, and the code restored. One round found two tests that
  passed either way — the control could be removed and the test stayed green
  — and both were strengthened rather than accepted: the IP-literal case now
  asserts the refusal did not come back wrapped in a `*url.Error`, which is
  what the dial-time re-check produces and the pre-dial check does not, and
  the redirect case now asserts the error is not the dial binding's "was
  validated" message. Two structural guards were proved the same way, each
  against a probe file: `TestNoProductionOverrideOfSeams` walks the server
  tree and fails if any non-test file sets `Policy.Classify`, `Resolve` or
  `Dial` — the seams that would replace the boundary — and
  `TestEveryProductionPolicyNamesContentTypes` fails a production `Policy`
  literal that omits the media-type allowlist, since omitting it is how a
  call site would silently accept any type.
- **Deferred, per decision 2, and said so in the package doc.** Aggregate
  cross-caller byte budgets and byte-weighted cache eviction are B7's. The
  interface is shaped for them: one admission point (`Fetch`'s gate acquire)
  where a budget is charged, one accounting point (`limitedReader`) where
  bytes are already counted, and per-fetch numbers on `Policy` so a
  process-wide budget is a new field plus a second gate, not a call-site
  change. Cache partition and expiry are recorded as B7's here and in
  `docs/trust-model.md`; this boundary fills no cache.

**Not included:** the client. C-09 clauses 1, 7 and 8 — the native broker
owning renderer fetches, the typed minimum, and narrowing the `https://*`
capability — are B7's under decision 1, and nothing under `Client/` is
touched. No `findings-ledger` rows were added: SEC-03's register row is
B5-12's. No configuration key was added, so no `gendocs` block moved.

## B5-2 — Upload quotas, reserved headroom, cleanup and pressure

**Closes:** roadmap workstream 4; **SEC-04** (decision 12). **Blocked
by:** decisions 11 and 12. **Size:** 4–5 days. **Protocol effects:**
none. **Migration:** `044`. **Lane A**, beside B5-1.  
**Owns:** `Server/api/upload_handler.go`, `Server/service/upload.go`,
`Server/db/attachment_queries.go`, and `maintenanceTick`.

**Verified premises — half of this already exists, so read before building.**
**Present at HEAD:** `Server/diskutil/` probes real free space on every
platform (`free_unix.go` `syscall.Statfs`, `free_windows.go`
`GetDiskFreeSpaceExW`, `free_other.go` `ErrUnsupported`);
`api/router.go:483-486` enforces a reserved-headroom floor
(`healthMinFreeDiskBytes = 256 << 20`, `"degraded","disk"` below it);
`api/metrics_handler.go` publishes `disk_free_mb`;
`internal/app/banner.go:74-92` warns at 1 GiB and errors at 256 MiB.
**Absent:** any durable per-user byte counter, and any headroom check **on the
upload path** — `api/upload_handler.go:167-183` has only `upload.max_size_mb`
(default 100), the BUG-131 per-user rate limit, and a `MaxBytesReader`.

**Count at the `FileStore` boundary, not at the attachment row.** The obvious
design is refuted: `(*DB).CreateAttachment` (`db/attachment_queries.go:37`) is
a bare non-transactional insert, so "transactional with the attachment rows"
means converting a hot write path; the decrement half lands in
`DeleteOrphanedAttachments` (`:208`), `service/erasure.go` and
`service/retention.go`; and **emoji uploads write to the same `FileStore` with
no attachment row at all** (`api/emoji_handler.go:150` `store.Save` →
`svc.Emoji.Create`), while avatars are exempted by `IsAvatarFileURL`. A
counter hung off attachment rows is evadable by uploading emoji. Either count
where the bytes are actually written, or declare emoji and avatars as bounded
exclusions in decision 11 and prove the bound.

**Build.** A durable per-user byte counter at the storage boundary; the
reserved-headroom check on the upload path using `diskutil` and the shared
constant from decision 11; refusal with `507` and a distinct error code
when either would be crossed; reconciliation on the maintenance tick so
erasure and retention deletions return bytes.

**Acceptance:** the exit condition is "storage quotas and disk headroom fail
safely under **concurrency and restart**", so the tests are concurrency and
restart tests, not arithmetic ones — concurrent uploads racing the last byte
of a quota under `-race`, a crash between the file write and the counter
update, a counter reconciled after an erasure, a restart mid-sweep, and an
**emoji upload counted (or provably excluded)**. Plus a retention/deletion
integration test for the counter rows themselves.

**Trap for this step specifically:** `maintenanceTick`
(`internal/app/maintenance.go:86`) is ~76 lines against a `funlen` budget of
100 lines / 50 statements and `cyclop` max-complexity 20
(`Server/.golangci.yml`). Adding a sweep probably forces an extraction
refactor — do it deliberately, in its own commit, so B5-4 and B5-11 inherit a
clean seam instead of a conflict.

## B5-3 — BG-01 server posture: browser hosting off by default

**Closes:** BG-01's first two closure clauses. **Decisions:** decision 10 — settled. **Size:** 1 day. **Protocol effects:** none. **Migration:** none.
**Lane B**, first.

**Verified premise.** The server hosts no browser client today; the only
`http.FileServer` is the admin panel, served from an `embed.FS`
(`Server/admin/admin.go:60`) behind its own hand-written CSP at `:56`.
`plugin/host_ui.go:58` `AssetHandler` is referenced only from its own test and
is never mounted in production — not a second hosting surface.

**Build.** One owner opt-in configuration key, default off. When off, no app
route is mounted and no asset is reachable. **The test is the deliverable:** a
route-posture test in B4-2's style proving that with the default configuration
every candidate browser-client path answers as an unmounted route, with a
negative control that the same test would fail if the route were mounted.

**Record for B8, so it is not rediscovered.** A browser-client route has to
mount at `/*` and therefore **last** — registered before
`r.Route("/api/v1", ...)` (`api/router.go:97`) or before
`r.Mount("/admin", ...)` (`:196`) it swallows both. Enabled mode also needs its
own CSP (the global `SecurityHeadersWithTLS` is separate from the admin
panel's inline one) and a Vite-build-before-`go build` ordering that touches
`Server/Makefile`, `Server/Dockerfile` and CI. None of that is B5's work; all
of it is B8's inheritance and belongs in this step's PR description.

## B5-4 — Web Push subscription storage (no dispatch)

**Closes:** BG-05's storage half; workstream 9's storage clause. **Size:** 2
days. **Protocol effects:** none. **Migration:** `045`. **Lane B**, after
B5-3. Sanctioned in front of HP-5 by the roadmap's own parallelism rule.

**Verified premise.** Greenfield: zero hits for `webpush`, `web_push` or
`vapid` in `Server/`.

**Build.** Per-server, per-device subscription rows; owner enablement of the
feature and per-user consent as separate gates; VAPID key generation with
rotation that invalidates and re-collects subscriptions rather than silently
breaking them; stale-subscription cleanup on the maintenance tick.

**Acceptance:** subscription lifecycle tests — create, list, revoke, rotate,
expire, cleanup; a subscription is visible only to its owner; erasure removes
them (the retention/deletion integration test for this class); and the
standing proof that **nothing dispatches yet**, so
`TestNoAutomaticTelemetry_Capture` and `TestEgressAllowIsLive` stay green
unchanged.

## B5-5 — Rich-content inventory and the S-03 rune contract

**Closes:** BPR-061; BG-19's server half; S-03. **Decisions:** decisions 1 and 3 — settled. **Size:** 1–2 days. **Protocol effects:** none.
**Migration:** none. **Lane A**, after B5-1.

**Verified premise, and why this step is small.** The roadmap's "retain and
polish the existing link-preview, GIF-search, YouTube/media embed and
rich-content set" describes **client** code: `embeds.ts`, `media.ts` and
`attachments.ts` fetch third-party hosts directly from the renderer through
`@tauri-apps/plugin-http`. Grep for `Embed`/`embed_` across `service/ api/
ws/ db/` returns only `embed.FS` and `go:embed`. The server owns one content
path, and B5-1 already re-based it.

**Build.** (a) The inventory: every rich-content path in the product, which
side fetches it, what bounds it today, and which phase owns its boundary — the
artefact BPR-061's "existing provider/feature inventory" prerequisite names,
and the artefact B7 implements against. (b) The GIF proxy's remaining polish
behind B5-1's boundary: content-type allowlist, failure and offline behaviour.
(c) **S-03**: one explicit rune and normalisation contract shared by the admin
and user writers of channel name, topic and category, with boundary tests that
count runes, not bytes.

**Acceptance:** the inventory has no "unknown" cells; the S-03 tests fail
before the shared contract and pass after; BPR-061's client journeys are
recorded as owed by B9 rather than claimed here.

## HP-5 — Abuse and privacy review

**The owner signs.** Deliverable:
`docs/plans/hp-5-scorecard-<date>.md`, in the shape of the HP-2, HP-3 and HP-4
scorecards.

**What is behind it, and why.** The roadmap reviews HP-5's twelve topics
"before exposing the endpoints", and B4 set the precedent by putting exactly
the steps HP-4 named behind it. So **B5-6 through B5-11 are all behind HP-5**:
spam and block bypass are B5-6's subject, consent-before-fetch is B5-7's,
report confidentiality is B5-8's, moderator privilege is B5-9's, appeal abuse
is B5-10's, and notification leakage is B5-11's. In front sits only work that
hardens an already-exposed endpoint (B5-1, B5-2, B5-5), proves a route stays
unmounted (B5-3), stores data without dispatching it (B5-4), or is a document
(B5-0) — and HP-5 reviews those six topics **against shipped code and real
adversarial tests**, the remaining six **against schema and state-machine
designs before any endpoint is routed**.

**What HP-5 must produce:**

- a verdict per topic, each citing a test path or naming the step that owes it;
- the schema drafts, **with rollbacks**, for message requests, NSFW
  acknowledgement, reports, evidence snapshots, moderation actions, appeals
  and push dispatch state — B4's exit found that nine of twelve migrations had
  no reversal and two of the four that existed were defective, so drafting
  reversals at the hold point is now the pattern;
- a ruling on decision 7's evidence-versus-erasure rule as designed;
- the report-confidentiality model: who can see a reporter's identity, and the
  proof that the reported user cannot;
- the moderator-privilege matrix with adversarial cases — self, peer, owner,
  and concurrent role change;
- the notification-leakage defaults for B5-11, since the roadmap's own
  parallelism rule blocks dispatch on them;
- **the owner's written acceptance of the two narrowed exit conditions**
  (decision 14) — without it the exit claims more than it proves;
- the protocol verdict for B5-6..B5-10 as one decision, so the epoch-1 fixture
  rule ("extend, never mutate") is applied once rather than five times;
- and the pre-squash `refs/pull/<n>/head` SHAs for any step whose commit
  structure the review depends on (pattern rule 3).

**Nothing in B5-6 through B5-11 is routed before this scorecard is merged.**

## B5-6 — Message Requests and trusted-sender relationships

**Closes:** BPR-060; BG-13's server half. **Blocked by:** HP-5. **Decisions:** decisions 4 and 5 — settled. **Size:** 4–5 days. **Protocol effects:** **yes** — the
request inbox needs a real-time event and multi-device consistency.
**Migration:** `046`.  
**Owns:** `Server/service/message_crud.go`, `Server/ws/handlers_chat.go`,
`Server/ws/hub_visibility.go`, `Server/service/dm.go`,
`Server/api/dm_handler.go`.

**The premise the first draft got wrong.** `CreateDM` is **not** where first
contact happens on the recipient's side. `MessageService.SendMessage` calls
`s.st.OpenDM(...)` per participant and accumulates `result.OpenedDMFor`
(`service/message_crud.go:265-285`), which `ws/handlers_chat.go:96` turns into
a `DMChannelOpenEvent` and which bumps the hub's global visibility watermark.
**A gate confined to `service/dm.go` is bypassed by the sender's first
message** — the exact event this feature exists to intercept. The gate's home
is `message_crud.go`, beside the `OpenDM` accumulation.

**The two gates already there, to sit beside rather than duplicate:**
`auth.IsEffectivelyBanned` (`service/dm.go:126`) and `IsEitherBlocked` →
`ErrForbidden` (`:130-136`). `api/dm_handler.go` is a transport adapter.

**Build.** A `message_requests` table and a `trusted_senders` table; the first
message from a sender with no trusted-sender row creates a `pending` request
instead of opening a conversation. Transitions `pending → accepted | ignored |
deleted | blocked` are the only legal ones and only the recipient may make
them; acceptance writes the trusted-sender row inside the same transaction
that opens the conversation. Migration `046` grandfathers every existing
one-to-one DM pair as trusted.

**The five bypasses to close, each with a test:** a blocked sender cannot
create a request; a request cannot be created for a recipient who lacks
permission to receive DMs; accepting does not resurrect content the retention
sweep has removed; erasing either account removes the request and the
trusted-sender row (decision 7's rule — this is the class's
retention/deletion integration test); and re-sending after an `ignored`
outcome creates no second request and no second notification.

**Acceptance:** state-machine and property tests over every transition
including the illegal ones, plus races (two devices deciding at once),
reconnect and multi-device consistency, and the abuse property from decision 5 — the sender's view is byte-identical in `pending`, `ignored` and
`deleted`.

**Fixture warning.** `dm-send.json` replays through `r.db.GetOrCreateDMChannel`
(`ws/protocol_epoch1_contract_test.go:926`), **below** the service layer. So a
service-level gate will not break the fixture — and the green fixture
therefore **proves nothing** about the gate. Write the coverage; do not read
the fixture as evidence.

## B5-7 — NSFW label and per-user acknowledgement, enforced server-side

**Closes:** BPR-063; BG-18's server half. **Blocked by:** HP-5. **Decisions:** decision 13 — settled. **Size:** **6–8 days** — the first draft said two, and a
touch-set audit refuted it: 13+ production files across five packages.
**Protocol effects:** **yes** — the acknowledge and revoke commands and a
second-device signal. **Migration:** `047`. **After B5-6** (shares
`message_crud.go`) **and after B5-2** (shares the upload files).

**Verified premise.** `migrations/025_channel_nsfw.sql` stores the flag.
`db/admin_queries.go:163` calls it "stored and broadcast only";
`admin/handlers_channels.go:124` calls it "stored, broadcast **and audited**"
— the audit is real (`service/channel_admin.go:243-253`), and B5-0's
data-ownership table records it. No acknowledgement storage, no read gate.

**The four leak paths that make this step big.** Each is a separate read
surface; a gate on one does not cover the others:

1. **Search bypasses the read chokepoint.** `requireChannelRead`
   (`service/message_query.go:18`) covers history, around and pins including
   DMs — but `SearchMessages` (`:68`) **inlines its own checks** at `:81-92`,
   and its global branch goes through `GetAccessibleChannelIDs`
   (`service/message_perms.go:47`). The gate must be written in **both**
   authorization implementations, or search returns NSFW message bodies
   pre-consent. This is the one that would ship silently.
2. **Live socket delivery is a push, not a read.** `ws/hub_visibility.go`,
   `ws/replay.go` and `ws/hub_registry.go` deliver live and replayed messages
   independently of the REST paths. An unacknowledged member of a labelled
   channel would still receive bodies over the socket.
3. **Two unlinked-attachment escape hatches** in `service/upload.go` sit in
   front of any channel-scoped check: the avatar branch (`authorizeUnlinked` →
   `IsAvatarFileURL`, which allows everyone) and the administrator branch
   (`Authorize`'s `HasAdmin` early return). Both are correct for their own
   purpose; both must be reasoned about rather than inherited. The
   channel-scoped gate itself belongs in `UploadService.Authorize` and
   `handleServeFile` (`api/upload_handler.go:245`).
4. **The plugin broadcast sink.** `internal/app/hub.go:75-79` wires
   `pluginRegistry.Sink().SetBroadcaster(hub.BroadcastToChannel)`, so plugins
   receive message payloads with no consent gate.

Plus the ordinary REST read surfaces: `handleGetMessages`,
`handleGetMessagesAround`, `handleSearch`, `handleGetPins` and
`handleGetReactionUsers` (`api/channel_handler.go:106,155,192,290,348`).

**What does _not_ need reworking**, so the step is not oversized in the other
direction: `ws/serve_ready.go` `buildReady` carries no message content —
channels, members, voice states, roles and DM channels only — and already
ships `nsfw` per channel at `:219`. It is a channel-list gate, not a content
gate. And `api/dm_handler.go` / `service/dm.go` return no message content.

**Build.** A per-user, per-channel acknowledgement row. Every one of the four
paths above returns the label and nothing fetchable until the row exists.
Acknowledgement is revocable and revocation takes effect on the next read, not
the next session.

**Acceptance:** BG-18's line is the bar — "No content, preview, attachment, or
third-party request occurs pre-consent". Prove it on **all four paths**: an
unacknowledged subject gets no message body from REST, none from search, none
over the socket, and no attachment bytes; the response carries nothing a
client could start a fetch from. Cover revoke, a second device, logout, a
moderator viewing reported content, and the plugin sink. Plus the
retention/deletion integration test for the acknowledgement rows. The client
half — blur, gate and consent UI — is B9.

## B5-8 — Local report intake and queue service

**Closes:** BPR-070; **BPR-071's server half**; BG-14's server half, part a.
**Blocked by:** HP-5. **Decisions:** decision 7 — settled. **Size:** 4 days. **Protocol
effects:** **yes** — queue updates for connected moderators. **Migration:**
`048`. **Owns:** `Server/service/moderation.go` for the duration.

**Verified premises.** Greenfield — no reports table, no report service. And
**BPR-071 is not wholly a client requirement**: the traceability matrix
assigns its primary phase to B5, and its evidence column reads "**Service
tests** cover queue, evidence/context, assignment, status, notes, action
links, immutable history, retention, and **deletion unlinking**". Only the
Moderation Center UI is B9.

**Build.** Report intake for messages, users and attachments; an immutable
evidence snapshot taken at report time; the surrounding-context rule (how many
messages either side, and what happens when those are deleted or retained
away); assignment, status and internal notes; action links to B5-9's actions;
retention per B5-0's lifecycle table; and immutable audit history on the B2-6
audit foundation with B4-10's actor tokens.

**Acceptance:** BPR-070's line — cross-server or central delivery is
**impossible**, proven as an absence proof in B4-2's style, not asserted;
duplicate, rate-limit, block, deleted-target and access-control tests;
reporter identity invisible to the reported user; and **BPR-071's deletion
unlinking** — B4-10's marker machinery applied to moderation history, so a
report about an erased account keeps action, time and order with the marker
token in place of the id.

**Decision 7 needs both halves tested, and they pull opposite ways.** Erasing
the subject must (a) hard-delete the evidence snapshot's **content**, so
B4-9's signed exit condition holds and a restored backup cannot resurrect it,
and (b) leave the report's **outcome row** standing as an unlinkable audit row
— action, time, order, marker token, no content and no identity — with the
report closed as `subject_erased`. A test that only proves (a) would pass
against an implementation that deletes everything, which is the abuse path
decision 7 was strengthened to close: report someone, they erase, no trace the
report existed. Write both, and write the negative control for (b).

**Absence-contract trap:** `TestAbsenceContract_NoFederationDirectoryOrListingWireTypes`
fails any new wire name matching `(?i)federat|directory|discover|listing`. A
"report **listing**" frame or config key trips it — name it `queue`.

## B5-9 — Narrowly permissioned moderator actions

**Closes:** BPR-072; roadmap workstream 10's testable half. **Blocked by:** B5-8. **Decisions:** decision 6 — settled. **Size:** 4 days. **Protocol effects:** **yes** — a
timeout must take effect on a live socket and in voice. **Migration:** `049`.  
**Owns:** `Server/service/moderation.go`, `Server/permissions/permissions.go`,
**and the three files a new bit drags with it** —
`Server/admin/static/index.html` (`PERM_GROUPS`), `Client/src/lib/types.ts`
(the `Permission` enum) and `docs/schema.md` (the bit map and its
reserved-bits line).

**Verified premises.** Ban exists and is well-shaped — `BanUser` checks
`BAN_MEMBERS`, verifies the target exists, refuses self-ban, enforces
`requireOutranks`, and already accepts `expires *time.Time`. Content removal
exists (`service/message_purge.go`). Kick exists as admin force-logout gated
by `KICK_MEMBERS` (`admin/api.go:46`). **Warning and timeout have no
implementation.** Bit 22 (`0x400000`) is unused in code but `docs/schema.md:926`
documents it as **reserved**, and `MUTE_MEMBERS` (bit 20) already covers the
voice slice of the proposed timeout. Owner decision 6 settles both.

**Build.** Warning and timeout on the existing hierarchy machinery — reuse
`requirePerm`, `requireOutranks`, and the authorization-before-existence rule
that keeps these paths from enumerating user ids. One new `MODERATE_MEMBERS`
bit. Document kick's real meaning rather than inventing a second mechanism.

**Acceptance:** BPR-072's role matrix and adversarial tests — hierarchy, self,
peer and owner targets, concurrent role changes, voice and text effects, and
audit; the requirement's other half, that operational TLS, backup and update
controls remain **owner-only**, proven by test rather than asserted; the
retention/deletion integration test for the warning and timeout rows; and
**workstream 10's absence proof** — no plugin capability can take a moderation
action, and every moderation audit row carries a human actor token.

**The gate that catches a half-done bit:** `Server/admin/perm_grid_test.go:50-59`
(`TestAdminPanelPermGridCoversEveryPermissionBit`) ORs `PERM_GROUPS` out of
the admin panel's HTML and asserts it equals `permissions.AllPerms`. Adding
the constant alone turns the build red — and without that test it would
silently strip the bit on every role save, because `collectRolePerms` rebuilds
the mask from rendered checkboxes. Budget four edits, not one.

## B5-10 — Rate-limited appeals

**Closes:** BPR-073. **Blocked by:** B5-9. **Decisions:** decision 8 — settled. **Size:** 2–3
days. **Protocol effects:** **yes** — "user-visible status" implies a status
signal. **Migration:** `050`. **Owns:** `Server/service/moderation.go`.

**Verified premise.** Greenfield — zero hits for `appeal` in `Server/`.

**Build.** Submission against a specific moderation action; the rate limit;
assignment, status and decision; user-visible status; audit.

**Acceptance:** state and property tests over submission, rate limit,
assignment, status, decision, notification, repeat and closed cases, blocked
users, deletion, retention and audit — plus decision 8's rule that the
moderator who acted does not decide the appeal where another is eligible.

## B5-11 — Web Push dispatch

**Closes:** BG-05's dispatch half. **Blocked by:** HP-5 (the roadmap's
parallelism rule blocks dispatch on the privacy defaults). **Decisions:** 9 — settled. **Size:** 2 days. **Protocol effects:** none. **Migration:** none.
**Beside** the B5-8..B5-10 chain. **Owns:**
`Server/invariants/egress_sites.go`.

**Verified premise and the collision to handle.** Dispatch opens outbound
connections to whatever push service each subscription names. B4-8's
`egress-sites` invariant fails any production file that dials and is not
inventoried, and every existing row is manual, configuration-gated or
loopback.

**Build.** Dispatch off by default behind an owner-set key; generic-content
payload defaults with nothing sensitive by default; VAPID signing against the
B5-4 keys; failure and expiry handling that prunes dead subscriptions; and the
new `egress_sites.go` row — `config` trigger, destination "the push service
named in each stored subscription endpoint", gate named, sites listed.

**Acceptance:** the exit condition — "Push subscriptions are per
server/device, opt-in, revocable, and contain no sensitive default payload" —
plus `TestNoAutomaticTelemetry_Capture` still green on compiled defaults and
`TestEgressAllowIsLive` green with the new row. There is no OwnCord relay and
the tests must make that unfalsifiable.

## B5-12 — Register and roadmap reconciliation

**Size:** 1 day. **Protocol effects:** none. **Parallel with:** everything
after B5-0. **Adds no ledger rows** — this is register, roadmap and plan
bookkeeping, not hunt findings.

**Register corrections**, each with the evidence already in "Verify before you
implement":

1. `OC-0323`, `OC-0327`, `OC-0349`, `OC-0351` and `OC-0357` are `fixed` in the
   ledger. Record that in the register rows, with the phase that closed each,
   so pattern rule 2 can be checked by reading rather than re-derived.
2. `SEC-02`'s closure line cites "B5 item 11", which is the unrelated SEC-03
   item. Correct the citation and re-tag its remaining UI half to the client
   phase that owns it, with the written reason rule 2 requires.
3. `SEC-03` splits across B5 (server boundary) and B7 (desktop broker) per
   decision 1. Record the split in the register row and in
   `docs/trust-model.md`'s C-09 Status line so the two stop contradicting each
   other.
4. `SEC-04`'s phase tag per decision 12, and its advisory ID filled or
   the row closed — exit condition 7 depends on it.
5. `BG-18` and `BG-19` re-tagged to record where the client halves of exit
   conditions 2 and 3 live (decision 14), following B4's precedent of
   pairing a narrowed condition with a re-tagged row.

**Roadmap amendments** — the part the first draft omitted entirely. This
plan's case rests on the roadmap being wrong in three places, and shipping B5
without fixing them leaves the roadmap asserting a scope the exit did not
meet:

- **Workstream 2** describes client code; reword it as an inventory plus the
  server path, and point at B7 for the rest.
- **Workstream 11** and `docs/trust-model.md`'s C-09 status must state the
  same split once, in one place.
- **Exit condition 2** says "every external fetch"; the exit will measure
  server-side paths only. Reword it to what B5 proves, with the remainder
  attributed to B7.

Each amendment is dated, carries the owner's ruling, and goes in this step's
PR — not silently into a later one.

## Exit gate

The roadmap's seven conditions, plus the phase execution pattern's rule 2.
Each is measured on the exit SHA with the gates re-run there — the B4 exit's
shape, and the `gate-evidence` job blocks tagging an ungated SHA.

| #          | Condition                                                                                                                    | Where it is proven                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | Message Requests cannot bypass block, permission, retention, or deletion rules                                               | B5-6's five bypass tests, each against the existing mechanism rather than a new one — and written at `service/message_crud.go`, not `CreateDM`                                                                                                                                                  |
| 2          | External retrieval passes address, redirect, streaming-size, timeout, concurrency, media-type, and offline adversarial tests | B5-1's adversarial suite — **for server-side fetch paths only**, per decision 1. The desktop preview path is C-09/B7 and stays governed by capability scope and CSP. **Narrowed: requires the owner's written acceptance at HP-5 (decision 14) and a BG-19 re-tag in B5-12.**                   |
| 3          | NSFW content and third-party fetches remain unavailable before consent                                                       | B5-7, on all four server paths (REST reads, search, socket delivery, attachments) plus the plugin sink. **Equally narrowed: the client render gate is B9, so this also requires the owner's written acceptance at HP-5 and a BG-18 re-tag.** Two identically narrowed conditions, one standard. |
| 4          | Report, moderation, and appeal state machines enforce least privilege and immutable safe audit                               | B5-8, B5-9, B5-10 — the role matrix, the adversarial hierarchy cases, BPR-071's deletion unlinking, and audit rows on the B2-6 foundation with B4-10 actor tokens                                                                                                                               |
| 5          | Storage quotas and disk headroom fail safely under concurrency and restart                                                   | B5-2's concurrency and restart tests under `-race`, not arithmetic tests. **This condition restates SEC-04's closure line, which is why decision 12 must settle SEC-04's phase before the exit.**                                                                                               |
| 6          | Push subscriptions are per server/device, opt-in, revocable, and contain no sensitive default payload                        | B5-4 and B5-11, plus `TestNoAutomaticTelemetry_Capture` and `TestEgressAllowIsLive` green                                                                                                                                                                                                       |
| 7          | No unresolved B5 security advisory remains                                                                                   | Closed at the exit, as B4 did, not per step — advisories go through GitHub Security Advisories and never into a commit, issue or PR description. **SEC-04's unfilled `GHSA-____-____-____` is the known open item.**                                                                            |
| **rule 2** | No `OC-*` finding tagged B5 is open, unless re-tagged with a written reason in the scorecard                                 | **Already satisfied at the base commit** — all five are `fixed` in the ledger; B5-12 records it. The open `SEC-03`, `SEC-04`, `S-03` and six `BG-*` rows are not `OC-*`, but the same discipline applies: each closes in its step or is re-tagged in writing.                                   |

**The roadmap's required evidence for B5**, each owed by a named step:
state-machine and property tests for requests, reports, actions and appeals
(B5-6, B5-8, B5-9, B5-10); private safe-fetch and quota security validation
(B5-1, B5-2); storage-pressure and cleanup tests (B5-2); the role/permission
matrix (B5-9); push endpoint and subscription lifecycle tests (B5-4, B5-11);
and **retention/deletion integration for every new data class** — which is an
integration test per class, not B5-0's table. The classes and their owners:
message requests and trusted senders (B5-6), NSFW acknowledgements (B5-7),
reports and evidence snapshots (B5-8), warnings and timeouts (B5-9), appeals
(B5-10), push subscriptions (B5-4), quota counters (B5-2). Preview-cache
entries are **not** a B5 class — B5-1 fills no cache (decision 2); that
class arrives with B7's broker.

And the pattern's own closure conditions: acceptance evidence green on
supported environments; the full server, client, browser, Rust, deployment and
generated-contract gates green; no new warning, advisory, documentation drift
or generated drift; CI evidence on the exact integration commit; tracker,
requirement map and scorecard in agreement; and rollback, compatibility and
data-migration notes — which for B5 means **a rehearsed reversal for each of
the seven migrations `044`–`050`** in `Server/rollback/`, the obligation B4's
exit established.

## Explicitly out of scope for B5

- **Client _experience_ surfaces.** The Moderation Center UI (BPR-071's client
  half), the request inbox UI, the consent gate's blur and prompt, appeal
  status screens and push permission UX are B7/B8/B9. **Note the boundary
  carefully:** BPR-071's _service_ half is B5-8's, and
  `Server/admin/static/index.html` is server-embedded and is B5-9's. "Client
  surface" is not "anything with a rendered pixel".
- **The desktop native fetch broker** — C-09 clauses 1, 7 and 8 — and with it
  aggregate cross-caller byte budgets, byte-weighted cache eviction, and cache
  partition/expiry evidence. B7, per decisions 1 and 2.
- **The browser client build** and its enabled-mode upgrade and security
  smoke — B8. B5-3 ships only the disabled-by-default posture, and records the
  mount-order, CSP and build-order constraints B8 inherits.
- **Provider expansion** beyond the existing link-preview, GIF, YouTube and
  media set — BPR-061 says optional and otherwise post-beta.
- **Automated moderation itself.** Workstream 10 keeps automation optional and
  post-beta. What is _not_ out of scope is its testable half — B5-9 owes the
  absence proof that no plugin capability can take a moderation action.
- **Federation, cross-server identity, and any central OwnCord moderation,
  directory or push relay** — BPR-082, BPR-083 and BPR-070's own wording. B5
  adds absence proofs where the new surfaces could be mistaken for them.
- **Translation and string extraction** (BPR-064) — B9.
- **Group-DM invitations** — decision 4 keeps Message Requests to
  one-to-one DMs for beta.
- **Retention holds** — B4's decision 5 ruled no holds for beta; B5 does not
  reintroduce them for reports or appeals.

## Traps carried forward

Cheap to state, an hour each to rediscover.

- **`core.hooksPath` is an absolute path into the main checkout**, so a
  worktree runs `dev`'s hooks. The pre-commit hook lints the whole client and
  times out at two minutes. Run the gates by hand, commit with `--no-verify`,
  and say so in the commit message.
- **Run `npx prettier --check .` from the repository root.** From `docs/` or
  `Client/` it picks up a different config and ignores the root
  `.prettierignore`, which holds `docs/audit-*.md` as frozen records — running
  it wrong reformatted seven of them by accident.
- **Never `cd` at the top level of a shell command** — a pre-tool hook blocks
  it, because the persistent shell cwd then leaks into every later command.
  Use a subshell, `git -C`, or paths from the repository root.
- **Go's test cache does not track files outside the `Server` module.** A test
  that reads a document under `docs/` answers `ok (cached)` after a doc-only
  edit. Use `-count=1` whenever you check one.
- **Five generated surfaces, one ritual.** `Server/db/dbgen/`, the
  `gendocs:schema` / `gendocs:routes` / `gendocs:config` blocks (each carrying
  a hard-coded count, and the config one additionally failing when a key is
  undocumented in the prose above it), and `Server/ws/message_types.go` +
  `Client/src/lib/protocolTypes.ts`. `make docs-verify` and
  `make protocol-verify` are hard CI steps. Always: rebase on `dev`, re-run
  the generator, re-run `ci-check`. Never resolve a generated conflict by hand.
- **`Server/config/config.go` has no validation seam.** What exists is inline
  in `Load` plus a voice-only normalizer, with semantic validation for existing
  keys scattered _outside_ the package (`api/router.go`'s auth-rate clamp and
  upload-size warning, `internal/app/hub.go`'s admission-budget clamp,
  `internal/app/restart.go`'s mode resolution). Five B5 steps add keys — agree
  on one site for their range checks before the second step lands, or five
  lanes invent five. Remember `defaultYAML`, the shipped template, is a second
  literal in the same file. Env binding _is_ generic (`env.Provider` +
  `envKeyToKoanf`) and `config_test.go` has no golden key list, so new keys
  need no env or test-list edit.
- **A non-comparable field on `service.Services` breaks an unrelated test's
  compilation.** `Server/admin/services_bundle_test.go:24` does `if *svc != before`
  — a direct struct comparison. Any new service field that is a slice, map or
  func makes `Services` non-comparable. B5-4, B5-6, B5-7 and B5-8 all add
  fields.
- **`maintenanceTick` is near its linter budget** — ~76 lines against `funlen`
  100 / 50 statements and `cyclop` 20. The first step to add a sweep should
  extract it deliberately, in its own commit.
- **`TestAbsenceContract_NoFederationDirectoryOrListingWireTypes`** fails any
  new wire name matching `(?i)federat|directory|discover|listing`. Name the
  report queue `queue`.
- **Verify with the `ci-check` skill, not an ad-hoc `go build && go test`.**
  CI compiles four Go build-tag variants and runs a deadlock-detection pass;
  the default build proves nothing about the tagged ones.
- **`gh pr checks` reports the PR's head SHA**, which can lag a push by
  minutes and freezes entirely once a PR is merged. Confirm which SHA the
  checks ran on before believing them.
- **`github-advanced-security` currently fails repo-wide** with
  `CAPIError: 400 The requested model is not supported`. GitHub's own service,
  not a required context, not your change.
- **The recurring `windows-latest` `ws` failure under `-race` is a Go runtime
  fault**, not a flaky test. A red Lint step with zero linters run is
  `golangci-lint`'s network schema fetch, not your code.
- **Squash-merge divergence:** if `dev` phantom-diverges, reset and force-push
  rather than resolving invented conflicts; a merge commit, not a squash, is
  what reconciles a hand-retargeted branch.
- **Do not add findings-ledger rows for plan or register bookkeeping** — the
  ledger is for hunt findings. B5-12 edits the register and the roadmap, not
  the ledger.
