# OwnCord comparison beyond LiveKit

> **About this copy.** Added 2026-11-01 at @J3vb's request as the durable repository copy of the owner's audit. It is the companion of the [non-media adoption plan](../plans/non-media-adoption-2026-11-01.md), which holds the tasks (NM-0 to NM-5) and their current state. The text below is the audit as written, with one edit: the links to its probe script and probe results are replaced by plain names, because those files were not supplied. They are **unavailable**, nothing here reconstructs them, and they are not repository tests.
>
> How to read the evidence: the nine probes ran the outside projects' pure functions against **synthetic** storage and sockets. They are not OwnCord application tests, did not run OwnCord's UI, network, disk or a deployed server, and prove no OwnCord defect or gain. The OwnCord findings are **source-visible** (read from code at `dev` `06caf6a3`); none was reproduced in a running client or server. `dev` was rechecked at `f68b3aa0` on 2026-11-01 (only `.github/workflows/nightly-test-depth.yml` differs), so the line links below still point at the same code.

Read-only comparative source audit, 1 November 2026.

## Scope and evidence

Compared the same three repositories in messaging/offline recovery, file transfers, history consistency and navigation, client resource management, and server operations. OwnCord root `CLAUDE.md`, `AGENTS.md` and server guidance were read before implementation exploration; client guidance had been read in the preceding audit. Synced `sources/` files were not touched.

Live remote branch checks returned the same heads as the previous audit, and the local source snapshots matched:

| Repository | Branch | Exact commit |
|---|---|---|
| J3vb/OwnCord | dev | `06caf6a3b729487a504f9750d9bc6985ad01b031` |
| TheZwiss/backspace | main | `2885a7d35c0e9188eb337ab238df992073e68df5` |
| rafaelcg/pqp | main | `e2f1acc262e73014b30bd47594495e4ea9f90c8a` |

Priorities describe adoption value, not a security severity score. This is a scoped comparison, not an exhaustive repository or security scan. Findings distinguish a source-visible correctness gap, a missing capability, and a useful test/measurement technique. Historical audit notes supplied leads only; current source was inspected before drawing conclusions.

**Validation performed:** nine direct source probes passed using Node 26.4.0. They exercised backspace's pure scroll-anchor functions and pqp's outbox, drain planner/batched-close routine and wait histogram. Storage and sockets were synthetic; no real network, disk persistence, UI, concurrent browser tabs or deployed service was exercised. The script (`non-media-audit-probes.mjs`) and its results (`non-media-audit-probe-results.json`) were not supplied with this copy and are unavailable; see the note at the top. Repository tests cited below were read, not executed. All three source snapshots remained clean.

## Overall assessment

OwnCord does not need wholesale replacement of its messaging or rendering architecture. It already has encrypted desktop pending-message persistence, stable logical send IDs, database delivery receipts, explicit retry intent, bounded history windows, actual row virtualization, replay recovery and lifecycle tests.

The strongest incremental opportunities are: bring thread replies under a durable/shared retry owner; add resumable uploads if large-file interruption is a meaningful user problem; borrow race/anchor test scenarios; expose database wait distributions; and consider paced shutdown only for deployment shapes that benefit from it. No comparative CPU, latency or reliability advantage has been demonstrated across running applications in this audit.

## 1. P1 — Make thread retry payloads survive destruction of the thread view

**Classification:** source-visible lifecycle gap; current UI reproduction still required before remediation. Highest priority because the consequence is user-authored text that cannot be retried through its existing control.

**OwnCord evidence.** `Client/src/components/ThreadPanel.ts:122` creates a panel-local `drafts` map. `sendText` stores offline and online retry payloads in it (`423–492`); `retrySend` returns immediately if the map lacks the correlation ID (`495–500`). `destroy` clears the map (`681–690`). Optimistic rows themselves are written to the shared message store, so view lifetime and retry-payload lifetime differ. The thread send path inspected does not call the existing `PendingMessageQueue.put` persistence path.

This establishes that destroying the panel discards its retry payload. The resulting visible failure depends on the host/history reconciliation sequence: a retained failed row can lack a working retry payload, or a refetch may remove the row. The exact close/reopen behavior was not re-run in a browser during this audit. Do not claim that every thread send is lost or that all OwnCord sending lacks persistence.

