# Client performance audit — October 2026

**Date:** 2026-10-09
**Audited tree:** `dev` at `610ec96`
**Scope:** the desktop client (`Client/`) on five hot paths: cold start to the
first channel render, switching channels in a server with a long history,
scrolling a long channel with many embeds and GIFs, joining voice, and memory
growth over a long session. Static reading of the code plus counts taken with
the existing unit harness (jsdom) and the bundle budget script. No desktop was
available, so there are no wall-clock numbers from a real build; every finding
below names the code that causes it and the count or byte figure that shows it.
**Versions read:** `livekit-client` 2.22.3 (`Client/package.json`), LiveKit
server v1.13.7 (`Server/docker-compose.yml`), Node 26.11.1, Vite 8.3.1.
**Fix PRs:** the five findings marked **fix** have a PR each, listed in
section 8; everything else is a note, a follow-up, or a product decision.

## 1. Verdict

The client is in better shape than a first read suggests. The message list is
virtualized (a Fenwick tree over measured row heights, 20 rows of overscan),
store updates patch rows in place (P4-01/P4-02), the startup JavaScript is
budgeted and ratcheted (76,612 B gzip against 77,000 B), the emoji set loads
lazily, the settings tabs build their UI only when opened (their code, like
LiveKit's, is in the main page's static closure; see A2), and the lifecycle
ownership tests plus the CDP soak keep listeners, timers, sockets and tracks
from leaking.

What remains is specific:

1. **Scrolling** is the weakest path. The virtual window keeps exactly the rows
   it needs, so the moment the viewport moves one row past the overscan the
   whole window is thrown away and rebuilt — about 50 rows, every avatar,
   attachment, embed and reaction, with two forced layouts — instead of the one
   row that actually changed. A fast scroll trips the rebuild breaker and shows
   blank space for up to two seconds.
2. **First channel open** pays a hidden cost per uncached image: every write to
   the on-disk image cache opens a fresh IndexedDB connection and reads the
   entire store to decide what to evict.
3. **Channel switches and rebuilds** reload every frozen GIF they are about to
   discard, because releasing a GIF restores its full `src` first.
4. **Voice join** with enhanced noise suppression on fetches and compiles the
   RNNoise WebAssembly inside the microphone publish on every join.
5. **Memory** has three caches with no byte or entry bound outside the JS heap
   the soak watches: broker-fetched image blobs, link-preview metadata and the
   missing-image set.

Nothing found is a leak in the lifecycle sense; the allowlists in
`tests/unit/lifecycle-ownership.test.ts` were read entry by entry and each has a
sound reason. The growth that exists is bounded-per-channel state kept for the
whole session, which is a product choice (section 6).

## 2. Method and measurements

| Measurement                                                  | Result                                                    | Provenance                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup JS closure (gzip)                                    | 76,612 B of 77,000 B                                      | `npm run build:budget && npm run check:budgets` at `610ec96`                                                                                         |
| MainPage chunk / livekit chunk / livekitSession chunk (gzip) | 74,819 B / 133,501 B / 21,682 B                           | same run                                                                                                                                             |
| SettingsOverlay / emojiData chunks (gzip)                    | 42,561 B / 21,354 B                                       | same run                                                                                                                                             |
| Rows re-created when the viewport scrolls by one row         | 52 of 52 rendered rows re-created, 0 DOM nodes kept       | jsdom, `createMessageList` with 300 messages, `clientHeight` 600, `scrollTop` moved by one estimated row (61 px) after the first render-after-scroll |
| IndexedDB work for 20 newly fetched server images            | 41 `indexedDB.open` calls, 20 `getAll`, 21 `getAllKeys`   | jsdom, `fetchImageAsObjectUrl` × 20 against the `attachments-cache.test.ts` stub with counters                                                       |
| Full-`src` reloads when 10 frozen GIFs are discarded         | 10 of 10                                                  | jsdom, `observeMedia` × 10, intersection callback with `isIntersecting: false`, then `unobserveMedia` on each                                        |
| Voice join budget                                            | 1,500 ms median (run medians 462–670 ms at baseline)      | `Client/voice-join-budget.json`, `tests/e2e/fullstack/voice-join-budget.spec.ts`; not re-run here                                                    |
| Soak bars                                                    | nodes ±2, listeners/timeouts ±1, sockets/tracks exactly 0 | `tests/e2e/support/lifecycle-probe.ts`; not re-run here                                                                                              |

