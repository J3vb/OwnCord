# OwnCord LiveKit adoption plan

**Status:** planned, not started (2026-11-01). Design only: no implementation, no default change and no dependency change has been made for it. Every benefit below is unproven and every number is a proposed acceptance target. Track the work in the [task list](#task-list) below and record state changes in this line and in the [plan index](README.md).

> **About this copy.** Added 2026-11-01 at @J3vb's request as the durable repository copy of the owner's planning document. Everything from [Outcome and evidence boundary](#outcome-and-evidence-boundary) down is the plan as written; the only edit is the audit reference. The companion audit (`2026-11-01-livekit-repository-audit.md`) was not supplied with the plan, so it is **unavailable** here and nothing in this file restates it. The audited `dev` snapshot `06caf6a3` already contains #3063 (wide full-screen H.264 share kept on the graphics card).

## Task list

One task per plan section, in the plan's order. Implementation starts with LK-0; each behaviour change ships off by default, one behaviour per PR, and changes a default only after a separate default proposal backed by paired comparative results (see [Rollout](#rollout-and-proof-required-before-changing-defaults)). E2EE stays on in every test, and native Linux coverage is kept wherever a task touches the native path.

<!-- prettier-ignore -->
| Task | Plan section | Depends on | Proposed flag | Ships when | State |
| --- | --- | --- | --- | --- | --- |
| LK-0 Real-media measurement baseline | [0](#0--measurement-foundation) | none | none (test-only) | harness gate met: counters agree, presentation/audio proved, impairment observable, overhead within target | todo |
| LK-1 Accurate stream-limit diagnostics | [1](#1--accurate-stream-explanations) | LK-0 | `shareContextualDiagnosticsV1`, off | fixed suite has zero connection-blaming warnings on healthy capped cases, classification and usability targets met | todo |
| LK-2 Muted screen-audio delivery suppression | [2](#2--suppress-delivery-of-muted-screen-audio) | LK-0; an end-to-end check that the SDK/SFU pair supports audio delivery pause | `screenAudioDeliveryV1`, off, capability-gated | RTP saving and restore-delay targets met with one audible path and no plaintext delivery | todo |
| LK-3 Conditional first-picture improvement | [3](#3--improve-the-first-picture-only-if-the-baseline-needs-it) | LK-0 startup baseline showing a gap | `shareEarlyQualityV1`, off, backend-gated | only if the baseline shows a gap; otherwise regression tests only | todo (conditional) |
| LK-4a Bounded reconnect jitter | [4a](#4a--spread-automatic-reconnects) | LK-0 restart-load baseline | `voiceReconnectJitterV1`, off | peak reconnect-rate, recovery-success and recovery-penalty targets met over 20 independent restarts | todo |
| LK-4b Conditional watch restoration | [4b](#4b--preserve-watch-intent-across-the-same-shares-recovery) | LK-0; a reproduced lifecycle gap; a protocol prerequisite only if metadata cannot prove continuity | `shareWatchRecoveryV1`, off | only for reproduced gaps; otherwise tests only | todo (conditional) |
| LK-5 Motion/text quality choice | [5](#5--motiontext-choice) | LK-0; matrix of the existing `shareMotionPolicy` arms | existing policy plus an off-by-default UI flag if needed | OCR and presented-FPS targets met at identical bitrate and size; current default kept | todo |
| LK-6 Optional capture/audio health diagnostics | [6](#6--optional-diagnostic-follow-ups) | LK-0; separate proposal after LK-1 to LK-5 gains | `shareCaptureHealthV1` (capture); opt-in (audio) | diagnostic-only first; zero warnings on healthy fixtures, detection targets met | optional |

## Relation to existing plans and work

- [screen-sharing-pipeline-2026-10-25](screen-sharing-pipeline-2026-10-25.md) (paused after PR 2) built the per-layer sender stats, the bounded `shareDiagnostics.ts` recorder, the `shareMotionPolicy` test switch and the motion/text clip recipes that LK-0, LK-1 and LK-5 reuse. LK-5 is the measured follow-up to that plan's manual motion/text policy step; it does not replace it, and it keeps today's smooth-motion default.
- The sender stats readout from the media phase (`shareSenderStats.ts`, "what limits the share") is what LK-1 makes contextual. LK-1 does not add a second readout.
- The planned Windows share picker and native capture work also changes `Client/src/lib/voice/` share start, change-source and reconnect paths. LK-0 records which capture path a Windows run used, and LK-6's capture-health check waits until that capture path is chosen.

---

Prepared 1 November 2026. Planning only: no implementation, default changes, commits or PRs.

## Outcome and evidence boundary

Adopt the useful ideas from pqp and backspace in small, independently measurable changes. First make stream problems understandable, reduce delivery nobody hears, then improve first-picture and reconnect behavior where the baseline demonstrates a gap. Preserve OwnCord's existing codec selection, E2EE, native Linux adapter and manual video-demand control.

The audited OwnCord snapshot is `06caf6a3b729487a504f9750d9bc6985ad01b031`. Its `dev` head was checked again while preparing this plan and still matched. Source comparison: the companion audit (`2026-11-01-livekit-repository-audit.md`; not in this repository, see the note at the top). Pqp ideas refer to `e2f1acc262e73014b30bd47594495e4ea9f90c8a`; backspace ideas to `2885a7d35c0e9188eb337ab238df992073e68df5`.

Confirmed code behavior and candidate benefits are different:

| Confirmed in the inspected source                                                   | Benefit still to establish in OwnCord                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| OwnCord exposes raw sender limitation labels and has detailed per-layer statistics. | A contextual explanation is more accurate and helps people choose the right action.                           |
| Watched screen audio remains subscribed when its playback is muted/deafened.        | Publication delivery control reduces actual SFU traffic and restores sound promptly on the supported backend. |
| View dimensions are currently applied only to subscribed publications.              | An early request makes the first picture clearer/faster without extra sustained traffic.                      |
| Application reconnect delays are deterministic.                                     | Jitter materially reduces restart load without unacceptable recovery delay.                                   |
| OwnCord preserves some watch state, but also forgets ended/unpublished shares.      | Specific reconnect/republish sequences need additional share-lifecycle memory.                                |
| Motion/detail experiment arms already exist.                                        | A simple user choice improves readability or motion for the intended content.                                 |

No performance gain has been measured in this planning work. Every numerical gate below is a **proposed acceptance target**, not a finding. Calibrate test noise on baseline-only pilot runs, freeze the gates before comparing candidates, and record any later gate change with its reason. If baseline already meets a need and the candidate adds no material benefit, retain baseline.

## Ordered delivery

| Order | Change                                             | Expected benefit                                      | Effort / risk              | Adoption decision                               |
| ----- | -------------------------------------------------- | ----------------------------------------------------- | -------------------------- | ----------------------------------------------- |
| 0     | Extend the existing real-media measurement harness | Makes all later decisions trustworthy                 | Medium / low               | Required foundation; no media-policy change     |
| 1     | Contextual stream diagnostics                      | Fewer misleading explanations; easier troubleshooting | Small–medium / medium      | Accuracy and usability evidence                 |
| 2     | Pause delivery of muted screen audio               | Direct, measurable bandwidth saving                   | Medium / medium            | RTP savings and restoration gates               |
| 3     | Early quality requests for watched shares          | Clearer/faster first picture                          | Medium / medium            | Implement only if startup baseline shows a gap  |
| 4a    | Bounded reconnect jitter                           | Less load after an SFU restart                        | Small / low–medium         | Restart-load improvement and recovery gates     |
| 4b    | Share-aware watch restoration                      | Less clicking/reconfiguration after recovery          | Medium–large / medium–high | Implement only for reproduced lifecycle gaps    |
| 5     | Motion/text choice using existing policies         | Better fit for films/games versus text                | Medium / medium            | Content-specific visual and motion results      |
| 6     | Targeted capture/audio health diagnostics          | More actionable failure recovery                      | Medium–large / high        | Optional; evidence-gated, diagnostic-only first |

Orders 1 and 2 are the first user-facing benefits. Startup and reconnect are conditional because the audit did not reproduce defects there. Do not bundle them with a new codec default, SDK upgrade, simulcast change or adaptive-stream architecture migration.

## 0 — Measurement foundation

**Extend existing infrastructure.** OwnCord already has `Client/tests/e2e/fullstack/media.spec.ts`, real server/SFU fixtures, `support/media.ts`, native voice interoperability, Windows native tests and lifecycle probes. The installer pins LiveKit server 1.13.11; the client pins JS SDK 2.23.0. Reuse these fixtures and the bounded local `shareDiagnostics.ts` recorder. Do not introduce a second stand-alone fake room as performance evidence.

**Candidate file map.** Modify `Client/tests/e2e/support/media.ts` and extend `Client/src/lib/voice/shareDiagnostics.ts` only where existing fields are insufficient. Add `Client/tests/e2e/support/stream-performance.ts`, `Client/tests/e2e/fullstack/stream-performance.spec.ts`, `Client/tests/e2e/native/stream-performance.spec.ts`, and `Client/scripts/analyze-stream-performance.mjs`. Extend `Client/tests/e2e/native-voice/interop.spec.ts` for native coverage. These additions are proposed paths. Exact touched files must be reconfirmed in each implementation pre-flight.

**Measurement contract.** Each result records application SHA, SDK/SFU/runtime versions, backend, OS, GPU/driver, actual encoder, codec, feature flags, source dimensions/FPS, viewer layout, network profile and scenario seed. Record:

- Watch click → first decoded frame, first presented frame and first presented frame at the requested quality. Use viewer-local monotonic time; a frame decoded but never presented does not finish the visible-start timer.
- Per-RID active state, encoded dimensions, measured source FPS, encoded/sent FPS, RTP bytes, encode time, target bitrate, requested/applied per-layer ceiling and limitation. Keep missing values unknown and distinguish settings from measured capture rates.
- Receiver decoded/presented FPS, dimensions, freeze/gap durations, loss, jitter and payload byte deltas. Use presentation callbacks where supported; explicitly identify the fallback backend.
- Screen audio and microphone RTP counters separately; decoded audio progression and captured test-output audio for restoration/duplicate-playback tests. Packet receipt alone does not prove audible output.
- Reconnect attempt timing/rate, membership, E2EE readiness, resumed decoded media and final watch/volume/mute state.
- Whole client process-tree CPU and memory, including native media/GPU processes, plus tracks, peer connections, listeners and timers after teardown.

The existing media probe includes synthetic fault mechanisms. They remain useful for deterministic regression tests, but forged `getStats()` values cannot establish bandwidth savings or performance. Apply real traffic shaping at the network boundary. Browser HTTP request throttling is not evidence that WebRTC UDP was constrained. Use an isolated network namespace/shaper or a controlled gateway on the test rig; record observed throughput to verify it worked.

**Controlled inputs.** Use repeatable text/scroll, high-motion, still-slide and dark/moving fixtures. Keep source, bitrate, codec, encoder, viewer size and capture mode fixed between control/candidate. Pair trials on the same machine and randomize AB/BA order. Do not compare different codecs as if the feature alone caused the change. Dynamic fixtures need frame markers for visual/gap comparison; do not infer freezing from no new frames on a still slide.

**Sample plan.** Begin with 10 baseline pairs to validate the harness, then at least 30 paired trials per decision scenario, spread across three sessions. Startup promotion needs at least 100 starts per core supported runtime; reconnect needs 20 independent SFU restart events with multiple clients, not 20 correlated clients from one event. Report effect sizes and paired confidence intervals; use 95% intervals for median deltas. Treat p95 as inconclusive if the sample cannot support a stable estimate, and collect more runs before promotion. Do not pool all GPUs into a passing average that hides one failing cohort.

**State mutations.** Test-only counters, bounded recorder buffers and local result artifacts; no publishing, subscription or production settings change. Preserve the recorder's 180-sample/2 MiB bounds unless separately justified. Benchmark collectors may write longer synthetic-fixture runs to test artifacts. No tokens, keys, captured user content or new remote telemetry.

**Exactly two critical edge cases.** (1) A sender/publication changes mid-sample and counters reset. (2) A run ends while an asynchronous stats read is pending.

**Gate.** Independent browser/native counters agree within one sampling interval; fixture markers prove actual presentation/audio; impairment is observable; teardown meets existing lifecycle requirements. Invalid, skipped or unsupported runs cannot count as passes. Measure instrumented versus uninstrumented baseline; proposed maximum is 2 percentage points of client CPU and 5% decoded-FPS loss at p95. If exceeded, reduce instrumentation before testing candidates.

## 1 — Accurate stream explanations

**Implementation.** Add applied-ceiling and target-bitrate evidence to the existing sampler. Introduce a pure classifier with outputs such as configured limit, probable link pressure, CPU pressure, paused and unknown. Match the selected sending layer with its own cap and the policy responsible for it. A lower layer selected by the viewer is not evidence of bad internet. Initially record classifications in the diagnostic view only; add sustained, dismissible warnings after validation. Start with a ten-second warning window as an experiment, not a borrowed universal threshold.

**Candidate files.** Modify `Client/src/features/voice/shareSenderStats.ts`, its colocated test, `Client/src/components/video-grid/streamInfo.ts`, `Client/src/lib/voice/shareDiagnostics.ts`, `Client/src/lib/voice/shareFlags.ts`, `Client/src/features/settings/LogsTab.ts` and `Client/src/i18n/voice.ts`. Add `Client/src/features/voice/shareLimitation.ts`, `shareLimitation.test.ts` and `Client/tests/e2e/fullstack/stream-diagnostics.spec.ts`. Supply the effective applied caps from `Client/src/lib/voice/videoPresets.ts`/the existing publish owner, avoiding a second copy of bitrate arithmetic. Any warning UI must be integrated into the existing stream surface.

**State mutations.** Per-share evidence window/classification, UI warning visibility and a local opt-in experimental flag; consumers are the stream readout and local recorder. No new voice-store writer or recovery controller.

**Exactly two critical edge cases.** (1) A user cap or selected lower layer mimics congestion. (2) A paused/replaced layer retains stale limitation values or lacks target bitrate.

**Tests and gate.** Unit fixtures cover low manual caps, policy caps, missing fields, paused layers, counter resets and transition hysteresis. Real-SFU tests cover healthy capped traffic, shaped bandwidth, stable CPU pressure and no viewers. Healthy capped/paused/unknown cases must produce zero connection-blaming warnings in the fixed suite. Supported sustained impairments should classify correctly in at least 95% of labeled steady windows and clear within five seconds after recovery. Unknown remains unknown when the evidence is inadequate; never manufacture classification coverage. Add a small blinded usability check: users should select the correct next action in at least 80% of representative scenarios, with no increase in wrong network advice versus baseline.

**Flag/rollback.** Proposed `shareContextualDiagnosticsV1`, off by default. Disable the classifier UI and warning window without changing sender settings; restore the existing readout. Baseline raw metrics remain available.

## 2 — Suppress delivery of muted screen audio

**Implementation.** Start only with audio from an already-watched screen share. Keep local muting immediate. After an experimental 750 ms grace, request delivery pause using a capability the backend actually supports. Resume on unmute without changing stored volume/mute intent. Leave microphone deafen/subscription behavior with its existing owner. Reconcile late publications and explicit stop-watching. A backend without verified audio-pause capability keeps current behavior.

**Candidate files.** Modify `Client/src/lib/voice/audioElements.ts`, `Client/tests/unit/audio-elements.test.ts`, `Client/src/lib/voice/shareFlags.ts`, `Client/src/features/settings/LogsTab.ts` and the owning publication lifecycle callbacks if necessary. Add `Client/src/features/voice/screenAudioDelivery.ts`, `screenAudioDelivery.test.ts` and `Client/tests/e2e/fullstack/screen-audio-delivery.spec.ts`. Add native support in a separate follow-up only if the Rust SDK provides an appropriate control: `Client/src/features/voice/native/nativeRoom.ts`, `Client/src/platform/contracts/nativeVoice.ts`, desktop/browser native-voice implementations and `Client/src-tauri/src/native_voice/session.rs` plus its tests. Do not route audio through the existing native video-view operation.

**State mutations.** Per-publication desired audibility, pause timer and delivery state. Existing tile mute/deafen/volume remain the source of intent. Teardown clears timers; disabling the flag releases only pauses owned by this feature and respects stop-watching and encryption eligibility.

**Exactly two critical edge cases.** (1) Screen audio arrives after the viewer has muted/deafened. (2) The viewer unmutes or switches calls while a pause is pending/in flight.

**Tests and gate.** Test mute, deafen, volume zero, rapid zero crossings, late publication, share replacement and E2EE rekey. Use continuous synthetic stereo audio. After grace and a one-second settling allowance, screen-audio payload over a ten-second window should fall by at least 90% versus the paired unpaused control; verify SFU egress as well as receiver counters. Restored audio should have p95 added delay no more than 250 ms versus current behavior and p95 absolute delay below 500 ms on the controlled healthy LAN. Require exactly one audible output path, preserved volume/mute, no microphone gap, no plaintext delivery and no retry churn. Failing SDK/backend combinations stay disabled.

**Flag/rollback.** Proposed `screenAudioDeliveryV1`, off, capability-gated. A live disable resumes this feature's paused publications immediately where still eligible; no rejoin should be needed. Test rollback itself during deafen and after stop-watching.

## 3 — Improve the first picture, only if the baseline needs it

**Implementation.** Cache intended view demand and, for an explicitly watched share, send an appropriately bounded quality/dimension request before subscription when supported. Use available layer metadata and the actual viewer target. Do not prescribe 720p globally or subscribe before a Watch action. Existing manual video-demand control remains the owner after first presentation.

**Candidate files.** Modify `Client/src/features/voice/remoteTracks.ts`, `remoteTracks.test.ts`, `Client/src/lib/voice/roomEventHandlers.ts` and `Client/src/lib/voice/shareFlags.ts`; extend existing `Client/src/components/video-grid/gridWatch.ts` only to communicate the initial target. Add `Client/tests/e2e/fullstack/stream-first-picture.spec.ts` and a Windows native equivalent. Native Linux should advertise support separately; an unsupported early request remains a no-op.

**State mutations.** Desired demand and request generation per publication, cleared on stop/leave/replacement. No additional publication or capture stream.

**Exactly two critical edge cases.** (1) A newly published share has not reported its layers yet. (2) Stop-watching or a channel switch supersedes an early quality request.

**Tests and gate.** Measure first decode, first presentation and time to the baseline steady-state target separately. Include one viewer, mixed small/fullscreen viewers, hidden app, pop-out, both join orders, codec republish and reconnect. Candidate must either reduce median time-to-target-quality by at least 20% and 150 ms, or reduce initially undersized frames by at least 50% when baseline exposes a meaningful startup defect. First-frame p95 must not regress by more than 100 ms; steady downstream bytes must stay within 5%; there must be no new black gaps or subscription before Watch. If baseline shows no material issue, stop after adding regression coverage.

**Flag/rollback.** Proposed `shareEarlyQualityV1`, off and backend-gated. Disable on the next watch/publication attempt and use current subscription ordering; clear any outstanding feature-owned request state. Existing view control remains authoritative.

## 4a — Spread automatic reconnects

**Implementation.** Add bounded jitter at the existing application retry owner, after mapping SDK resume versus application rebuild. Preserve token refresh, five-minute retry budget, membership checks, E2EE setup and supersession. A deliberate user retry remains prompt. Do not add a second retry loop or independently delay both layers without measuring the combined budget.

**Candidate files.** Modify `Client/src/lib/voice/livekitReconnect.ts`, `Client/tests/unit/livekit-reconnect-loop.test.ts`, `Client/tests/unit/livekit-reconnect-superseded.test.ts` and `Client/src/lib/voice/shareFlags.ts`. Add `Client/tests/e2e/fullstack/voice-reconnect-load.spec.ts`; reuse server/SFU process controls from existing fixtures.

**State mutations.** Existing retry schedule and timer; optional test-injected random source. No new session lifecycle owner.

**Exactly two critical edge cases.** (1) Leave/channel change occurs during the randomized wait. (2) Token refresh or an SDK resume finishes after a replacement session takes ownership.

**Tests and gate.** Restart the SFU with 10 then 50 real clients on a rig provisioned to avoid generator saturation. Bucket application and SDK attempts separately in one-second intervals. Across at least 20 independent restarts, target at least 40% lower peak reconnect attempt rate; no new duplicate membership/stale-room teardown; recovery success no worse than baseline and at least 99% on recoverable scenarios. Proposed allowed p95 recovery penalty is at most three seconds, with recoverable short-restart scenarios still under 30 seconds. Cancellation and manual retry must not inherit the randomized delay. Report confidence and exceptions; sample success is not proof of zero failures in production.

**Flag/rollback.** Proposed `voiceReconnectJitterV1`, off. Evaluate at retry scheduling; disabling affects future attempts and restores the current delay schedule without resetting the owner or extending the overall budget.

## 4b — Preserve watch intent across the same share's recovery

**First reproduce.** Extend existing `fullstack/voice-rejoin.spec.ts` and `tests/unit/livekitSession/reconnectMedia.test.ts` with viewer/sharer full reconnect, codec republish and volume/mute persistence. Keep passing existing behavior. Implement additional state only for a demonstrated gap.

**Implementation.** A remembered watch belongs to a server, voice session and particular share lifecycle, not just a user id. Distinguish source change/codec republish/reconnect from explicit stop and a later unrelated share. If existing authenticated metadata cannot establish continuity, a protocol addition is a separate prerequisite; do not guess continuity from a 15-second timer. Old peers without adequate identity fall back to explicit Watch.

**Candidate files.** Modify `Client/src/features/voice/remoteTracks.ts`, `remoteTracks.test.ts`, `voiceSession.ts`, `Client/src/components/video-grid/gridStreams.ts`, `Client/src/lib/voice/roomEventHandlers.ts` and existing reconnect tests. Add `Client/src/features/voice/shareWatchRecovery.ts`, `shareWatchRecovery.test.ts` and `Client/tests/e2e/fullstack/stream-watch-recovery.spec.ts`. Protocol/server paths are deliberately conditional: trace the owning voice announce flow before selecting exact server handlers. If needed, change `protocol/schema.json` and regenerate `Client/src/lib/protocolTypes.ts`, `Server/ws/message_types.go`, `Server/httperr/codes.go`; never hand-edit generated files.

**State mutations.** Bounded in-memory watch intent keyed by authenticated share/session identity, saved local volume/mute and expiry/generation. Existing store writes still go through the dispatcher; a reconnect clear must not erase an explicit later Stop action.

**Exactly two critical edge cases.** (1) Intentional stop and resume/publication messages arrive out of order. (2) The same user starts a new share, or the viewer leaves, while restoration is pending.

**Tests and gate.** Exercise both event orders, viewer and sharer reconnect, rekey, old peers and stop-watching during recovery. Every deterministic sequence must preserve the same share's intended state, restore its volume/mute and require no extra click. No test may auto-watch a stopped or different share, restore across a channel/server switch, or restore before E2EE eligibility. Real media must resume within one second of an otherwise equivalent manual Watch after recovery. Run a 100-cycle replacement/recovery soak with no duplicate outputs or lifecycle growth. If no baseline gap exists, ship only the tests.

**Flag/rollback.** Proposed `shareWatchRecoveryV1`, off. Disabling clears feature-owned pending restoration and timers, while leaving an already explicit current watch alone. Existing behavior handles subsequent publication changes.

## 5 — Motion/text choice

**Implementation.** Compare the existing matrix before adding user controls. Once verified, expose “Smooth motion” and “Sharp text” using proven combinations. Keep advanced experiment arms in diagnostics. Preserve codec fallback and the current default; adopting an optional choice does not require changing the default. Do not inherit pqp's HLS-specific policies.

**Candidate files.** Modify `Client/src/lib/voice/shareFlags.ts`, `shareFlags.test.ts`, `videoPresets.ts` and the owning screen-share setup UI identified during pre-flight. Add `Client/tests/e2e/fullstack/share-content-priority.spec.ts`; extend the Windows hardware benchmark. Reuse existing `shareMotionPolicy` persistence rather than adding a competing policy store.

**State mutations.** Existing saved policy and per-share applied policy. UI must accurately say whether a change affects the current share or the next one; current diagnostics snapshot policy at share start.

**Exactly two critical edge cases.** (1) The SDK/negotiated codec overrides the requested hint. (2) A saved sharp-text choice is restored on a different capture size/backend.

**Tests and gate.** At identical bitrate and source size, measure OCR character error on known text and blinded readability, plus presented FPS and visual frame quality on motion fixtures. Candidate text mode should reduce OCR error by at least 20% relative where baseline error is measurable, and not materially worsen already-legible text. Motion mode must retain at least 95% of baseline presented FPS. Require neutral shared resource/lifecycle gates. If the improvement only exists on a particular codec/backend, scope the option or describe the limitation; do not claim universal sharpness.

**Flag/rollback.** Use the existing experiment policy with an off-by-default product-UI flag if required. Resetting to `legacy` restores current behavior for the next share; do not silently change a live encoder unless an independently tested in-place path exists.

## 6 — Optional diagnostic follow-ups

**Black/stalled capture.** Prototype a bounded local detector under proposed `shareCaptureHealthV1`. Add pure `Client/src/features/voice/shareCaptureHealth.ts`/test and a platform capability for independent capture-state confirmation. Reuse the existing diagnostics lifecycle. Require dark moving film, black slide, paused desktop, real exclusive-fullscreen failure, mute and source-change fixtures. Quiet alone is never failure evidence. Adopt only if the fixed healthy fixture suite has zero warnings, at least 95% of reproduced failure episodes are detected within ten seconds, and resource overhead passes phase 0. Never log captured frames. If the platform cannot confirm the cause, give a neutral capture check or remain silent.

**Audio health.** Add an opt-in diagnostic of expected versus received/played audio before any automatic repair. Ground expectations in mute, deafen, PTT, DTX, permission and E2EE state. Feed the existing recovery owner; do not introduce a competing whole-room rejoin loop. A later automatic-repair proposal must demonstrate recovery of reproduced failures without repairing intentional silence or repeatedly reopening devices.

Both are separate proposals after the earlier gains. They do not block phases 1–5.

## Shared validation matrix

| Dimension          | Required coverage                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real runtimes      | Chromium reference; Windows WebView2 on NVIDIA, AMD and Intel; Linux native/WebKitGTK presentation with NVIDIA and Intel/AMD where available. A supported macOS path needs its own cohort before enabling there. |
| Capture/content    | Window and whole monitor; 720p30, 1080p30/60, supported Source/ultrawide; text, film/game motion, dark moving scene, still desktop. Measure actual capture rate.                                                 |
| Publishers/viewers | No viewers, one, three with mixed tile/fullscreen sizes; camera+mic+share together; opt-in Watch; stopped/hidden/mini/pop-out. Ten/fifty clients are additional reconnect-load scenarios.                        |
| Network            | Healthy LAN; actual 1/3/10 Mbps bottlenecks; delay/jitter/loss profiles; brief link cut and SFU restart. Record directions and observed impairment.                                                              |
| Lifecycle          | First join; late share; watch/unwatch; source/quality/codec change; rekey; disconnect/rejoin; stop during an in-flight action; late callbacks.                                                                   |
| Encryption         | Normal supported E2EE; missing/wrong key faults remain blocked; rekey and incompatible-peer fallback retain existing guarantees. Do not disable E2EE to make a candidate pass.                                   |

Use a small blocking representative matrix in PR CI and the broader controlled hardware/impairment matrix for promotion. Missing hardware stays “unverified” and the affected capability/default stays disabled. For performance samples, shapers and hardware failures must be explicit failures/invalid runs, not success-shaped skips.

Shared promotion guardrails: no known new correctness/E2EE/accessibility failure, no observed increase in media/session failure rate, no material loss in presentation quality or audio continuity, and no resource leak. Proposed steady resource limits versus control: p95 CPU increase at most 2 percentage points and steady memory increase at most 5%; investigate a lower absolute bound for tiny baselines during calibration. Run existing lifecycle probes with their existing thresholds, not weakened substitutes.

## Rollout and proof required before changing defaults

1. **Baseline and red regression:** save current results and reproduce the targeted problem. If it is only a hypothesis, label it as such and keep the candidate experimental.
2. **Small PR, off by default:** one behavior per PR, with a typed local flag/capability and tested rollback. Missing, malformed or unsupported settings resolve to baseline. Flags are proposed names; check existing preference conventions before implementation.
3. **Candidate evidence:** paired comparison against the same SHA/build with the flag off. Attach raw redacted metrics, scenario manifest, analysis and confidence intervals; record excluded/failed runs. Automated counters must be corroborated by actual decoded/presented media or audio as appropriate.
4. **Internal opt-in:** use real supported devices for at least seven days and collect targeted startup/reconnect/mute cycles, not just elapsed time. Keep diagnostics local unless a separate data-collection decision is made. A platform with insufficient evidence remains opt-in.
5. **Default proposal:** a separate review records the exact eligible backend/cohort, acceptance results, residual risks and rollback. Use the repository's supported CI/review path; green CI alone is not independent validation. Roll out through the existing release/internal-beta mechanism, without inventing a new central flag service. If cohort rollout is unavailable, keep the feature opt-in until a release-wide decision is justified.
6. **Rollback verification:** demonstrate the flag-off transition, restoration of feature-owned delivery state and cleanup. Re-run the key old-behavior regression. Remove an experiment only after its replacement default has sufficient evidence.

For UI changes run the shared accessibility checks on the changed journey. For client changes run the required client/static/unit checks plus affected real-media, browser and Windows native jobs. Rust/native changes additionally require Rust tests/clippy and Linux native interoperability. Protocol/server changes require both stacks and the repository's four Go build variants, race/deadlock/tag-specific checks through its documented `ci-check` workflow. Do not treat unavailable tool skips as validation. Full installer builds stay in supported CI.

Each implementation pre-flight must follow OwnCord's `CLAUDE.md`: concrete affected files, state mutations and exactly two critical edge cases, refreshed against the then-current branch. This document supplies the sequence and acceptance contract; conditional native/protocol work requires its own concrete pre-flight after feasibility is established.

## First implementation batch

Start with phase 0 and phase 1 in separate PRs. The immediate deliverable is a reproducible baseline plus an accurate, optional explanation of stream limits. Follow with phase 2 once an end-to-end experiment proves audio delivery suppression on the actual SDK/SFU pair. These provide the clearest early value while producing the evidence needed to decide whether startup, reconnect and content-policy changes are worth adopting.