**What others implement.** Backspace keeps pending bubbles outside the view in `packages/web/src/stores/pendingMessageStore.ts`: content, reply target, transfer IDs, state, expiry and retry count are part of a persisted store. Pqp's `client/src/lib/outbox.ts` stores stable nonce/channel/body/reply entries and `hooks/use-chat.ts` restores bubbles and replays on readiness. This is evidence for separating send ownership from component ownership, not a reason to copy their storage or automatic-send policy.

**Useful adoption.** Extend OwnCord's account/server-owned pending-send model to cover thread retry intent and its metadata. Reuse its logical `clientMessageId`, encrypted desktop store, explicit recovery click and restore-floor checks. Model replies/stickers deliberately: `PendingTextMessage` currently carries only client ID, channel, content and creation time; stuffing reply/sticker metadata into body text would be the wrong extension.

**Feasibility: medium. Risks:** late ACK after reopen, duplicate resend, restored database refusing an older ID, account/server switch, sticker/reply metadata and accidental automatic delivery. Do not replace OwnCord's encryption with another project's plain Web Storage. Do not quietly adopt pqp's auto-replay behavior: OwnCord intentionally requires a click for recovery.

**Tests to establish the gain:** fail a thread send, destroy/recreate its panel and retry; restart the desktop app and recover; ACK before/after the persistence load; two identical messages with distinct logical IDs; explicit discard; reply/sticker retry; logout/server switch; expired/restore-refused receipt. Assert one logical server message, preserved metadata and no send without user intent. Extend `Client/tests/unit/thread-panel.test.ts`, `tests/unit/pending-messages.test.ts` and native pending-message journeys. The user-visible close/reopen regression should fail on the affected baseline before changing ownership.