The jsdom counts are counts, not timings: jsdom reports every element as
0 px tall, so row heights fall back to the estimator and the rendered window is
wider than on a desktop. The ratio is what matters — one row scrolled, every
row rebuilt — and that ratio does not depend on the measured heights.

## 3. Cold start to first channel render

### A1 — every image written to the on-disk cache reads the whole store (fix)

- **Evidence.** `Client/src/components/message-list/attachments.ts`: `openCacheDb`
  (`:386`) is called for every `idbGet` (`:474`) and every `idbPut` (`:511`),
  and each closes its connection after one transaction. `idbPut` then calls
  `store.getAllKeys()` and `store.getAll()` (`:527-528`) on every write and
  sorts every stored entry by `used` to evict (`:533-552`). The store holds up
  to `IMAGE_DB_MAX_BYTES` = 256 MB of Blobs. Measured: 20 images → 41 opens,
  20 full-store reads.
- **Cause.** Eviction was written as "load everything, sort, delete" with no
  running total and no index on `used`.
- **Fix.** One shared connection (reset on `onversionchange`/`onclose`), an
  in-memory running byte total seeded once by a cursor over `bytes`, and an
  index on `used` so eviction walks the oldest entries with a cursor only when
  the total is over the cap. Schema version 2.
- **Expected gain.** First open of a channel with N uncached avatars and
  attachments goes from N opens + N full-store reads to one open and no reads
  unless the cap is hit. On a cache near its 256 MB cap this is the difference
  between a smooth first paint and a stall per image.

### A2 — the main page statically imports LiveKit (note, follow-up)

`Client/src/pages/MainPage.ts:50` imports `@lib/livekitSession`, which imports
`livekit-client` (`lib/livekitSession.ts:2`), and `:19` imports
`SettingsOverlay`. Ten modules import the facade statically (`VoiceWidget`,
`ChannelSidebar`, `VideoGrid`, `VoiceAudioTab`, `LogsTab`, `tile-menu`,
`volume-menu`, `VoiceCallbacks`, `VideoModeController`, `MainPage`). The
`livekit` chunk (133,501 B gzip) is "lazy" only relative to the entry; it must
download, parse and run before `createMainPage` can. `main.ts:704` prewarms the
MainPage import as soon as the socket reaches "connected", so on a desktop
(assets served from the bundle) the cost is parse and execute, not network.
Making the facade a dynamic import everywhere is a ten-file change with
async call sites in the voice widget and sidebar; worth doing, but not as a
"clear win" PR from this audit.

### A3 — the first history fetch waits for the whole shell (note, follow-up)

The active channel is known at `ready` (`applyReadyActiveChannel`,
`features/channels/wsHandlers.ts:48-93`), but `getMessages` only starts after
`ready` → `setTimeout(0)` → MainPage import → the full synchronous shell mount →
`mountChannel` (`MainPage.ts:1581`, `ChannelController.ts:738`,
`MessageController.ts:68`). A ready-time prefetch of the first page is
feasible (`features/messaging/wsHandlers.ts` already fetches on a full-ready
resync) but needs an in-flight guard shared with `loadMessages`. The gain is
one request round trip overlapped with the mount — small on a LAN, worth
measuring on a WAN before building.

### A4 — other startup notes (no action)

- The `ready` frame is parsed twice: once as the Tauri event payload, once by
  `JSON.parse` in `lib/ws.ts:563`.
