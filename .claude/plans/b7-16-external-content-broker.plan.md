# Plan: B7-16 — Desktop external-content broker

> **Milestone:** B7-16 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-16-external-content-broker`.
> **Worktree:** `.claude/worktrees/b7-16`.
> **Drafted:** 2026-09-20. **Base commit:** `3634cb0d` (`dev`).

## Summary

Today the desktop renderer fetches external content from at least nine paths,
each with its own partial destination policy — or none. Every one is a direct
Tauri plugin `fetch`, a plain `<img src>` the webview loads itself, or a
`<iframe>` it frames. `docs/trust-model.md`'s C-09 contract (clauses 1–8) says
one native broker must own all of it: parse, resolve **and classify every
resolved address**, connect only to the validated addresses, no automatic
redirects, time/byte/type/concurrency ceilings, and return a typed minimum
instead of a URL the renderer will fetch a second time. The server half of
clauses 2–6 already exists (`Server/safefetch`, B5-1); clauses 1, 7 and 8 — the
desktop broker — are this milestone, plus the aggregate byte budget and
byte-weighted cache eviction B5 deliberately deferred (B5 decision 2).

The gap is structural, not a missing check: a webview `fetch` cannot resolve a
name, classify the answers, and then bind the connection to them, and cannot
refuse a redirect before it is followed. **The broker must be Rust**
(`Client/src-tauri/`), reached through the B7-3 platform seam, exactly as
`http_proxy.rs`/`ws_proxy.rs` already own their trust decisions. The renderer
gets a typed result, not a general-purpose HTTP client (clause 1's own words).

**What this milestone is not.** It is not the render gate or the consent UI —
that is B9, per HP-5's scorecard (`docs/plans/b5-community-content-moderation-2026-09-04.md:289-300`
decision 3 accepted client-fetching knowingly; the gate is B9's). It does not
move previews server-side; decision 3 forbids that. It does not touch the
server-side `safefetch` or its callers.

## The external-content inventory at `3634cb0d`

Every place the client fetches content that is not the configured OwnCord
server. "External" means the URL was named by a message author or a fetched
page, not by the operator. Each row was re-derived by reading the file at this
commit; the "bound it has" column names the line.

| #   | Path                                    | File:line                               | Fetched by                                | Bounds today                                                                                                                                                                   | Bounds it lacks                                                                                                                                         |
| --- | --------------------------------------- | --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Link preview / OG fetch                 | `embeds.ts:150-230` (`fetch` at `:184`) | `desktop.http!.fetch` (plugin)            | 5 s `AbortController` `:172`; declared `text/html` `:196`; 50 000-char parse slice `:206`; hostname-string SSRF check `isBlockedForPreview`→`isPrivateHost` `:132-142,:94-130` | Resolved-address classification (string-only today); redirect control; streaming byte ceiling (`res.text()` `:204` buffers whole body); concurrency cap |
| 2   | OG preview image                        | `embeds.ts:305-343` (`<img>` at `:327`) | Webview native image load                 | `isSafeUrl` + `isBlockedForPreview` before element creation `:316`                                                                                                             | Address resolution; redirects; byte/time/type; cache partition                                                                                          |
| 3   | YouTube oEmbed title                    | `media.ts:167-204` (`fetch` at `:175`)  | `desktop.http!.fetch` (plugin)            | `AbortSignal.timeout(5000)` `:176`; fixed host `www.youtube.com` `:173`                                                                                                        | Content-type check; byte cap; redirect control; concurrency cap                                                                                         |
| 4   | YouTube thumbnail                       | `media.ts:209-217` (`<img>` at `:212`)  | Webview native image load                 | Fixed host `img.youtube.com` `:211`; ID validated by `YOUTUBE_ID_RE` `:139,:144`                                                                                               | Address resolution; redirects; byte/time/type                                                                                                           |
| 5   | YouTube iframe (on click)               | `media.ts:224-241` (`iframe` at `:229`) | Webview native frame load                 | Fixed host `www.youtube.com/embed` `:230`; ID validated `:144`; sandbox `:233-236`                                                                                             | Address resolution; redirects; concurrency                                                                                                              |
| 6   | Inline external image in a message      | `media.ts:258-343` (`<img>` at `:280`)  | Webview native image load                 | Call-site `isSafeUrl` only `:544-547`                                                                                                                                          | **Every destination bound** — no hostname check, no resolution, no redirects, no byte/time/type                                                         |
| 7   | GIF picker thumbnails                   | `GifPicker.ts:133-138`                  | Webview native image load                 | URL pre-filter `isAllowedGifUrl` (https + `klipy.com`) `gifProvider.ts:33-43`                                                                                                  | Address resolution; redirects; byte/time/type                                                                                                           |
| 8   | Sent-GIF / direct-image render          | `media.ts:258-343` via `:545-547`       | Webview native image load                 | Same as row 6                                                                                                                                                                  | Same as row 6                                                                                                                                           |
| 9   | External image via server-file fallback | `attachments.ts:201-211` (`:202`)       | `desktop.http!.fetch` (plugin)            | `isSafeUrl` at the avatar call site `avatar.ts:74-79`                                                                                                                          | **Every destination bound**; byte/time/type (`res.arrayBuffer()` `:334,:417`); shared caches with server attachments                                    |
| 10  | Server-hosted media/avatars/emoji       | `attachments.ts:201-211,:299-451`       | Plugin via Rust TOFU proxy + bearer token | Cert pin (TOFU) + bearer token; server host only                                                                                                                               | Not external, but C-09 clause 1 names it broker-owned — see Open question 3                                                                             |

`parseOgTags` (`embeds.ts:51-73`) already parses with DOMParser, not a
backtracking regex (F7 fix) — that part stays. The `facebookexternalhit`
User-Agent (`embeds.ts:177`) is spoofing today; a broker owns the header, so
whether to keep it is Open question 2. The bundled Klipy watermark
(`media.ts:8,333-339`) is a build asset, not a fetch, and stays.

### The caches, and why "partitioned" is a real gap

Five process-global caches hold fetched external content, none keyed by the
profile or server that produced it (`clearEmbedCaches` is **not** called on
page teardown — `MainPage.ts:954` clears attachment caches only):

| Cache                                           | File:line                 | Eviction                      | Partitioned? | Cleared on teardown?                |
| ----------------------------------------------- | ------------------------- | ----------------------------- | ------------ | ----------------------------------- |
| `ogCache`                                       | `embeds.ts:27`            | none (unbounded until manual) | no           | no                                  |
| `ytTitleCache`                                  | `media.ts:129`            | FIFO 200                      | no           | no (`clearMediaCaches` only manual) |
| `imageHeightCache`                              | `media.ts:55`             | FIFO 500                      | no           | no                                  |
| `memoryCache` + IndexedDB `owncord-image-cache` | `attachments.ts:137,:217` | FIFO 200 (IndexedDB: never)   | no           | memory only (`MainPage.ts:954`)     |
| `mediaObjectUrls`                               | `attachments.ts:373`      | FIFO 20                       | no           | memory only (`MainPage.ts:954`)     |

The manual "clear cache" action (`AdvancedTab.ts:333-335`) is the only path
that clears all three external caches, and the durable IndexedDB store is
described in `docs/architecture/community-services.md:292,311` as outliving
every account/server switch. B7-13 (one connection, isolated profiles) owns
profile _isolation_; B7-16 owns the **broker's** cache partition, so the two
milestones touch adjacent ground — see Open question 4.

### What already exists to build on

- The seam: `platform/contracts/http.ts` (`HttpClient`) and
  `platform/desktop/http.ts`, landed by B7-4. The broker is a **new** contract,
  not a change to `HttpClient` — clause 1 says the renderer keeps no
  general-purpose client.
- The server's classifier shape and its whole test corpus:
  `Server/safefetch/classify.go:28-136` (every non-global prefix, each with a
  reason), `classify_test.go`, `destination.go`, `fetch.go`. Go and Rust share
  no code, so the list is **portable but not importable** — Open question 1.
- The server half of the contract, done: `Server/safefetch`, adopted by the GIF
  proxy and `plugin/host_http.go` (`docs/trust-model.md:263-280`).

## Verify before you implement

Every row was checked at `3634cb0d`. If a row is false at your HEAD, **stop
that task and record it**; do not improvise around it.

| #   | Claim                                                                                                         | How to re-check                                                                                                                                            | Verified |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | The HTTP seam exists (`HttpClient` + desktop binding), landed in B7-4                                         | `ls Client/src/platform/contracts/http.ts Client/src/platform/desktop/http.ts`                                                                             | yes      |
| 2   | Nine external renderer fetch paths exist (rows 1–9 above)                                                     | `grep -rn "desktop\.http!\.fetch" Client/src` → 3 (external: `embeds.ts:184`, `attachments.ts:202`); plus the `<img>`/`<iframe>` rows by reading the files | yes      |
| 3   | `ogCache` and `ytTitleCache` are **not** cleared on teardown, only by the manual AdvancedTab action           | read `Client/src/pages/MainPage.ts:954` (attachment caches only) and `AdvancedTab.ts:333-335`                                                              | yes      |
| 4   | The C-09 contract is written with eight MUST clauses and assigns 1, 7, 8 to B7                                | `grep -n "broker MUST\|Own every automatic remote fetch" docs/trust-model.md` → `:214-255`                                                                 | yes      |
| 5   | The server half exists and is not reusable from Rust                                                          | `ls Server/safefetch/` and `Client/src-tauri/Cargo.toml` (no Go linkage)                                                                                   | yes      |
| 6   | No Rust fetch command or broker exists in the client today                                                    | `grep -rn "external\|broker\|link_preview" Client/src-tauri/src/*.rs` → none                                                                               | yes      |
| 7   | The capability grants `https://*` on `http:allow-fetch` (the wildcard clause 8 would narrow)                  | `grep -n "https://\*" Client/src-tauri/capabilities/default.json` → `:20,:23`                                                                              | yes      |
| 8   | Platform-contract counts are re-derived by a test that fails on drift (19 importers / 28 names / 33 handlers) | `Client/tests/unit/platform-contracts-counts.test.ts:57-59`                                                                                                | yes      |
| 9   | The client suite is green before any change (230 files, 5672 passed + 96 expected fail)                       | `npm --prefix Client test`                                                                                                                                 | yes      |
| 10  | This milestone needs only B7-4, not B7-5 (PRD ordering)                                                       | `docs/plans/b7-shared-client-platform-desktop-parity.prd.md:343-344`                                                                                       | yes      |

**Row 7 is the one clause 8 changes.** The wildcard cannot shrink until rows
1–9 are served by the broker, so Task 10 narrows it in the same PR that makes
the last call site broker-only — not before.

## Patterns to Mirror

- **The server's classifier is the spec.** Port the _behaviour_ of
  `Server/safefetch/classify.go`, not a shortened version of it: the Go list is
  the one `docs/trust-model.md:225-230` names, and a Rust list that omits a
  range is a regression the contract explicitly forbids. Mirror
  `TestClassifyAddr_RejectsEveryNonGlobalClass` so a deleted range fails loudly.
- **Proxy ownership.** `http_proxy.rs`/`ws_proxy.rs` already own their TLS
  trust decisions in Rust and expose them through `#[tauri::command]`
  (`lib.rs:108-142`); the broker is a sibling of those, not a new pattern.
- **Contract suites assert what the caller receives.** `tests/unit/platform/http.suite.ts`
  is the model: no command name, no argument shape. The broker suite pins the
  typed minimum and the error classes, and gets a null-subject entry in
  `suites-are-falsifiable.test.ts` (B7-3's rule; a suite that passes against a
  do-nothing subject asserts nothing).
- **Prove a gate can fail.** B7-3's null-subject probe found nine vacuous
  tests three review rounds missed. Any ceiling test must be observed red at a
  boundary value before it is trusted green.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                         | Change                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `Client/src/platform/contracts/externalContent.ts`           | new: the broker contract (typed minimum, fetch-by-URL)          |
| `Client/src/platform/contracts/index.ts`                     | re-export + one `Platform` member                               |
| `Client/src/platform/desktop/externalContent.ts`             | new: binds the contract to the Rust command                     |
| `Client/src/platform/desktop/index.ts`                       | register `externalContent`                                      |
| `Client/src-tauri/src/external_content.rs`                   | new: the native broker (parse, resolve, classify, fetch, cache) |
| `Client/src-tauri/src/lib.rs`                                | `mod` + one `#[tauri::command]` in `generate_handler!`          |
| `Client/src-tauri/Cargo.toml`                                | only if a resolver/prefix dependency is added (Open question 1) |
| `Client/src/components/message-list/embeds.ts`               | rows 1–2 behind the broker                                      |
| `Client/src/components/message-list/media.ts`                | rows 3–6, 8 behind the broker                                   |
| `Client/src/components/message-list/attachments.ts`          | row 9 behind the broker; external branch loses its direct fetch |
| `Client/src/components/GifPicker.ts`                         | row 7 behind the broker                                         |
| `Client/src/lib/avatar.ts`                                   | external URL goes through the broker                            |
| `Client/src-tauri/capabilities/default.json`                 | narrow `https://*` once every row is broker-served              |
| `Client/tests/unit/platform/externalContent.suite.ts`        | new                                                             |
| `Client/tests/unit/platform/externalContent.desktop.test.ts` | new: the re-bound run                                           |
| `Client/tests/unit/platform/suites-are-falsifiable.test.ts`  | one null subject                                                |
| `Client/tests/unit/*` (embeds/media/attachments/gif/avatar)  | re-point the mocked transport at the broker                     |
| `Client/tests/unit/capabilities-scope.test.ts`               | the narrowed allow set                                          |
| `docs/architecture/platform-contracts.md`                    | counts + the new contract row                                   |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, `docs/plans/*`
(except the B7-16 PRD cell), `CHANGELOG.md`, or any status row. Do **not** edit
`Server/safefetch/` — the server half is done and out of this milestone.

## Tasks

Commit after every task — conventional subject, scope `b7-16`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Branch and baseline

- **Action:** confirm the worktree is on `feat/b7-16-external-content-broker`
  at `3634cb0d` or later. Run the Verify rows that are one-liners (1, 3, 4, 6,
  7, 8) and record their output. Record `npm --prefix Client test` totals.
- **Validate:** the client suite is green (row 9: 230 files, 5672 passed + 96
  expected fail). Record the count — it must never drop.

### Task 1: The broker contract

- **Action:** add `contracts/externalContent.ts` — one async method returning
  the typed minimum clause 7 names (`title`, `description`, optional
  `imageWidth`/`imageHeight`, and the preview image as **bytes or an opaque
  local handle**, never a URL), plus a small discriminated error union for the
  refusal classes (blocked destination, too many redirects, oversized, wrong
  type, unavailable). Re-export it and add `Platform.externalContent`.
- **Why a new contract, not `HttpClient`:** clause 1 says the renderer gets no
  general-purpose HTTP client. The shape must make a raw URL result
  unrepresentable.
- **Validate:** `npm --prefix Client run typecheck` clean. Commit.

### Task 2: The native broker and its classifier

- **Action:** add `src-tauri/src/external_content.rs`: URL parse (scheme/port
  allowlist, reject embedded credentials and malformed authorities), resolve
  every A/AAAA answer, classify each with the **full** `safefetch` list, dial
  only the validated addresses (hostname kept for SNI), automatic redirects
  off with a small hand-followed budget re-running the whole check per hop,
  and a streaming byte ceiling plus total deadline plus type allowlist plus
  concurrency cap.
- **Gotcha:** this is the security core. Port every prefix in
  `Server/safefetch/classify.go:28-136`, including the documentation,
  benchmarking, NAT64-unwrap and `::/96` cases — a range the Go list has and
  the Rust list misses is exactly the C-09 clause 3 regression the contract
  names. Add a Rust test that names every range, mirroring
  `TestClassifyAddr_RejectsEveryNonGlobalClass`.
- **Validate:** `cargo test` in `Client/src-tauri/` green, including the
  classification test observed red after temporarily deleting one prefix.
  Commit.

### Task 3: The command and the typed minimum

- **Action:** expose one `#[tauri::command]` (e.g. `fetch_external`) that
  returns the typed minimum plus the image bytes (base64 or a temp handle —
  Open question 5), and register it in `lib.rs`. No raw status, headers or body
  crosses the boundary (clause 7).
- **Gotcha:** the command must be callable only for the broker's purposes — do
  not implement a generic `fetch(url, init)`; that recreates the wildcard in
  Rust.
- **Validate:** `cargo test` green; the command appears once in
  `generate_handler!`. Commit.

### Task 4: The desktop binding and its suite

- **Action:** add `desktop/externalContent.ts` binding the contract to the
  command, register it on `desktop`, and write
  `tests/unit/platform/externalContent.suite.ts` + `.desktop.test.ts`, plus a
  null-subject entry in `suites-are-falsifiable.test.ts`.
- **Validate:** the suite is green against the desktop binding and **red**
  against the null subject in `suites-are-falsifiable`. Commit.

### Task 5: Link preview through the broker

- **Action:** move rows 1–2 (`embeds.ts`) off the plugin fetch and the
  webview `<img>`: the OG fetch goes through the broker, and the preview image
  arrives as broker-fetched bytes/opaque handle, not an `og:image` URL the
  renderer loads. Remove the now-dead `isBlockedForPreview`/`isPrivateHost`
  TS string check (the broker's resolved-address classification replaces it).
- **Gotcha:** `parseOgTags` stays as-is; the broker returns HTML or parsed
  fields — do not re-implement the DOMParser path in Rust (Open question 6).
- **Validate:** `tests/unit/embeds.test.ts` green with its transport mocked at
  the broker seam; the private-host cases still refuse, now for the broker's
  reason. Commit.

### Task 6: YouTube, inline images and GIF renders through the broker

- **Action:** move rows 3–8. oEmbed (`media.ts`) goes through the broker;
  thumbnails, inline external images and sent-GIF renders arrive as
  broker-fetched bytes rather than a raw `<img src>`. The iframe (row 5) is
  the hard case — a frame load cannot be brokered into bytes; keep the fixed
  host + sandbox and record the residual in the plan's Risks.
- **Validate:** `tests/unit/media.test.ts`, `tests/unit/gif-picker.test.ts`
  green. Commit.

### Task 7: The server-file fallback and avatar path

- **Action:** move row 9: `fetchServerFile`'s `!isServerUrl` branch
  (`attachments.ts:202`) and the external-avatar path (`avatar.ts`) go through
  the broker instead of a direct plugin fetch.
- **Validate:** `tests/unit/attachments-*.test.ts`, `tests/unit/avatar.test.ts`
  green. Commit.

### Task 8: Cache partitioning and the aggregate budget

- **Action:** key the broker's cache by (profile/server, URL) and clear it on
  teardown the way `clearAttachmentCaches` already is, so a server switch
  cannot serve the previous server's previews. Add the process-wide aggregate
  byte budget and byte-weighted eviction B5 decision 2 deferred, with a test
  that fails an over-budget read at a boundary value.
- **Gotcha:** do not silently re-home `ogCache`/`ytTitleCache`/`imageHeightCache`
  wholesale if that widens the diff — the milestone's cache obligation is the
  broker's cache; moving the pre-existing TS caches is a judgement call for the
  owner (Open question 4).
- **Validate:** the partition test is observed red with the key reverted to a
  bare URL. Commit.

### Task 9: Narrow the capability

- **Action:** with every row broker-served, shrink `http:allow-fetch`
  (`capabilities/default.json:16-43`). Confirm the loopback-only server paths
  still need `http://127.0.0.1:*` and that no external path needs `https://*`.
  Update `capabilities-scope.test.ts` to pin the narrowed set.
- **Gotcha:** capabilities are parsed by `tauri-build` at compile time and no
  local build is allowed (`Client/CLAUDE.md`), so a malformed pattern is caught
  only in CI's `tauri-build` job (B7-6's gate / PRD decision 12).
- **Validate:** `npx actionlint` not needed; the counts test and
  `capabilities-scope.test.ts` green. Commit.

### Task 10: Counts, docs and the final gate

- **Action:** update `docs/architecture/platform-contracts.md` — the counts
  table (a new `#[tauri::command]` moves the handler count) and the new
  contract row. If `src/platform/**`'s knip ignore is now stale, record it
  under Open questions rather than editing `Client/knip.json` (out of file
  table).
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  ( cd Client/src-tauri && cargo test )
  npm run check:docs && npm run check:hygiene
  ```

  Commit.

## Validation

```
npm --prefix Client test                          # count not lower than Task 0's
npm --prefix Client test -- tests/unit/platform   # the broker suite, both runs
npm --prefix Client run typecheck
npm --prefix Client run typecheck:build
npm --prefix Client run lint                      # 0 warnings, cycles <= ceiling
( cd Client/src-tauri && cargo test )             # the classifier's named-range test
npm run check:docs && npm run check:hygiene
# → then the ci-check skill; this PR touches Client/src-tauri/** and the
#   capability JSON, so expect the tauri-build job (PRD decision 12)
```

## Risks

| Risk                                                                                            | Mitigation                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The Rust classifier drifts from the Go one, reopening a blocked range                           | Port every prefix from `classify.go`; name each in a Rust test that fails on deletion; Open question 1 offers a shared vector corpus |
| Moving an image path to bytes regresses rendering (GIF freeze, lightbox, virtual-scroll height) | Keep `observeMedia`/lightbox call sites; assert them in the existing media/embeds suites before and after                            |
| The iframe (row 5) cannot be brokered into bytes and stays a frame load                         | Keep the fixed host + sandbox, and record the residual explicitly rather than claiming clause 1 fully met for frames                 |
| Narrowing `https://*` (Task 9) breaks a path that still needs it                                | Only narrow after every row is broker-served in the same PR; prove the wildcard removal red-first in `capabilities-scope.test.ts`    |
| Cache re-keying collides with B7-13's profile-isolation work                                    | Open question 4 sets the boundary; do not move the pre-existing TS caches without the owner's call                                   |
| `tauri-build` cannot run locally, so a bad capability pattern is CI-only                        | Task 9's gotcha; the `tauri-build` job is the gate                                                                                   |

## Out of scope

- The render gate and consent UI — B9 (`docs/plans/b5-community-content-moderation-2026-09-04.md:289-300`;
  PRD Out of scope).
- Server-side unfurling or any change to `Server/safefetch` — decision 3.
- Moving profiles/connection isolation — B7-13.
- Decomposing `embeds.ts`/`media.ts`/`attachments.ts` beyond what moving the
  calls requires — B7-10.
- Browser adapter (`platform/browser/`) — B8, deferred.
- Any protocol or schema change. None is needed.

## Open questions for the owner

- [ ] **Shared classifier corpus.** The Rust broker must reproduce the Go
      `safefetch` classifier with no shared code, so the two can drift. Options:
      (a) duplicate the prefix list in Rust with a mirrored named-range test;
      (b) add a language-neutral test-vector file both suites read; (c) generate
      the Rust table from the Go source. **Proposed default:** (b) — the server
      already enumerates every range by name in `classify_test.go`, so one shared
      JSON of `{address, allowed, reason}` read by both suites is the cheapest way
      to make drift a red test rather than a review catch.
- [ ] **The spoofed `facebookexternalhit` User-Agent** (`embeds.ts:177`). A
      broker owns the header now. Keep the spoof (some sites only serve OG cards to
      that agent), or send an honest `OwnCord/<version>` UA? **Proposed default:**
      an honest OwnCord UA — decision 3 already accepts the viewer's-address
      exposure; adding impersonation on top is a second thing to disclose.
- [ ] **Does the broker own the server-hosted family (row 10)?** C-09 clause 1
      lists attachments, avatars and custom emoji alongside previews, but those
      URLs already reach the server through the cert-pinned TOFU proxy with a
      bearer token, and B7-16's outcome is scoped to "external content … closing
      the desktop half B5 deferred". **Proposed default:** broker the _external_
      paths (rows 1–9) only in B7-16; the server-hosted family keeps the TOFU proxy
      and is confirmed against clause 1 in B7-5 or at B7-18 reconciliation. Decide
      before Task 7.
- [ ] **Cache ownership.** Does B7-16 re-key the _pre-existing_ TS caches
      (`ogCache`, `ytTitleCache`, `imageHeightCache`, `memoryCache`, IndexedDB) by
      profile/server, or only the broker's new cache? B7-13 owns profile isolation
      and the durable IndexedDB store is a data-lifecycle question
      (`community-services.md:292,311`). **Proposed default:** B7-16 owns the
      broker cache and clears it on teardown; re-keying the durable IndexedDB store
      is B7-13's, recorded as a hand-off.
- [ ] **How image bytes cross the boundary.** Clause 7 allows "bytes or an
      opaque local handle". Base64 through IPC inflates memory; a temp file adds a
      lifecycle to clean up. **Proposed default:** return raw bytes over the Tauri
      IPC channel (`tauri::ipc::Response`) and build a `blob:` URL in the renderer,
      avoiding base64 and a temp-file lifecycle.
- [ ] **Where parsing happens.** Clause 2 says parse _the URL_ in native code;
      clause 7 says return a typed minimum. Does the broker also parse the OG HTML
      in Rust, or return the bounded HTML body for the existing `parseOgTags`?
      **Proposed default:** broker returns the bounded body; `parseOgTags` stays in
      TS (it is already DOMParser-based and F7-fixed). Parsing in Rust is a
      separate, larger change.

## Acceptance

- [ ] Every external renderer fetch (inventory rows 1–9) goes through one
      native broker; no renderer call site holds a general-purpose HTTP client
- [ ] The broker parses URLs, resolves and classifies **every** A/AAAA answer
      against the full `safefetch` range list, dials only validated addresses,
      disables automatic redirects, and bounds time, bytes, content type and
      concurrency
- [ ] The renderer receives a typed minimum; no raw status/headers/body and no
      remote image URL for a second un-brokered fetch
- [ ] The classifier has a Rust test naming every blocked range, observed red
      on a deleted range
- [ ] The broker's cache is partitioned by profile/server and cleared on
      teardown; the aggregate byte budget and byte-weighted eviction have a
      boundary test
- [ ] The `ExternalContent` suite runs green against the desktop binding and is
      a null subject in `suites-are-falsifiable.test.ts`
- [ ] `http:allow-fetch`'s `https://*` is narrowed once every row is
      broker-served, pinned in `capabilities-scope.test.ts`
- [ ] `platform-contracts.md` counts updated; the counts test is green
- [ ] No new `oxlint-disable` / `eslint-disable` / `@ts-ignore` /
      `@ts-expect-error` / `.skip` / `.only`; no loosened assertion; cycle ceiling
      not raised
- [ ] `ci-check` green, including the `tauri-build` job this branch triggers
