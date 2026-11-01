# OwnCord non-media adoption plan

**Status:** planned, not started (2026-11-01). Design only: no implementation, no default change and no dependency change has been made for it. Every benefit below is unproven until measured and every number is a proposed acceptance target. Track the work in the [task list](#task-list) below and record state changes in this line and in the [plan index](README.md).

> **About this copy.** Added 2026-11-01 at @J3vb's request as the durable repository copy of the owner's planning document. Everything from [Objective and baseline](#objective-and-baseline) down is the plan as written; the only edit is that the audit link now points at the repository copy, [2026-11-01-non-media-comparative-audit](../audits/2026-11-01-non-media-comparative-audit.md). The audit's probe script and probe results were not supplied, so they are **unavailable**; they were synthetic probes of other projects' functions, not OwnCord application tests, and nothing here turns them into repository tests.

## Task list

One task per plan step, in the plan's order. NM-0 comes first. NM-3 may start once NM-0 is in place without waiting for NM-2. Each behaviour change is its own PR, off by default where the plan names a flag, with tested rollback; a default changes only in a separate, evidence-backed decision.

<!-- prettier-ignore -->
| Task | Plan section | Depends on | Evidence today | Proposed flag | State |
| --- | --- | --- | --- | --- | --- |
| NM-0 Baseline reproduction and measurement | [NM-0](#nm-0--reproducible-baselines) | none | none: no baseline recorded | none (test-only) | todo |
| NM-1 Shared thread retry ownership and complete recovery metadata | [NM-1](#nm-1--thread-retry-ownership) | NM-0; NM-1a must reproduce a failing real journey before NM-1b | source-visible lifecycle gap, **not reproduced** | temporary rollout flag allowed, must not hide a confirmed defect | todo |
| NM-2a Interrupted-upload value/feasibility experiment | [NM-2a](#nm-2a-value-and-feasibility-experiment) | NM-0 | missing capability, not a defect; value unproven | none (experiment) | todo |
| NM-2b Capability-gated resumable server transfer sessions | [NM-2b](#nm-2b-server-session-and-commit-semantics) | NM-2a decision gate passed | none | `resumableUploadsV1` (server), off | todo (conditional) |
| NM-2c Client resume, cancellation and recovery UX | [NM-2c](#nm-2c-client-recovery-and-platform-integration) | NM-2b capability and compatibility tests | none | client capability gating, off | todo (conditional) |
| NM-3 Combined history/live-event/scroll acceptance tests | [NM-3](#nm-3--combined-history-and-scroll-acceptance-tests) | NM-0 | no gap established; tests-first | none for tests; narrow fix only for a demonstrated gap | todo |
| NM-4 Bounded, accurately labelled latency-tail diagnostics | [NM-4](#nm-4--honest-latency-tail-diagnosis) | NM-0; first an audit of existing metrics | aggregate wait counters only; no overload shown | existing metrics config; `dbLatencyDetailsV1` only if none fits | todo |
| NM-5 Conditional shutdown/reconnect-load experiment | [NM-5](#nm-5--deployment-specific-shutdownload-experiment) | NM-0; Phase Q Q2.4 for any runtime change in `ws/hub.go` | no overload reproduced; spread already exists (see anchors) | deployment-scoped, off | todo (conditional) |

### Milestones: tests, implementation and promotion are separate

<!-- prettier-ignore -->
| Task | 1. Baseline and tests (always) | 2. Implementation (only if step 1 justifies it) | 3. Promotion decision (separate, evidence-backed) |
| --- | --- | --- | --- |
| NM-0 | Extend existing fixtures; record runs; baseline-only pilots, then ≥30 paired trials per core scenario | none | n/a |
| NM-1 | NM-1a: close/reopen/restart retry journey that fails on baseline, or a recorded pass | NM-1b: smallest ownership move under the existing pending-send owner | Correctness fix after ≥100 deterministic close/reopen/ACK cycles and native restart journeys; rollback keeps every written pending record |
| NM-2a | Whole-file interruption baseline (verified 70% point, healthy/slow/lossy, small-file control); protocol comparison | none | Decision gate: go to NM-2b, or keep whole-file and keep the tests |
| NM-2b | Isolated API and crash tests | Server sessions behind `resumableUploadsV1`, off | Advertise capability only when usable; default change is its own decision |
| NM-2c | Unit and fullstack resume tests, native journeys | Client resume where both sides agree | Internal synthetic files, then opt-in large files; default change is its own decision |
| NM-3 | Seeded race/anchor scenarios in Chromium, WebView2 and native | Narrow fix only for a demonstrated gap; no new renderer | Ship tests only if current code passes |
| NM-4 | Audit existing metrics; synthetic distributions and a contention rig | Bounded distribution at a precisely named boundary, diagnostic-only | Enable only within the overhead target; stop if existing metrics answer the question |
| NM-5 | Restart/load baseline (planned update vs abrupt loss, ≥20 independent restarts) | Only if baseline shows overload: tune the existing notice/spread owner, or paced close where a healthy destination exists | Off-by-default deployment setting; if nothing benefits, keep load regression coverage and close as not adopted |

Must stay intact in every task: encrypted desktop pending-message storage, explicit (clicked) retry and recovery, stable logical message IDs, delivery receipts and restore floor, browser memory-only message storage, replay ordering, bounded history windows and row virtualization, lifecycle ownership.

## Evidence status

Source-visible means read from code at `dev` `06caf6a3`; nothing below was reproduced in a running client or server. Numbers in the plan are proposed targets, not results.

<!-- prettier-ignore -->
| Area | Confirmed in source | Reproduced? | Benefit |
| --- | --- | --- | --- |
| Thread replies | `ThreadPanel.ts` keeps retry payloads in a panel-local map (`:122`), `retrySend` needs it (`:495`), `destroy` clears it (`:690`); the thread send path does not use the pending-message queue | No. The visible close/reopen outcome is unknown (NM-1a) | Recoverable failed thread replies: unproven |
| Uploads | Whole-file `FormData` POST (`lib/apiChannels.ts:325`) | n/a: a missing capability, not a defect | Less repeated traffic on interrupted large files: unproven, value depends on real file sizes |
| History and scroll | Bounded reconciliation, windowing and anchor tests already exist | No gap established | Stronger acceptance coverage |
| Database waits | Aggregate reader/writer wait counters (`internal/app/metrics_sampler.go:41`) | No overload shown | Better diagnosis only, not speed |
| Restart load | Restart notice, ordered shutdown and an existing per-client redial spread (see anchors) | No overload shown | Lower restart peaks: unproven, deployment-dependent |

## Anchors rechecked on current `dev`

Rechecked 2026-11-01 at `dev` `f68b3aa0`. The only change since the audited `06caf6a3` is `.github/workflows/nightly-test-depth.yml`, so every line reference in the plan and audit still holds. The recheck adds these facts the plan's candidate lists should use:

- **NM-1:** `PendingTextMessage` is defined in `Client/src/lib/pendingMessages.ts:20` (client ID, channel, content, created time); `src/platform/contracts/pendingMessages.ts` holds only the owner and store shapes. Typed reply/sticker metadata starts in `lib/pendingMessages.ts`; the contract changes only if the persisted shape does. Thread tests to extend: `Client/tests/unit/thread-panel.test.ts` and the thread send-failure, timeout and close tests from #2841.
- **NM-2b:** the upload owner is `Server/service/upload.go` (`UploadService`: per-request quota reservation released by `Settle`, orphan sweep); routes mount in `routerUploadRoutes` (`Server/api/router.go:372`). The newest migration on `dev` is `089`; a staged-session table takes the next free number when the work starts.
- **NM-2c:** `Client/src/features/uploads/` already exists (the My uploads tab, #2953 and #2961), so a resumable helper joins that folder.
- **NM-4:** existing metrics to audit first: `Server/metrics/window.go` (windowed counters), `slowroutes.go` (slow-request card, twelve five-minute slots), `promtext.go` (Prometheus output), plus the WAL and migration timings from #2609.
- **NM-5:** the restart notice already carries `reconnect_spread_ms`, scaled by the connected-client count (`Server/ws/restart_notice.go:52`); the client waits a random offset inside it (`Client/src/lib/ws.ts:578`), uses equal-jitter backoff with server hints (`ws.ts:265`) and honours `SERVER_BUSY` `retry_after_ms` from ready admission (`Server/ws/serve_ready_admission.go`). The plan's "bounded post-outage client dispersion" arm is therefore today's baseline, not a candidate. Load tooling exists in `Server/ws/load_soak_test.go` (the 1,000-connection profile, #2580) and `Server/cmd/smoke/` (`drills.go`); a restart-load harness extends these.
- **NM-0:** `Client/tests/e2e/support/` has `lifecycle-probe.ts`, `process.ts`, `tcp-gate.ts`, `real-transport.ts` and `upstreamGateway.ts` for fault and lifecycle control; `non-media-performance.ts` does not exist (proposed).

## Relation to existing plans and work

Linked, not duplicated:

- **[LiveKit adoption plan](livekit-adoption-2026-11-01.md) (Phase LK).** LK-0 and NM-0 both add a paired-trial harness and analyzer. Build one: whichever lands first defines the result record (SHA, versions, OS, seed, fault schedule, outcome) and the analysis; the other extends it rather than adding a parallel tool. LK-4a (voice reconnect jitter in `lib/voice/livekitReconnect.ts`) and NM-5 (app socket restart load in `lib/ws.ts` and the hub) have different retry owners and stay separate tasks, but share one restart-event rig (≥20 independent restarts, attempts bucketed per second). One server restart triggers both reconnects, so their candidate trials never run in the same experiment, and neither adds a second retry loop.
- **Phase Q Q2.4 (WebSocket hub split, queued).** It regroups `ws.Hub`, including the shutdown path NM-5 would touch. NM-5's baseline and harness may go first; any NM-5 runtime change waits for Q2.4 to merge.
- **Phase Q Q4 performance guards (done 2026-10-31).** NM-3 keeps the message-list scroll, history and heap budgets; NM-4 measures its overhead against the same benchmarks.
- **Earlier messaging work.** Thread send-failure tests (#2841), retry on failure (#2436), drafts surviving restart (#2428), send while uploading (#2475), uploads surviving a channel switch (#2332) and My uploads (#2953, #2961) are behaviour NM-1 and NM-2c keep and extend.
- **Server work already done.** 1,000-connection scale profile (#2580), windowed metrics and Prometheus (#2600, #2605, #2609), request work joining shutdown (#2602, #2612) and the replay-tier measurement (#2616, #2619, #2624) are NM-4 and NM-5's starting point. Fixed shutdown ledger entries OC-0027, OC-0273, OC-0426 and OC-0459 keep their regression tests.
- No open findings-ledger entry covers thread retry or resumable uploads.

---

Prepared 1 November 2026. Documentation only: no implementation, TODO changes, application defaults, commits or PRs.

## Objective and baseline

Adopt useful ideas from the [non-media comparative audit](../audits/2026-11-01-non-media-comparative-audit.md), starting with protecting user-authored messages, then reducing interrupted-transfer cost. Strengthen history acceptance tests, improve operational diagnosis, and consider shutdown pacing only where measurements justify it.

Audit baseline: OwnCord `dev` at `06caf6a3b729487a504f9750d9bc6985ad01b031`. During planning, remote `dev` advanced to `f68b3aa0a6bcb751e1d6ca769ea5508ee4a1718e`. The complete tree comparison changed only `.github/workflows/nightly-test-depth.yml`; the application and test anchors below are unchanged. Recheck the branch and repository guidance at implementation time.

The audit's nine source-function probes passed, but they used synthetic storage/sockets. They did not reproduce thread behavior in the UI, demonstrate upload savings or benchmark a deployed server. Those are explicit work items below. Numerical gates are **proposed acceptance targets**, not achieved results. Calibrate baseline noise and fix the comparison protocol before trying candidates; document any change to a gate.

Preserve OwnCord's encrypted desktop outbox, explicit retry/recovery intent, stable logical message IDs, delivery receipts/restore floor, browser memory-only message storage, bounded history/DOM windows, replay ordering and lifecycle ownership. Neither plain localStorage message bodies nor automatic outbox replay should be adopted as incidental implementation details.

## Priority and dependencies

| ID    | Priority / intended benefit        | Work                                                              | Dependency / decision                                            |
| ----- | ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| NM-0  | Foundation                         | Reproduce targeted gaps and capture comparable baselines          | First; extend existing fixtures                                  |
| NM-1  | P1: protect failed thread replies  | Shared retry ownership and complete recovery metadata             | Implement after a failing real journey is demonstrated           |
| NM-2a | P1: establish upload value         | Interrupted-upload experiment and protocol feasibility            | Baseline whole-file behavior and actual file-size needs          |
| NM-2b | P1: reduce repeated upload traffic | Optional resumable server transfer sessions                       | Only after NM-2a justifies the protocol cost                     |
| NM-2c | P1: usable recovery                | Native/browser client resume, cancellation and recovery UX        | Server capability and compatibility tests                        |
| NM-3  | P2: protect reading/navigation     | Combined history, live-event and scroll acceptance scenarios      | Tests first; runtime fixes only for demonstrated gaps            |
| NM-4  | P2: diagnose slow operations       | Bounded latency-tail visibility at a precise measurement boundary | First check whether existing metrics already answer the question |
| NM-5  | P3: reduce restart spikes          | Deployment-specific restart/load experiment, then optional pacing | Keep investigative unless a supported deployment benefits        |

NM-3 coverage can proceed after NM-0 without waiting for the upload protocol. NM-4 and NM-5 are separate from the earlier LiveKit plan; link overlapping baseline/reconnect work instead of creating duplicate harnesses or retry owners.

## NM-0 — Reproducible baselines

Reuse `Client/tests/e2e/fullstack/fixtures.ts`, `fullstack/message-retry.spec.ts`, `native/pending-messages.spec.ts`, `message-list-scale.spec.ts` and existing server upload/metrics/lifecycle tests. Extend the application journeys rather than verifying behavior only through a test-owned store.

For each run record application SHA, build/runtime, backend, server capabilities, OS, fixture seed, data size, fault schedule and actual result. Use synthetic content/files. Keep secrets, message bodies and user files out of logs. Save redacted machine-readable results plus a human-readable comparison and all failed/invalid runs.

Run baseline-only pilots first, then at least 30 paired performance trials per core scenario, randomized AB/BA order on the same machine. Separate correctness outcomes from latency/resource outcomes. Report medians, p95 where sufficiently sampled, effect sizes and uncertainty; collect more samples if tail estimates are unstable. Do not pool failing platforms into an overall pass.

Test network faults against the actual upload/socket connection. A rejected Promise or fabricated progress counter can establish an error-handling contract, but cannot prove network-byte savings. Count bytes at the client transport/server boundary; verify the interruption point rather than assuming a timer equals 70% completion.

**Candidate files:** extend the existing test files listed above; add `Client/tests/e2e/support/non-media-performance.ts` and `Client/scripts/analyze-non-media-performance.mjs` only where existing helpers cannot serve the measurement. New paths in this plan are proposals, not files already present.

**State mutations:** test fixture data, controlled fault schedules and local result artifacts. No production behavior/settings change.

**Exactly two critical edge cases:** (1) A stale response arrives after the test switches account/channel. (2) A fault fires before the intended network/data boundary has actually been reached.

**Gate:** prove the journey traversed production code and the intended fault; clean up test processes/files; enforce existing lifecycle budgets. Skips, missing native prerequisites and unsupported scenarios are explicit unverified outcomes, not passes. Commit baseline tests separately from candidate behavior.

## NM-1 — Thread retry ownership

**Current evidence.** `Client/src/components/ThreadPanel.ts` owns a local retry map and clears it on destruction. The exact visible close/reopen outcome still needs reproduction because history reconciliation may retain or remove the optimistic row. OwnCord already has `Client/src/lib/pendingMessages.ts`; extend that model instead of creating a second durable queue.

### NM-1a: lock down the failure

Create a real thread, attempt a send while offline or lose the acknowledgement after server commit, close/destroy its panel, reopen and press Retry. Assert the authored content remains recoverable and that Retry works. Repeat through a desktop restart. Identify whether the broken invariant is a non-working retained row, disappearance of retry intent, or both. If current behavior already passes, record that result and investigate remaining cases before changing ownership.

### NM-1b: implement the smallest ownership change

Move pending thread send intent under the existing host/account/session owner. Preserve the original logical message ID across retries and preserve the exact payload fields used for server deduplication. Treat reply target, reply-ping choice and sticker identity as typed metadata; do not hide them inside a text string. Keep transport correlation IDs separate from the stable logical ID.

Version any persisted-envelope extension. Read existing text-only entries without inventing reply/sticker data. Recover browser drafts in memory under the existing policy; use the existing encrypted store on desktop. If saving fails or the queue is full, retain recoverable text in the active composer/failed row and make the failure visible rather than clearing it optimistically. Explicit discard/logout and late ACKs must share the existing serialized persistence owner.

**Candidate affected files:** `Client/src/components/ThreadPanel.ts`; `Client/src/lib/pendingMessages.ts`; `Client/src/platform/contracts/pendingMessages.ts` only if the contract actually changes; `Client/src/features/messaging/messageModel.ts` and message-store facade only if they need typed recovery metadata. Add a shared feature helper under `Client/src/features/messaging/` only if it removes duplicate ownership. Extend `Client/tests/unit/thread-panel.test.ts`, `Client/tests/unit/pending-messages.test.ts`, `Client/tests/e2e/fullstack/message-retry.spec.ts`, `Client/tests/e2e/native/pending-messages.spec.ts`; add `Client/tests/e2e/fullstack/thread-retry-recovery.spec.ts` for the combined journey. Update the relevant i18n catalog if the recovery explanation changes.

**State mutations:** existing pending-send records, optimistic row/correlation mapping, encrypted persistence envelope/version and per-panel presentation. Domain mutations continue through established facades/dispatcher boundaries. No new automatic-send owner.

**Exactly two critical edge cases:** (1) An ACK races panel recreation or encrypted-store loading. (2) Logout/discard/account switch occurs while a pending save or retry is in flight.

**Acceptance tests:** offline/timeout/send-rejected cases; reply/sticker metadata; two identical bodies with different logical IDs; multiple panels; desktop restart; corrupt/old envelopes; full/unavailable storage; expiry; restore floor; removed reply/sticker or revoked permission. Assert exactly one stored message per logical send, retained recoverable content, correct metadata and zero sends without the required user action. An unknown commit outcome must retry the same ID, never mint a fresh one that can duplicate an already-committed message.

**Promotion gate:** the reproduced baseline failure passes through UI and server receipt inspection; every applicable ownership/order test passes; existing main-channel recovery still passes; persistence limits/encryption and explicit recovery are preserved. Run at least 100 deterministic close/reopen/ACK-order cycles, plus native restart journeys. Do not claim this proves a zero production failure rate.

**Rollout/rollback:** first expose the changed recovery path to internal testing, then promote as a correctness fix after validation. A temporary flag may isolate rollout, but should not hide the existence of a confirmed data-recovery defect. Flag-off or rollback must retain and read already-written pending records: establish backward-compatible encoding or keep a compatible reader. Never discard drafts as rollback cleanup. If metadata cannot round-trip on an older reader, retain the typed record and offer explicit recovery rather than silently resending an altered payload.

## NM-2 — Resumable uploads

This is a capability addition, not a claim that OwnCord's current whole-file upload contract is defective. Prioritize the implementation only if interrupted large transfers matter enough to justify server protocol and staging complexity.

### NM-2a: value and feasibility experiment

Use a permitted large file under the configured upload cap, interrupt after verified 70% delivery, and measure total bytes/time until a successful attachment and message. Repeat on healthy/slow/lossy links and compare same-session retry versus application restart. Use a small-file control. Establish whether large files/network interruptions are actually relevant from available local/operator evidence; do not add remote analytics merely to answer this.

Compare a standard resumable protocol such as tus with extending the existing upload path. Evaluate dependency/maintenance cost, native transport/proxy compatibility, server quota enforcement, expiration, content validation, finalization and cleanup. Do not choose a protocol solely because backspace uses it.

**Decision gate:** demonstrate significant avoidable retransmission, a viable backend/platform path and a clear cancellation/expiry model. If no meaningful need is established, preserve whole-file behavior and retain the tests as a documented baseline.

### NM-2b: server session and commit semantics

Define create/status/append/finalize/cancel operations or the chosen standard equivalents. Bind every session operation to its authenticated owner and server. Reserve bounded staged storage/quota, enforce declared/actual size, reject invalid offsets and content, and verify a complete file before promotion. A completed attachment can be claimed by the existing message send; incomplete staging must never appear as a completed attachment.

Use a recoverable finalization state machine across database/file boundaries: idempotent finalize, a single completed attachment identity, crash cleanup/reconciliation and safe expiry. Do not pretend a filesystem rename and database commit are one atomic transaction. Reuse the existing content sniffing, policy and quota rules at the appropriate stages. Old servers/clients continue using the current endpoint. Advertise capability only after it is usable.

**Candidate server anchors:** `Server/api/upload_handler.go`, `upload_policy.go`, existing upload quota/body-cap/sniff/streaming/discard tests, the owning upload service/store interfaces discovered in pre-flight, and `Server/api/router.go`. Proposed new isolated API tests: `Server/api/upload_resume_test.go` and `upload_resume_crash_test.go`. A staged-session table requires an immutable new migration and SQL/query generation; protocol capability changes require editing the actual source schema and regenerating outputs. Exact migration numbers, handler ownership and generated files must be resolved against current `dev`, not guessed in this plan.

**State mutations:** staged transfer session/offset/expiry, reserved quota and temporary files, final attachment record and session finalization state. Session and message-commit identities remain distinct.

**Exactly two critical edge cases:** (1) Crash between file promotion and database finalization. (2) Retry/finalize arrives after cancellation, expiry or permission revocation.

### NM-2c: client recovery and platform integration

Resume from a server-confirmed offset; distinguish paused, failed, cancelled, expired and completed. Keep enough typed metadata to locate a supported local File/handle without promising cross-restart recovery on platforms that cannot retain it. Ask for re-pick when necessary and validate the file identity; filename and length alone are insufficient. Do not silently resume against a different file or server/account.

Keep the whole-file path for small files and unsupported servers/backends. Apply resume only where server and client capabilities agree. Preserve send-while-uploading behavior and completed attachment IDs. Reconcile a lost finalize response before starting another upload. Cancellation and late callbacks must not dispatch a message the user cancelled.

**Candidate client anchors:** `Client/src/lib/apiChannels.ts`; `Client/src/features/messaging/sendQueue.ts`/test and existing upload ownership; platform contracts plus desktop/browser transport implementations where needed. Proposed new helper/tests: `Client/src/features/uploads/resumableTransfer.ts`, its colocated tests and `Client/tests/e2e/fullstack/upload-resume.spec.ts`. Add native journeys for actual platform/proxy support. Resolve the existing composer/upload helper before choosing further touched files.

**State mutations:** owner-scoped transfer session metadata, latest confirmed offset, pause/cancel state and local-file availability. Reuse encrypted native storage if durable sensitive metadata is needed; preserve browser persistence policy. No file bytes or credentials in Web Storage/logs.

**Exactly two critical edge cases:** (1) The user re-picks a different same-name/same-size file. (2) Cancel/account switch supersedes an offset probe or finalize response.

**Combined acceptance gate:** verified hash and byte length; exactly one attachment and one logical message; no partial attachment visibility; no cross-owner access; bounded staging after cancel/expiry/crash. Test interrupted connection before/after append acceptance and before/after finalization, parallel offset requests, unsupported old servers, storage-full, expired sessions, no retained handle and server restart.

For the verified 70%-interruption experiment, proposed target is at least 50% less repeated payload traffic versus restarting the whole upload, with fewer remaining bytes/time consistent with measured link speed. On supported same-session recovery, retransmission should normally be limited to unconfirmed chunks; measure rather than assume chunk sizing. Small files should have no more than a 5% or 50 ms p95 latency penalty, whichever allowance is larger, and normal uploads must not consume materially more memory. Freeze exact measurement boundaries and file sizes before candidate trials.

**Flags/rollout:** proposed server `resumableUploadsV1` plus client capability gating, both off initially. Do not expose a toggle that enables unsupported native resume. Trial on internal synthetic files, then opt-in large-file use. Default changes are a separate evidence-backed decision.

**Rollback:** stop creating new sessions while retaining compatible status/cancel/finalize support for existing sessions until their documented expiry, or return a typed refusal that preserves the local file and offers whole-file retry with consent. Verify a possibly successful finalization before restarting. Never mark a partial file complete or delete a user's retained recovery source as rollback.

## NM-3 — Combined history and scroll acceptance tests

Borrow scenarios, not a replacement renderer. OwnCord already has watermark-based history merging, bounded windows, row virtualization, unread/anchor tests and lifecycle checks.

**Candidate files:** extend `Client/src/features/messaging/historyWindows.test.ts`, existing prepend/resize/resync-anchor unit tests and `Client/tests/e2e/message-list-scale.spec.ts`. Add `Client/tests/e2e/fullstack/history-race-journey.spec.ts` and a targeted Windows native equivalent. Runtime anchors, only if tests expose a gap: `features/messaging/historyWindows.ts`, `components/message-list/listWindow.ts`, `listScroll.ts` and their established state owner.

**State mutations:** initially only fixture history/events and test-controlled response ordering; later runtime changes require a separate pre-flight with the actual reducer/anchor mutations. Keep settled message identity and explicit detached-window semantics.

**Exactly two critical edge cases:** (1) A stale REST response lands after a live confirmation/edit/delete. (2) A saved anchor is deleted or displaced while a newer user jump is in flight.

**Test sequence:** open a 10,000-message synthetic channel at old history; delay a REST response; deliver live messages and optimistic confirmation; grow the composer/load images; delete the anchored row; reconnect; jump to search; then switch channel while work is pending. Split into reproducible scenarios with fixed orderings and seeded permutations, not a single flaky mega-test. Validate server truth, visible message order, logical identities, unread acknowledgements, focus/selection and viewport position.

**Acceptance gate:** no duplicate/resurrected messages, no fabricated continuity across an unloaded gap, no stale cross-channel write, no unintended mark-read, and no programmatic scroll overriding the newer user action. Proposed anchor tolerance is two CSS pixels after layout settles when the same row still exists; on deletion use the declared next-anchor rule instead. Preserve existing DOM/heap/lifecycle budgets and avoid more than 5% p95 navigation slowdown. Use Chromium, WebView2 and the supported native client presentation path where relevant. Browser pixels and resources cannot be proven by reducer tests alone.

**Adoption rule/rollback:** if current code passes, ship only stronger coverage. A demonstrated bug gets a narrow fix; do not rebuild the message list for architectural similarity. No runtime feature flag is needed for tests alone. A runtime rollback preserves stable store contracts and the existing virtual renderer.

## NM-4 — Honest latency-tail diagnosis

The intended gain is answering which operations become slow, not making queries faster by instrumentation. Audit existing metrics first and choose a missing question; stop if current route/command histograms plus pool waits already answer it.

**Candidate files:** `Server/internal/app/metrics_sampler.go`, `Server/api/metrics_handler.go`, the bounded histogram/window primitives under `Server/metrics/` and their tests. Exact operation instrumentation belongs beside its real DB/service owner. Proposed tests: `Server/metrics/db_latency_test.go` and `Server/api/metrics_latency_test.go`; extend the relevant dashboard component only after the metric is meaningful.

**Design:** define the timed interval explicitly. Connection acquisition, SQLite busy/lock delay, transaction lifetime and total query latency are different metrics. If acquisition cannot be measured without intrusive wrappers, expose a precisely named operation/transaction distribution and correlate with existing aggregate wait counters. Do not label total query time as pool wait or copy pqp's PostgreSQL pool patch. Keep bounded bucket counts, fixed low-cardinality operation names and short retention, with zero/insufficient samples represented honestly.

**State mutations:** bounded counter/histogram rings and diagnostic output; no transaction ordering, retry or timeout policy changes.

**Exactly two critical edge cases:** (1) A cancelled/failed operation must be counted once with the correct outcome. (2) An idle interval/reset must not retain a stale peak as current trouble.

**Tests/gate:** known synthetic distributions/bucket boundaries; no samples; retention rollover; counter reset; bounded allocations/concurrency; controlled SQLite writer/read contention. Reproduce a slow minority concealed by an average and show that the new output exposes it at the correct labeled boundary. Add a diagnostic exercise: identify the injected contention class using only the exported evidence. Proposed overhead limit is less than 2% median throughput loss and less than 5% p95 operation-latency increase under the same workload; document uncertainty and gather more runs if the result is ambiguous. No SQL, message bodies or user-specific metric labels.

**Flag/rollback:** initially diagnostic-only or off via the existing metrics configuration; introduce proposed `dbLatencyDetailsV1` only if no appropriate mechanism exists. Disabling removes recording/exposure, releases its owned sampler and leaves database calls/cancellation unchanged. Broader query performance changes need separate evidence and PRs.

## NM-5 — Deployment-specific shutdown/load experiment

OwnCord already provides restart notices and bounded ordered shutdown. Do not import a multi-instance drain-to-a-sibling design into a single-server deployment without a supported healthy destination.

**Candidate files:** tests around `Server/ws/hub.go`, `Server/internal/app/lifecycle.go`, existing replay/receipt/shutdown tests; proposed load harness `Server/cmd/smoke/restart_load.go`. A demonstrated need may lead to changes in the existing restart notice/client retry owner, or a paced server close sequence. Exact paths for notice/queue changes depend on which experiment wins; do not add another independent reconnect loop.

**Compare:** current shutdown, bounded post-outage client dispersion, and server-paced closure only where routing to a genuinely healthy supported destination exists. Test planned update/restore separately from abrupt process loss. Use 10/100/500 clients only where configured admission limits and the load generator permit them; report rejected/unsupported configurations explicitly. Use at least 20 independent restart events for the promoted scenario, not one event with many correlated clients.

**State mutations:** test socket cohorts initially; candidate runtime work changes only the existing admission/draining state, retry timing or close schedule. It must preserve event persistence, receipts and shutdown ownership.

**Exactly two critical edge cases:** (1) Clients reconnect to a process still draining. (2) The shutdown deadline expires with sockets or committed-message persistence still pending.

**Gate:** show overload or unacceptable spikes on baseline first. Proposed gain: at least 30% lower peak one-second reconnect attempt rate, with no new lost/duplicate logical sends, replay errors or failure to stop within the existing service-manager budget. Proposed p95 recovery penalty allowance is at most two seconds versus baseline for the same outage. Track admitted load, attempt rate, successful ready/replay, message receipts, outage duration and stop completion. Single-server users must not pay a longer outage for an unneeded sibling-handover optimization.

**Flag/rollback:** off-by-default, deployment-scoped configuration using the existing notice/shutdown owner. Disable restores current pacing and retry timing without dropping pending events or bypassing persistence. If no supported scenario benefits, retain only load regression coverage and close the experiment as not adopted.

## Evidence required to ship

For every behavior change attach the baseline failure/limitation, exact affected commits and runtime versions, raw redacted result files, test scenarios and platform coverage, paired comparison with uncertainty, remaining limits and demonstrated rollback. Treat baseline reproduction, unit/contract tests, real journeys and performance evidence as separate checks. Green CI alone is not proof of improvement; do not weaken assertions or budgets to admit a change.

Run repository-required checks through the documented workflow: client changes require static/unit and affected fullstack/native/accessibility journeys; Rust/native changes require the appropriate Rust/platform checks; server/protocol changes require all required Go build variants, race/deadlock/tag coverage, generated-drift and relevant integration tests. Installer builds remain in supported CI. Missing tools/hardware are unverified coverage, not successful checks. New dependencies and workflow changes require their existing repository checks.

Re-read `CLAUDE.md`/`AGENTS.md` before implementation. Each actual code PR needs a concrete pre-flight of affected files, state mutations and exactly two critical edge cases; this plan provides candidate anchors, not guessed final migration numbers or an irrevocable implementation design.

## TODO integration

Add one linked initiative with NM-0 through NM-5 and upload subtasks NM-2a/b/c in the canonical TODO/roadmap system. Search first for existing thread-retry, upload-resume, message-list, metrics and restart tasks, and update/link duplicates. Keep source-visible risks distinct from reproduced defects and separate investigation, tests, implementation and default-promotion milestones.

Place this full plan and the supporting non-media audit under the repository's established documentation convention, with durable repository-relative links. Link the earlier LiveKit adoption initiative where restart/load infrastructure overlaps; do not merge the distinct behavior changes into one large implementation task. Preserve the proposed gates, unresolved feasibility decisions and off-by-default/rollback requirements. TODO integration is documentation work only.