Sources: [OwnCord thread retry](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/components/ThreadPanel.ts#L423), [panel destruction](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/components/ThreadPanel.ts#L681), [existing encrypted outbox](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/lib/pendingMessages.ts#L1), [backspace shared pending state](https://github.com/TheZwiss/backspace/blob/2885a7d35c0e9188eb337ab238df992073e68df5/packages/web/src/stores/pendingMessageStore.ts#L8), [pqp outbox](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/client/src/lib/outbox.ts#L27).

## 2. P1 — Resumable uploads, rather than restarting a large file

**Classification:** demonstrated implementation/capability difference, not a defect in OwnCord's current upload contract. Priority depends on file sizes and observed interruption rates.

**Backspace evidence.** `packages/web/src/stores/transferStore.ts:255–303` constructs a tus upload with 5 MiB chunks and retry handling. `resumeUpload` (`347` onwards) first tries the in-memory File, then a retained file handle, and uses a valid unexpired upload URL; otherwise it starts a new session when the file is available. This is not a guarantee that every browser resumes after restart: without an available File/handle it can require the user to pick the file again. Persistence around `690` keeps meaningful transfer state rather than serializing live Upload objects.

The server side is present: `packages/server/src/routes/files.ts:104` creates a tus server with a staged file store/expiry; request/create hooks check authentication, ownership, rate/size and metadata; finish processing at `229` onwards promotes the completed file; `/api/files` routes delegate to the tus handler at `400–406`. This is a working client/server implementation path, not just a dependency in a manifest.

**OwnCord delta.** `Client/src/lib/apiChannels.ts:325–343` creates FormData and posts the whole file to `/uploads`. `features/messaging/sendQueue.ts` can wait for uploads, preserve settled IDs and re-upload an old/lost attachment when its File is available, but that is different from resuming at a confirmed byte offset. Pqp's upload APIs use mint/PUT/claim-style flows; that alone does not establish a resumable upload protocol to copy.

**Useful adoption.** Prototype resumable large-file transfer behind an advertised server capability, retaining the existing whole-file path for small files and older servers. Prefer a standard protocol if its total client/server cost is justified. Keep message commit separate from transfer completion, with a single logical send referring to completed attachment IDs.

**Feasibility: medium–large. Risks:** staged quota reservation, expiry cleanup, permissions after interruption, content/metadata validation at completion, crash during promotion, file identity on re-pick, native transport/proxy support and server-version compatibility. Backspace's browser file-handle persistence is not directly portable to OwnCord's Tauri platform contract. Do not copy its endpoints or object format without mapping these boundaries.

**Tests to prove improvement:** interrupt a permitted large synthetic file after roughly 70% delivery, resume in-session and after restart where supported, then verify final bytes/hash and a single attachment/message. Measure retransmitted bytes against OwnCord's restart baseline. Proposed target: at least 50% less repeated upload traffic in that scenario, no partial file visible as complete, and no material small-file latency regression. Add expired-session, no-file-handle, wrong re-picked file, explicit cancel, quota exhaustion and crash-before/after-promotion tests. Inspect `transferStore.upload.test.ts`, `utils/tusHooks.test.ts` and `storageJanitor.tus.test.ts` as scenario references; mocked Upload tests do not prove network resumption.

Sources: [backspace transfer implementation](https://github.com/TheZwiss/backspace/blob/2885a7d35c0e9188eb337ab238df992073e68df5/packages/web/src/stores/transferStore.ts#L255), [resume path](https://github.com/TheZwiss/backspace/blob/2885a7d35c0e9188eb337ab238df992073e68df5/packages/web/src/stores/transferStore.ts#L347), [server protocol](https://github.com/TheZwiss/backspace/blob/2885a7d35c0e9188eb337ab238df992073e68df5/packages/server/src/routes/files.ts#L104), [OwnCord upload](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/lib/apiChannels.ts#L325), [OwnCord upload/send queue](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/features/messaging/sendQueue.ts#L147).

## 3. P2 — Adopt history/scroll race scenarios as cross-feature acceptance tests

**Classification:** test/contract improvement candidate. OwnCord already implements much of the relevant behavior; no missing virtualization or general scroll defect was established.

**Pqp evidence.** `client/src/hooks/use-chat.ts:957–1023` merges fetched history with pending and live rows, distinguishes tail windows from detached history, sorts settled rows, retains still-pending rows and increments a window generation. Its comments describe prior bugs, but this audit relies on the actual merge predicates and state writes, not the historical incident claims.

**Backspace evidence.** `packages/web/src/components/chat/scrollAnchor.ts` expresses one anchor as bottom or a message ID plus viewport offset. Saved reading position, unread opening and actual numeric server IDs are distinct. `MessageList.tsx` applies anchor logic during history replacement, jump/restore, content/viewport resize and load events. `MessageList.anchor.test.tsx:123–239` covers composer growth, reload under a reading position, fetching around a missing anchor, deletion, remount and superseding jumps. The unread tests also check that opening old unread content does not mark it read prematurely.

**OwnCord baseline.** `features/messaging/historyWindows.ts:85` onwards already has bounded REST/live reconciliation, a fetch-start watermark, pending-echo reconciliation, object reuse and splice/detach rules. `components/message-list/listWindow.ts` virtualizes rendered rows. Existing tests include `historyWindows.test.ts`, `message-list-prepend-scroll-anchor.test.ts`, `message-list-resize-anchor.test.ts`, `message-list-resync-anchor.test.ts` and `tests/e2e/message-list-scale.spec.ts`. Therefore adopting another full message-list implementation would duplicate existing work and risk losing its bounded DOM behavior.

**Useful adoption.** Create a shared end-to-end scenario contract combining these interactions: while reading old history, receive a live message, confirm an optimistic send, replace a stale REST page, resize an image/composer, delete the anchor, reconnect and jump to a search result. Check continuity, unread state, message ordering and visual position together. Start with tests; change a reducer or anchor owner only if a real gap is demonstrated.

**Feasibility: high for tests, potentially substantial for refactoring. Risks:** numeric versus string/snowflake IDs, virtual row height estimates, unloaded gaps, user scroll overriding a programmatic anchor, selection/focus and accessibility. Pqp's `message-list.tsx:227–228` uses CSS `content-visibility`/intrinsic-size hints; this is not evidence of a lower DOM count than OwnCord's actual row windowing.

**Tests/gate:** real browser and WebView2, 10,000-message synthetic history with images, old-history jump, delayed REST response and live edits/deletes. Assert no duplicates/resurrected deleted rows, no discontinuous append into a detached window, no unintended read acknowledgement, and preserved visible anchor within a small measured pixel tolerance after layout settles. Preserve existing DOM/resource budgets. Measure p95 navigation latency and retained DOM/heap before considering any rendering change. The three direct anchor probes passed, but they do not establish browser pixel stability.

Sources: [pqp page merge](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/client/src/hooks/use-chat.ts#L957), [backspace anchor model](https://github.com/TheZwiss/backspace/blob/2885a7d35c0e9188eb337ab238df992073e68df5/packages/web/src/components/chat/scrollAnchor.ts#L14), [anchor regressions](https://github.com/TheZwiss/backspace/blob/2885a7d35c0e9188eb337ab238df992073e68df5/packages/web/src/components/chat/MessageList.anchor.test.tsx#L123), [OwnCord reconciliation](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/features/messaging/historyWindows.ts#L85), [OwnCord virtualization](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/components/message-list/listWindow.ts#L491).

## 4. P2 — Show database wait tails, not only aggregate wait counters

**Classification:** operational observability improvement, not evidence that OwnCord's database is currently overloaded.

**Pqp evidence.** `server/src/lib/pool-wait.ts` keeps bounded minute-bucket histograms, p50/p95/p99 bucket bounds, maximum and counts of waits at least one second. `server/src/db.ts:994–1006` actually calls `notePoolWait` around checkout completion/error paths. The histogram is connected to database activity, not an unused dashboard helper. It bounds history to 60 minutes and guards accounting from throwing into the pool callbacks.

**OwnCord baseline.** `Server/internal/app/metrics_sampler.go:41–57` reads reader/writer `sql.DBStats.WaitCount` and `WaitDuration`; `Server/api/metrics_handler.go` exposes counts and seconds in its windowed output. These are valuable aggregate wait measurements, but count plus total duration does not reconstruct a wait distribution. Existing route/command histograms do not automatically identify acquisition waits.

**Direct probe.** Nineteen synthetic 1 ms checkouts plus one 1,500 ms checkout produced a mean below 100 ms while the p99 bucket exposed the slow wait and the one-second threshold count was one. Advancing time past retention removed the observations. This demonstrates why a mean can conceal a tail; it is not a measurement of OwnCord or pqp production traffic.

**Useful adoption.** Add a bounded distribution at a defined OwnCord operation boundary and label it precisely. In Go/SQLite, timing an entire query is not the same as timing connection acquisition or writer-lock wait. If exact acquisition instrumentation needs an intrusive wrapper, first add honest transaction/operation latency distributions and use aggregate pool waits to correlate. Reuse OwnCord's metrics window machinery; do not transplant pqp's PostgreSQL pool monkey-patching.

**Feasibility: medium. Risks:** changing context/cancellation behavior while wrapping DB access, adding latency on every query, mislabeled acquisition time, inaccurate quantiles from sparse samples and unbounded label cardinality.

**Tests/gate:** synthetic known distributions, bucket boundaries, idle/empty windows, counter reset, cancellation, bounded allocations and no query/body text in labels. On a controlled SQLite reader/writer contention rig, show a short burst ages out and the slow operations appear in the appropriate bucket. Demonstrate instrumentation overhead before enabling. The gain is better diagnosis, not improved database speed by itself.

Sources: [pqp histogram](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/server/src/lib/pool-wait.ts#L97), [checkout integration](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/server/src/db.ts#L994), [OwnCord counters](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Server/internal/app/metrics_sampler.go#L41).

## 5. P3 — Consider paced application-socket shutdown for large deployments

**Classification:** deployment-dependent scalability technique. This is separate from the earlier LiveKit retry audit and is not an unconditional recommendation for a single self-hosted server.

**Pqp evidence.** `server/src/lib/drain.ts:161–197` snapshots the live socket collection, closes it in batches with randomized spacing, and closes the remainder when its deadline expires. `drainPlan` chooses pacing from client count/rate within a budget. `server/src/index.ts:906–942` marks draining, obtains the plan and invokes the routine. `drain.test.ts` covers exact-once visitation, sockets appearing after the snapshot, exceptions, deadlines and health verdicts. This audit's planner/batching probes passed against synthetic sockets.

**OwnCord baseline.** `Server/ws/hub.go:334–361` broadcasts a restart notice with a five-second window, then closes clients, stops voice grace timers and stops LiveKit in a defined order. `Server/internal/app/lifecycle.go` owns bounded staged shutdown. It would be wrong to describe OwnCord as lacking graceful shutdown.

**Useful adoption.** If restart/load experiments show synchronized application reconnect overload, consider either a bounded retry hint that disperses clients after the announced outage or paced closure when another healthy destination is actually available. Prefer the existing restart notice and shutdown owner. Multi-instance drain-to-a-sibling assumptions cannot be carried over to a single-server SQLite deployment: spacing socket closes against a server that is about to disappear may simply delay shutdown.

**Feasibility: medium; value: conditional. Risks:** exhausting the service manager's stop budget, accepting work during draining, clients reconnecting to the same draining process, losing replay/receipt durability and changing restore/update notice semantics. Do not add multi-instance architecture just to borrow the drain loop.

**Tests/gate:** 10/100/500 controlled clients, admitted-load limits verified, planned update and unexpected outage separately, one healthy destination versus none, reconnect attempts per second, successful message receipt/replay and shutdown duration. Adopt only if peak restart load materially drops without lost logical sends or unacceptable recovery delay. Preserve existing countdown semantics and teardown order. Keep the current route as rollback. No live restart/load run was performed here.

Sources: [pqp bounded drain](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/server/src/lib/drain.ts#L161), [server integration](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/server/src/index.ts#L906), [OwnCord graceful stop](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Server/ws/hub.go#L334).

## Existing strengths and approaches to avoid transplanting

| Area | Compared code | Assessment |
|---|---|---|
| Pending-message persistence | OwnCord `Client/src/lib/pendingMessages.ts`, desktop/browser implementations; pqp `client/src/lib/outbox.ts`; backspace pending store | OwnCord already bounds count, bytes and age, isolates host/account ownership and uses native encrypted storage. Browser builds deliberately stay in memory. Pqp uses localStorage and automatically flushes; its save caps newest rows. These are product/privacy tradeoffs, not a reason to replace OwnCord. Sequential foreign-row merge passed the probe; it does not prove atomic concurrent-tab updates. |
| Idempotent sends | OwnCord `Server/db/message_delivery.go`/receipt queries; pqp `server/src/services/messages.ts:813–900` and nonce uniqueness | Both have server-side deduplication mechanisms. Keep OwnCord's payload/receipt and restore-floor semantics. A new persisted client queue without server dedup is unsafe, but OwnCord does not need dedup invented again. |
| Recovery after missed events | OwnCord `Server/ws/replay.go`, event persister and client generation/ACK logic; pqp ready-triggered history/outbox refresh; backspace ready snapshots | These are different recovery contracts. Do not replace sequence/replay with unconditional full-page reload or assume a cached snapshot repairs every event class. Borrow scenario coverage and load measurements. |
| History/desktop resource management | OwnCord `listWindow.ts`, `lib/prefs/mediaVisibility.ts`, message-list scale and lifecycle tests; pqp CSS `content-visibility` and stable row data | OwnCord already has actual windowed row rendering, offscreen/blur GIF freezing, shared still caching and lifecycle ownership. No comparative RAM/CPU result shows that swapping rendering systems would improve it. Preserve these while measuring mixed-content long sessions. |
| Background refresh | Pqp `hooks/use-member-roster-refresh.ts` and `lib/config-refresh.ts`; OwnCord WebSocket wake probes/dispatcher updates | Pqp pauses roster polls when hidden, debounces nudges, and uses a roster token/count before trusting a lean status response. Useful scheduling principles. OwnCord's pushed state should not be replaced by polling. If a specific HTTP cache remains stale, add bounded, visible-only refresh to that owner only after reproducing it. No current OwnCord cache-staleness defect is claimed here. |

Sources: [OwnCord browser policy](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/platform/browser/pendingMessages.ts#L1), [delivery receipts](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Server/db/message_delivery.go#L1), [pqp transactional send](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/server/src/services/messages.ts#L813), [OwnCord replay](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Server/ws/replay.go#L1), [OwnCord media lifecycle](https://github.com/J3vb/OwnCord/blob/06caf6a3b729487a504f9750d9bc6985ad01b031/Client/src/lib/prefs/mediaVisibility.ts#L1), [pqp visible-only roster refresh](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/client/src/hooks/use-member-roster-refresh.ts#L145), [pqp refresh registry](https://github.com/rafaelcg/pqp/blob/e2f1acc262e73014b30bd47594495e4ea9f90c8a/client/src/lib/config-refresh.ts#L43).

## Suggested next order

1. Reproduce thread retry after panel destruction in a real journey and extend the existing pending owner if it fails. This is narrower and more valuable than replacing the whole outbox.
2. Gather upload interruption/file-size evidence; build a resumable-transfer feasibility experiment if the user benefit justifies a client/server protocol addition.
3. Add combined history/scroll race journeys. Preserve existing passing reducer and virtualization behavior; refactor only for a demonstrated gap.
4. Add honest latency-tail observability where current metrics cannot answer an operational question.
5. Evaluate paced application-socket drain only when restart-load data shows a problem and the deployment can use it.

Any future adoption should use small PRs to `dev`, targeted failing-then-fixed regressions, the repository's required CI/check workflow, and baseline/candidate experiments before changing behavior. Numerical improvement targets above are proposed experiment gates, not results. This audit created only external report/probe artifacts; it made no application changes, TODO edits, GitHub writes or PRs.