- `MemberList.renderList` (`components/MemberList.ts:450-495`) builds a DOM row
  for every member with no virtualization; presence changes patch in place,
  anything else rebuilds. Fine at hundreds of members, a cost at the 1,000–2,000
  the server now targets.
- `InterVariable.woff2` (352 KB) loads with `font-display: swap` and no preload.
- `localStorage` preference reads are cached at module load; no reads in loops
  were found.

## 4. Switching channels in a server with a long history

### B1 — a revisit refetches and may page back five times (product decision)

Leaving a channel clears its `loaded` flag (`ChannelController.ts:351`,
`features/messaging/historyWindows.ts:260-268`) but keeps its rows. A revisit
then fetches 100 rows and, if that page stops short of the oldest cached row,
pages back with `before` up to `MAX_REVISIT_PAGES` = 5 times, each request
waiting for the previous one (`MessageController.ts:56-99`). A reader who had
scrolled 300 rows up pays up to five serial requests on return. This is a
correctness design (P4-01 R3 revalidates every cached row), so how much history
a revisit restores is a product question — see section 6.

### B2 — the parse cache is cleared on every leave (note)

`MessageList.destroy` calls `clearContentParseCache()` (`MessageList.ts:1624`).
The cache is a 200-entry LRU keyed by id, `editedAt` and content
(`content-parser.ts:681-708`), so it can never serve a stale parse; clearing
it only makes the revisit re-parse. The saving is a few milliseconds per
revisit; noted, not fixed.

### B3 — icons are parsed from HTML per row (note)

`createIcon` sets `svg.innerHTML` for every icon instance
(`lib/icons.ts:257-280`); a row's action bar has 5–7 icons, so each row render
parses 5–7 HTML strings. A cached `<template>` per icon with `cloneNode(true)`
would remove it. Cheap per row, but multiplied by every rebuild in C1.

### B4 — leaving a channel reloads every frozen GIF (fix, with C2)

`MessageList.destroy` → `releaseTrackedMedia` (`MessageList.ts:668-673`) →
`unobserveMedia`, which restores the full `src` on every frozen GIF
(`lib/media-visibility.ts:263-266`) one line before the element is removed.
Each restore starts a GIF load the user never sees. Measured: 10 frozen GIFs,
10 reloads. The same path runs on every virtual-window rebuild (C1) and every
`releaseRow`. Both callers of `unobserveMedia` discard the element.

## 5. Scrolling a long channel with embeds and GIFs

### C1 — the virtual window rebuilds every row when the viewport moves one row (fix)

- **Evidence.** `Client/src/components/MessageList.ts`: `renderWindow` computes
  `start = firstVisible - OVERSCAN` and `end = lastVisible + OVERSCAN + 1`
  (`:774-775`) and records exactly that range (`:814-815`). The "already
  rendered" test (`:784`) is `start >= renderedStart && end <= renderedEnd`, so
  it fails as soon as either visible edge moves by one row. The rebuild then
  measures every row with `getComputedStyle` + `offsetHeight` (`:812`), releases
  every row's listeners and media (`:821-822`), `clearChildren`s the container
  and renders every row from scratch (`:823-828`), and measures again (`:831`).
  Only `patchRows` (`:889`) reuses rows, and only for store updates.
  Measured: one row scrolled, 0 of 52 nodes kept.
- **Cause.** The window has no slack and no node reuse on shift.
- **Consequence.** A rebuild is rate-limited to 30 in 2 s (`:788-805`); a
  fling or scrollbar drag crosses more than 15 rows per second easily, trips
  the breaker and leaves only spacers on screen until the 2 s reset. Every
  rebuild also re-runs every image `load` handler, every GIF freeze (a
  synchronous canvas `toDataURL`) and every link-preview card's pending state.
- **Fix.** When the needed range overlaps the rendered one, keep the DOM nodes
  of the rows still in range, render only the rows entering it, release only
  the rows leaving it, and update `renderedStart`/`renderedEnd` and the spacers.
  A disjoint jump still rebuilds and still counts toward the breaker. This is
  the same keyed reuse `patchRows` already does for store updates.
- **Expected gain.** About one row rendered per scroll step instead of ~50; no
  breaker trips on a fling; GIF freeze/unfreeze and image reloads drop to the
  rows that actually enter or leave.

### C2 — releasing media is more expensive than it needs to be (fix, with B4)

- `unobserveMedia` walks all of `allTracked` to delete one entry
  (`media-visibility.ts:270-275`): O(tracked) per release, O(tracked²) per
  rebuild.
- The inline-image `load` listener is not `once` (`media.ts:385-396`), so every
  `src` change from a freeze or unfreeze re-runs it: a style write followed by
  an `offsetHeight` read, one forced layout per GIF per toggle.
  `attachments.ts:1012-1019` has the same shape.
- **Fix.** A discard path that stops observing without restoring `src`, a
  per-entry reference so release is O(1), and `once: true` on the load
  listeners. The existing `unobserveMedia` contract (restore the `src`) is kept
  for any caller that keeps the image.

### C3 — layout shift on re-render (product decision)

A link-preview card starts at height 0 (`msg-embed-link-pending`,
`embeds.ts:187-192`, `messages.css:507-513`) and stays there until its image
loads or a 3 s timer fires (`embeds.ts:218-232`), even on an `ogCache` hit.
YouTube thumbnails (`messages.css:462-466`) and `<video>` (`attachments.ts:944`)
reserve no size. Native scroll anchoring is off (`chat-area.css:125-130`) and
the ResizeObserver correction runs one frame later (`MessageList.ts:1313`), so
each shift paints once before it is corrected. C1 removes most of the
re-renders that expose this; the remaining first-render shifts need a design
call on reserved heights (section 6).

### C4 — GIFs are full GIFs, and blur freezes them all synchronously (product decision)

The picker inserts Tenor's `media_formats.gif` (`lib/gifProvider.ts:48-56`),
rendered as `<img>` (`media.ts:330`, `attachments.ts:1023`), not the mp4/webm
Tenor also serves. `pauseAllMedia` on every window blur
(`media-visibility.ts:180-183`, `:279-291`) encodes a PNG per playing GIF on the
main thread. Switching to video is a product and platform question (Linux video
goes through the native path, and the Linux GIF work in PR #2230 is in flight).

### C5 — off-screen fetches are never cancelled (follow-up)

`renderMessage` does not pass the row's abort signal into attachment, embed,
custom-emoji or avatar fetches (`renderers.ts:398-406`; `media.ts:434`,
`attachments.ts:1054`, `embeds.ts:255`, `custom-emoji.ts:103`, `avatar.ts:87`).
The broker runs six fetches at once (`src-tauri/src/external_content.rs:56`),
so after a fast scroll the rows already passed hold the slots ahead of what is
on screen, and their callbacks keep the detached rows alive until each fetch
settles. With C1 the churn drops; threading the signal through is a follow-up.

### C6 — what is already right (verified clean)

One passive `scroll` listener batched to one window update per frame
(`MessageList.ts:1298-1301`, `:1224-1229`); one `ResizeObserver` on the content
container, not one per row; reads batched before writes in `measureRendered`;
no `getBoundingClientRect` in loops; avatar and custom-emoji bytes shared
through one 64 MB LRU plus IndexedDB with in-flight de-duplication; YouTube
titles and image heights in bounded LRUs; message parsing in a bounded LRU.

## 6. Joining voice

### D1 — RNNoise is fetched and compiled inside every join (fix)

- **Evidence.** `Client/src/lib/noise-suppression.ts:19-39`: `createRNNoiseNode`
  calls `addModule("/rnnoise-worklet.js")`, then `fetch("/rnnoise.wasm")`,
  `arrayBuffer()`, and transfers the bytes to the worklet, which compiles them.
  Nothing is cached; the buffer is detached by the transfer. It runs from
  `AudioPipeline.attach` → `applyEnhancedPreference` (`lib/audioPipeline.ts:353`)
  inside `createTracks`, so with enhanced noise suppression on it sits on the
  critical path of the first microphone publish on every join and every
  connect retry.
- **Fix.** Fetch the bytes once per process and hand each new worklet its own
  transferred copy; the worklet compiles as before. A compiled
  `WebAssembly.Module` cannot be handed over instead: in Chromium a module
  posted to an AudioWorklet port is silently never delivered (verified in the
  real-browser suite, which timed out on it). `addModule` stays per
  `AudioContext`.
- **Expected gain.** The wasm fetch leaves the join path after the first join;
  the compile stays in the worklet, where Chromium's in-process compilation
  cache serves repeat compiles of identical bytes. The voice-join budget test
  (`phaseMedians.localTrackMs`) is the place to see it.

### D2 — the pre-connect steps run serially (product / engineering decision)

`connectAndSetup` (`features/voice/joinOrchestration.ts:166-541`) awaits, in
order: `createRoom` (spawns the E2EE worker and `setE2EEEnabled`, `:213`),
`resolveLiveKitUrl` (an IPC proxy start, `:227`), `setupKeyExchange` (`:248`),
then `room.connect` (`:311`), then the device switch and microphone publish.
The first three do not depend on each other. For a participant who is not the
key holder, `setupKeyExchange` waits for a full server → key holder → server
round trip (`lib/livekitE2EE.ts:358-425`, up to 10 s) before `connect` even
starts. Running the three pre-connect steps together is safe but touches the
supersession checkpoints and the join-trace stage order; overlapping `connect`
with the key wait would let frames arrive before the key is installed and
touches the E2EE guards the component rules protect. Recommendation in
section 8.

### D3 — per-join allocations and device enumeration (notes)

A new `AudioContext` per `AudioPipeline.attach` (`lib/micProcessor.ts:87`) and a
new E2EE `Worker` per `createRoom` (`roomLifecycle.ts:147-148`), including per
connect retry. The Settings Voice tab enumerates devices twice per
`devicechange` (immediately and after 1 s, `VoiceAudioTab.ts:626-636`) and on
Linux calls the full native `listDevices` IPC once per kind
(`native/devices.ts:21-26`). None of these is on the join path's critical
section after D1; noted for a later pass.

### D4 — documentation drift (noted)

`tests/e2e/fullstack/voice-join-budget.spec.ts:8` and the B7 baseline
(`docs/plans/b7-0-client-baseline-2026-09-19.md:826-827`) say the first join
pays the lazy LiveKit chunk; it is prewarmed with MainPage (A2), so it does
not. `voice-join-budget.json` says LiveKit 1.13.7; the baseline doc says 1.13.5.

## 7. Memory over a long session

### E1 — three caches with no useful bound (fix)

- `externalObjectUrls` (`attachments.ts:701`) holds `blob:` URLs for
  broker-fetched images, capped at 100 entries with no byte limit (`:820-831`).
  The broker allows 16 MB per image (`src-tauri/src/external_content.rs:82`),
  so the cap bounds nothing in bytes. The server-image cache next to it is
  capped at 64 MB.
- `ogCache` and `ogReasked` (`embeds.ts:47-52`) grow by one entry per distinct
  link until logout or the manual cache clear.
- `missingImages` (`attachments.ts:223`) grows by one entry per 404 until the
  same.
- Blob memory lives outside the JS heap, so the soak's heap bar
  (`lifecycle-probe.ts`) cannot see any of this.
- **Fix.** A byte cap on the external image cache mirroring the server-image
  cache, and bounded LRUs for the two metadata caches, reusing the LRU shape
  already in `media.ts:93-104`.

### E2 — every channel's window is kept for the session (product decision)

`messagesByChannel` keeps up to 500 rows per channel
(`features/messaging/messageModel.ts:166`) for every channel and DM ever
opened; nothing trims by channel count, and the store resets only at logout
(`stores/auth.store.ts:159`). Each store update also copies the whole channel
map (`liveMessages.ts:81`, `historyWindows.ts:135,220,322`), which is O(channels)
per message. A user who visits 60 channels in a day holds 60 × 500 rows. A
revisit already refetches (B1), so evicting the windows of channels not among
the last N visited costs nothing visible; it is a product call because the
unread divider and "jump to present" read the cached window.

### E3 — soak blind spots (noted)

The CDP soak (`tests/e2e/fullstack/long-session.spec.ts`) cycles through text
channels with plain messages, settings, overlays, a DM and voice. It does not
render images, GIFs, embeds, video or audio, does not scroll back through
history, does not count `HTMLMediaElement`s or blob storage, and does not open
enough channels to see E2. The content-consent `admitted` set
(`features/content-consent/external.ts:30`) grows by one entry per auto-admitted
preview image; it carries safety semantics, so bounding it is a product call.

### E4 — verified clean

- All seventeen R1 listener allowlist entries, three R3 timeout entries and
  eight R4 controller entries in `tests/unit/lifecycle-ownership.test.ts` have a
  valid reason; none is a leak.
- Every `ws.on` outside the dispatcher is pushed into an unsubscribe list.
- All thirteen `setInterval` sites keep their handle and clear it.
- `URL.createObjectURL` has a matching revoke at every site.
- Voice: the stall timer can outlive a leave by up to 10 s but is guarded
  (`roomEventHandlers.ts:343`); the reconnect backoff sleeps ignore their
  `AbortSignal` (`lib/livekitReconnect.ts:108-121`) and exit on the next check.
  Neither grows.

## 8. Fix PRs

One PR per finding, each with a test that fails on `dev` before the fix.

| Finding | Pull request                                       | Risk   |
| ------- | -------------------------------------------------- | ------ |
| C1      | [#2238](https://github.com/J3vb/OwnCord/pull/2238) | medium |
| A1      | [#2240](https://github.com/J3vb/OwnCord/pull/2240) | medium |
| B4 + C2 | [#2235](https://github.com/J3vb/OwnCord/pull/2235) | low    |
| E1      | [#2237](https://github.com/J3vb/OwnCord/pull/2237) | low    |
| D1      | [#2236](https://github.com/J3vb/OwnCord/pull/2236) | low    |

## 9. Needs a product decision

| Item | Question                                                                    | Recommendation                                                                                                                                      |
| ---- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2   | Bound the number of channel windows kept in memory?                         | Keep the windows of the last 20 visited channels; drop older ones. A revisit refetches anyway.                                                      |
| D2   | Parallelise the pre-connect voice steps? Overlap connect with the key wait? | Run `createRoom`, `resolveLiveKitUrl` and `setupKeyExchange` together now; keep `connect` after the key so no frame arrives before it is installed. |
| B1   | How much history should a revisit restore?                                  | Cap revisit paging at two pages; a reader further back scrolls up as on a first visit.                                                              |
| C3   | Reserve a fixed height for pending link-preview cards and video?            | Yes: a fixed min-height for a pending card, and the server-reported aspect ratio for video.                                                         |
| C4   | Insert Tenor GIFs as mp4/webm instead of GIF?                               | Yes, after PR #2230 lands and Linux video is confirmed on the native path.                                                                          |
| A4   | Virtualize the member list?                                                 | Yes, once a server above 1,000 members is a supported configuration.                                                                                |
| E3   | Bound the content-consent `admitted` set?                                   | Bound at 2,000 entries; consent is re-evaluated, not revoked, when an entry falls out.                                                              |
| A2   | Make the LiveKit facade a dynamic import everywhere?                        | Yes, as its own change with the voice widget's call sites made async; measure first-channel time before and after.                                  |
| A3   | Prefetch the first history page at `ready`?                                 | Measure on a WAN first; build only if the overlap is visible.                                                                                       |

## 10. Follow-ups outside this audit's PRs

B2 (keep the parse cache across a leave), B3 (icon templates), C5 (abort
off-screen fetches), D3 (per-join allocations, device enumeration), and the
documentation drift in D4.
