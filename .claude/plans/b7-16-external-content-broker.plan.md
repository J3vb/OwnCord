# Plan: B7-16 — Desktop external-content broker

> **Milestone:** B7-16 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-16-external-content-broker`.
> **Worktree:** `.claude/worktrees/b7-16`.
> **Drafted:** 2026-09-20. **Base commit:** `3634cb0d` (`dev`).
> **Re-issued:** 2026-09-20 at `7682c4c5` (`dev`), after a review of all four
> B7 plans answered the six open questions and found one gap. The answers are
> in [Decisions](#decisions-resolved-2026-09-20); they change the task list,
> the file table and the acceptance criteria — two of them because the merged
> plan contradicted itself, not because a preference changed. **Read the
> Decisions section before Task 0** — it is at the end, where the open
> questions were.

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
move previews server-side; decision 3 forbids that. It changes no **production**
code in `Server/safefetch` and none of its callers — only that package's test
file and a new `testdata/` corpus, which is how the Rust port is kept from
drifting (Decision 1).

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
| 10  | Server-hosted media/avatars/emoji       | `attachments.ts:201-211,:299-451`       | Plugin via Rust TOFU proxy + bearer token | Cert pin (TOFU) + bearer token; server host only                                                                                                                               | Not external, and **not** the broker's (Decision 3): the TOFU proxy keeps it, and clause 1 is answered in `docs/trust-model.md` by Task 12              |

`parseOgTags` (`embeds.ts:51-73`) parses with DOMParser, not a backtracking
regex (F7 fix). Its **behaviour** is the spec for the Rust parser that replaces
it (Decision 6); the TS function goes away with row 1's call site. The
`facebookexternalhit` User-Agent (`embeds.ts:177`) is spoofing today and
**stays** a known-crawler spoof (Decision 2, the owner's ruling) — the broker
owns the header, so the one thing that changes is that it must never grow an
OwnCord version. Today's literal carries none; keep it that way. The bundled
Klipy watermark (`media.ts:8,333-339`) is a build asset, not a fetch, and stays.

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
every account/server switch.

**The ownership split is by what a cache holds, not by which milestone created
it** (Decision 4). Partitioning only the broker's new cache would fail this
plan's own acceptance: `ogCache` is unpartitioned, uncleared on teardown, and
keyed by bare URL, so a server switch would still serve the previous server's
previews out of the renderer no matter how well the Rust cache is keyed.

| Cache                     | Holds            | Owner     | What B7-16 does                                                            |
| ------------------------- | ---------------- | --------- | -------------------------------------------------------------------------- |
| `ogCache`                 | external content | **B7-16** | fold into the broker cache, or at minimum clear on teardown                |
| `ytTitleCache`            | external content | **B7-16** | same                                                                       |
| `imageHeightCache`        | external content | **B7-16** | same (a height is derived from external bytes)                             |
| `memoryCache` + IndexedDB | server content   | **B7-13** | stop writing external bytes into it (Task 9); the rest is B7-13's hand-off |
| `mediaObjectUrls`         | server content   | **B7-13** | unchanged here; server content only once Task 9 lands                      |

After Task 9 moves `fetchServerFile`'s external branch, `memoryCache`, the
durable IndexedDB store and `mediaObjectUrls` hold **server** content only —
which is what makes the hand-off to B7-13 (profile isolation) clean rather than
a shared-ownership argument. Record that hand-off in the plan's Risks, not in
B7-13's file table: B7-16 does not edit B7-13's files.

### What already exists to build on

- The seam: `platform/contracts/http.ts` (`HttpClient`) and
  `platform/desktop/http.ts`, landed by B7-4. The broker is a **new** contract,
  not a change to `HttpClient` — clause 1 says the renderer keeps no
  general-purpose client.
- The server's classifier shape and its whole test corpus:
  `Server/safefetch/classify.go:26-136` (every non-global prefix, each with a
  reason), `classify_test.go`, `destination.go`, `fetch.go`. Go and Rust share
  no code, so the list is **portable but not importable**. Decision 1 makes the
  Go test table the shared artifact: `classify_test.go:13-72` is already a
  literal `{addr, why}` slice, so lifting it to JSON both suites read is cheap,
  and `blockedPrefixes` (`classify.go:26`) is an ordinary in-package slice, so a
  Go test can assert every prefix is covered by a vector.
- The server half of the contract, done: `Server/safefetch`, adopted by the GIF
  proxy and `plugin/host_http.go` (`docs/trust-model.md:263-280`).

## Verify before you implement

Rows 1-10 were checked at `3634cb0d` and re-checked at `7682c4c5` when this
plan was re-issued. Rows 11-15 are the re-issue's own, checked at `7682c4c5`.
If a row is false at your HEAD, **stop that task and record it**; do not
improvise around it.

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
| 11  | `ci-select.mjs` never selects `rust` for a `Server/**` or `protocol/**` path                                  | read `scripts/ci-select.mjs:173-217`: `SERVER_READS_OUTSIDE` adds `server, integration`; `Server/` adds `server, integration, native`; neither adds `rust` | yes      |
| 12  | `blockedPrefixes` is an ordinary in-package slice a Go test can iterate                                       | `sed -n '26,80p' Server/safefetch/classify.go`; the test file is `package safefetch`                                                                       | yes      |
| 13  | The CSP still allows any `https:` image, so nothing forces images through the broker                          | `grep -n "img-src" Client/src-tauri/tauri.conf.json` → `:27`, `img-src 'self' blob: https: data:`                                                          | yes      |
| 14  | B7-5's file table is closed and names neither `docs/trust-model.md` nor a clause-1 note                       | read `.claude/plans/b7-5-adapter-media-shell.plan.md:105-135`; `grep -c trust-model` that file → 0                                                         | yes      |
| 15  | `html5ever` is already in the Rust lockfile via Tauri, so Rust-side HTML parsing adds no build dependency     | `grep -n '^name = "html5ever"' Client/src-tauri/Cargo.lock` → `:1836` (with `markup5ever`, `tendril`)                                                      | yes      |

**Rows 7 and 13 are the two controls this milestone narrows.** Row 7 is the
capability (clause 8's own words); row 13 is the CSP, which is the control that
actually governs rows 2, 4, 6, 7 and 8 — they are webview `<img>` loads, not
plugin fetches, so narrowing only the capability would leave a future
`<img src="https://...">` silently working after the broker lands. Neither can
shrink until every row is broker-served, so Task 11 narrows both in the same PR
that makes the last call site broker-only — not before.

## Patterns to Mirror

- **The server's classifier is the spec.** Port the _behaviour_ of
  `Server/safefetch/classify.go`, not a shortened version of it: the Go list is
  the one `docs/trust-model.md:225-230` names, and a Rust list that omits a
  range is a regression the contract explicitly forbids.
  `TestClassifyAddr_RejectsEveryNonGlobalClass` is the shape to mirror, and
  Decision 1 turns its table into the corpus both languages read, so a deleted
  range fails loudly on both sides rather than only the one that was edited.
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
- **A shared corpus is only a gate once CI runs both sides of it, and only if
  someone adds vectors.** The classifier vectors (Task 2) are three changes,
  not one: the corpus, the `ci-select.mjs` entry that makes a change to it
  select `rust` as well as `server`, and the Go test that forces a vector for
  every `blockedPrefixes` entry. Drop the second and a vector added in a server
  PR merges with the Rust suite never run; drop the third and a new Go range
  never gets a vector at all. Either way the corpus looks like a gate and is
  not — the same class of hole B7-3's null subjects found, one layer up.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                         | Change                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `Client/src/platform/contracts/externalContent.ts`           | new: the broker contract - two methods, `preview()` and `image()` (Decision 5)                                       |
| `Client/src/platform/contracts/index.ts`                     | re-export + one `Platform` member                                                                                    |
| `Client/src/platform/desktop/externalContent.ts`             | new: binds both contract methods to the two Rust commands                                                            |
| `Client/src/platform/desktop/index.ts`                       | register `externalContent`                                                                                           |
| `Client/src-tauri/src/external_content.rs`                   | new: the native broker (parse, resolve, classify, fetch, cache)                                                      |
| `Client/src-tauri/src/lib.rs`                                | `mod` + **two** `#[tauri::command]`s in `generate_handler!` (Decision 5)                                             |
| `Client/src-tauri/Cargo.toml`                                | only if a resolver dependency is added; `html5ever` is already in `Cargo.lock` via Tauri (Verify row 15)             |
| `Server/safefetch/testdata/classify_vectors.json`            | new: the shared classifier corpus both suites read (Decision 1)                                                      |
| `Server/safefetch/classify_test.go`                          | read the corpus instead of the inline table; add the prefix-coverage test. **Test file only — no production change** |
| `scripts/ci-select.mjs`                                      | a traced-dependency entry so the corpus selects `rust` as well as `server`                                           |
| `scripts/ci-select.test.mjs`                                 | pin that entry                                                                                                       |
| `Client/src/components/message-list/embeds.ts`               | rows 1-2 behind the broker; `parseOgTags`, `isBlockedForPreview` and `isPrivateHost` are deleted                     |
| `Client/src/components/message-list/media.ts`                | rows 3–6, 8 behind the broker                                                                                        |
| `Client/src/components/message-list/attachments.ts`          | row 9 behind the broker; external branch loses its direct fetch                                                      |
| `Client/src/components/GifPicker.ts`                         | row 7 behind the broker                                                                                              |
| `Client/src/lib/avatar.ts`                                   | external URL goes through the broker                                                                                 |
| `Client/src-tauri/capabilities/default.json`                 | narrow `https://*` once every row is broker-served                                                                   |
| `Client/src-tauri/tauri.conf.json`                           | drop `https:` from the CSP `img-src` once every row is broker-served (`:27`)                                         |
| `Client/tests/unit/tauri-conf-csp.test.ts`                   | new: pin the narrowed `img-src`, sibling of `tauri-conf-webview2-args.test.ts`                                       |
| `Client/src/pages/MainPage.ts`                               | clear the broker and external caches on teardown alongside `clearAttachmentCaches` (`:954`)                          |
| `Client/src/components/settings/AdvancedTab.ts`              | the manual "clear cache" action also clears the broker cache (`:333-335`)                                            |
| `docs/trust-model.md`                                        | the one-paragraph clause-1 note on why the server-hosted family stays on the TOFU proxy (Decision 3)                 |
| `Client/tests/unit/platform/externalContent.suite.ts`        | new                                                                                                                  |
| `Client/tests/unit/platform/externalContent.desktop.test.ts` | new: the re-bound run                                                                                                |
| `Client/tests/unit/platform/suites-are-falsifiable.test.ts`  | one null subject                                                                                                     |
| `Client/tests/unit/*` (embeds/media/attachments/gif/avatar)  | re-point the mocked transport at the broker                                                                          |
| `Client/tests/unit/capabilities-scope.test.ts`               | the narrowed allow set                                                                                               |
| `docs/architecture/platform-contracts.md`                    | counts (two new commands) + the new contract row                                                                     |

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, `docs/plans/*`
(except the B7-16 PRD cell), `CHANGELOG.md`, or any status row.

**`Server/safefetch/` — test files only.** The merged plan forbade the whole
directory, which contradicted its own preferred answer to Open question 1. The
rule is now narrower and load-bearing: **no production change in
`Server/safefetch/`** — `classify.go`, `destination.go` and `fetch.go` are done
and out of this milestone — but `classify_test.go` and a new `testdata/` file
are in scope, because the shared corpus is what makes the Rust port
falsifiable. If Task 2 turns out to need a production edit there, that is a
**BLOCKED**, not a judgement call.

`Client/src/components/settings/AdvancedTab.ts` is **also in B7-5's file
table** (`.claude/plans/b7-5-adapter-media-shell.plan.md:118`, the autostart /
devtools / relaunch halves). A conflict there is expected; resolve it by
keeping **both** edits — the two milestones touch different functions in the
same file.

## Tasks

Commit after every task — conventional subject, scope `b7-16`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Branch and baseline

- **Action:** confirm the worktree is on `feat/b7-16-external-content-broker`
  at `7682c4c5` or later (the re-issue base). Run the Verify rows that are
  one-liners (1, 3, 4, 6, 7, 8, 11, 12, 13, 15) and record their output. Record
  `npm --prefix Client test` totals **at your HEAD** — the merged plan's
  figures (230 files, 5672 passed + 96 expected fail) were taken at `3634cb0d`
  and are a floor to re-measure, not a constant to assert.
- **Validate:** the client suite is green. Record the count — it must never
  drop from what Task 0 measured.

### Task 1: The broker contract — two methods, not one

- **Action:** add `contracts/externalContent.ts` with **two** methods
  (Decision 5), plus a small discriminated error union for the refusal classes
  (blocked destination, too many redirects, oversized, wrong type,
  unavailable):
  - `preview(url)` → the typed minimum clause 7 names: `title`, `description`,
    optional `imageWidth`/`imageHeight`, and an **opaque image handle** —
    never a remote URL.
  - `image(handle | url)` → the raw bytes for that handle. Rows 4, 6, 7 and 8
    need only this one.
- **Why two:** a raw-bytes IPC response cannot also carry the JSON typed
  minimum, so the merged plan's "one command returns metadata plus image bytes"
  does not work as written. Splitting it is what makes Decision 5's raw-bytes
  transport possible at all.
- **Why a new contract, not `HttpClient`:** clause 1 says the renderer gets no
  general-purpose HTTP client. The shape must make a raw URL result
  unrepresentable.
- **Validate:** `npm --prefix Client run typecheck` clean. Commit.

### Task 2: The shared classifier corpus and its CI wiring

This task is three changes that only work together; landing two of them is
worse than landing none, because it looks like a gate and is not.

- **Action (a) — the corpus.** Lift `classify_test.go:13-72`'s literal case
  slice to `Server/safefetch/testdata/classify_vectors.json`, one entry per
  address: `{ "address": "...", "allowed": false, "note": "RFC1918" }`. Have
  `classify_test.go` read it instead of the inline table. Cover the allowed
  cases from `TestClassifyAddr_AllowsGloballyRoutable` too, and both NAT64
  sides (`64:ff9b::8.8.8.8` allowed, `64:ff9b::10.0.0.1` refused) — the unwrap
  is the subtlest rule in the list and the easiest to port wrong.
- **Gotcha:** assert `allowed` only. `note` is documentation for a human
  reading a failure, **not** an assertion: Go's refusal reasons
  (`classify.go`'s `why` strings) and the test's descriptions already differ,
  and pinning Rust to Go's wording would make a reworded reason a false
  failure. Which ranges are refused is the contract; how the refusal reads is
  not.
- **Action (b) — the coverage test.** `blockedPrefixes` is an ordinary
  in-package slice (`classify.go:26`, Verify row 12), so add a short Go test
  asserting **every prefix contains at least one `allowed: false` vector**. A
  new Go range then fails the Go suite until someone adds a vector, and that
  vector turns the Rust suite red. Vectors that nobody adds catch no drift;
  this is the part that makes someone add them.
- **Action (c) — the CI wiring.** `scripts/ci-select.mjs` maps `Server/**` to
  `server, integration, native` and `protocol/**` without `rust`
  (`:173-217`, Verify row 11), so a vector added in a server PR would merge
  with the Rust suite never run. Add a traced-dependency entry for the corpus
  path that selects `rust`; the existing `Server/` prefix branch supplies the
  rest. The file already has `SERVER_READS_OUTSIDE` / `CLIENT_READS_OUTSIDE`
  for exactly this shape — a third set checked in the same block, before the
  prefix branches, is the smallest change. Pin it in `scripts/ci-select.test.mjs`.
- **Validate:** `( cd Server && go test ./safefetch/ )` green; the coverage
  test observed **red** after temporarily deleting the only vector for one
  prefix (or adding a prefix with none); the ci-select test observed red with
  the new entry removed. Commit.

### Task 3: The native broker and its classifier

- **Action:** add `src-tauri/src/external_content.rs`: URL parse (scheme/port
  allowlist, reject embedded credentials and malformed authorities), resolve
  every A/AAAA answer, classify each with the **full** `safefetch` list, dial
  only the validated addresses (hostname kept for SNI), automatic redirects
  off with a small hand-followed budget re-running the whole check per hop,
  and a streaming byte ceiling plus total deadline plus type allowlist plus
  concurrency cap.
- **Gotcha:** this is the security core. Port every prefix in
  `Server/safefetch/classify.go:26-136`, including the documentation,
  benchmarking, NAT64-unwrap and `::/96` cases — a range the Go list has and
  the Rust list misses is exactly the C-09 clause 3 regression the contract
  names.
- **Gotcha:** read Task 2's corpus at **run time** from
  `CARGO_MANIFEST_DIR/../../Server/safefetch/testdata/classify_vectors.json`,
  not with `include_str!` — a compile-time include bakes the vectors into the
  binary and makes a corpus change look like a no-op rebuild.
- **Validate:** `cargo test` in `Client/src-tauri/` green over every vector,
  observed **red** after temporarily deleting one prefix from the Rust list.
  Commit.

### Task 4: The two commands and the typed minimum

- **Action:** expose **two** `#[tauri::command]`s and register both in
  `lib.rs`: one returning the typed minimum as JSON with an opaque image
  handle, one returning raw bytes for a handle over `tauri::ipc::Response`
  (Decision 5). No raw status, headers or body crosses the boundary (clause 7).
- **Gotcha:** the commands must be callable only for the broker's purposes —
  do not implement a generic `fetch(url, init)`; that recreates the wildcard in
  Rust. The bytes command takes a **handle**, not an arbitrary URL, wherever
  the caller already has one.
- **Gotcha:** two commands, not one, moves the handler count by **two** — see
  Task 12 and `platform-contracts.md`.
- **Validate:** `cargo test` green; both commands appear once each in
  `generate_handler!`. Commit.

### Task 5: OG and oEmbed parsing in Rust

- **Action:** parse the OG HTML in Rust (Decision 6) and return only the typed
  minimum. Extract `<title>` and the `og:*` / `twitter:*` metas from the first
  50 kB with `html5ever`, which is already in `Cargo.lock` via Tauri (Verify
  row 15) — no new build dependency. Do the same for oEmbed: parse the JSON in
  Rust and return the title. `parseOgTags` and its TS tests go away with row
  1's call site in Task 7.
- **Why this reverses the merged plan's default:** returning the bounded body
  hands the renderer a "GET any public URL and read its bytes" primitive, which
  is what clause 1 forbids in its own words, and contradicts both clause 7
  ("never raw status, headers or bodies to message-controlled code") and this
  plan's own Task 4. Clause 7 could not honestly be ticked with the body
  crossing the boundary.
- **Gotcha:** this is a **faithful port**, not a rewrite of the policy.
  `html5ever` is a spec-compliant parser, so it preserves the F7 fix's
  property (no backtracking regex); port `parseOgTags`'s tag precedence and
  whitespace handling case by case, and carry its TS test cases across as Rust
  test cases before deleting them.
- **Validate:** `cargo test` green, including a case per existing
  `parseOgTags` test. Commit.

### Task 6: The desktop binding and its suite

- **Action:** add `desktop/externalContent.ts` binding both contract methods to
  the two commands, register it on `desktop`, and write
  `tests/unit/platform/externalContent.suite.ts` + `.desktop.test.ts`, plus a
  null-subject entry in `suites-are-falsifiable.test.ts`.
- **Validate:** the suite is green against the desktop binding and **red**
  against the null subject in `suites-are-falsifiable`. Commit.

### Task 7: Link preview through the broker

- **Action:** move rows 1–2 (`embeds.ts`) off the plugin fetch and the
  webview `<img>`: the OG fetch goes through `preview()`, and the preview image
  arrives as broker-fetched bytes via `image()`, not an `og:image` URL the
  renderer loads. Remove the now-dead `isBlockedForPreview`/`isPrivateHost` TS
  string check (the broker's resolved-address classification replaces it) and
  `parseOgTags` (Rust owns it after Task 5).
- **Gotcha:** the broker keeps the `facebookexternalhit` User-Agent
  (Decision 2). Do **not** add an OwnCord version to it.
- **Gotcha:** bound the renderer-side `blob:` count FIFO the way
  `mediaObjectUrls` already is (`attachments.ts:373`). Those copies live in the
  webview, outside the Rust byte budget, so the budget does not bound them.
- **Validate:** `tests/unit/embeds.test.ts` green with its transport mocked at
  the broker seam; the private-host cases still refuse, now for the broker's
  reason. Commit.

### Task 8: YouTube, inline images and GIF renders through the broker

- **Action:** move rows 3–8. oEmbed (`media.ts`) goes through `preview()`;
  thumbnails, inline external images and sent-GIF renders arrive as
  broker-fetched bytes from `image()` rather than a raw `<img src>`. The iframe
  (row 5) is the hard case — a frame load cannot be brokered into bytes; keep
  the fixed host + sandbox and record the residual in Risks.
- **Gotcha:** `blob:` is same-origin, so the GIF-freeze canvas path stays
  untainted — this is why Decision 5 chose `blob:` over a custom URI scheme.
  Assert the freeze path still works rather than assuming it.
- **Validate:** `tests/unit/media.test.ts`, `tests/unit/gif-picker.test.ts`
  green. Commit.

### Task 9: The server-file fallback and avatar path

- **Action:** move row 9: `fetchServerFile`'s `!isServerUrl` branch
  (`attachments.ts:202`) and the external-avatar path (`avatar.ts`) go through
  the broker instead of a direct plugin fetch.
- **Gotcha:** the external branch must also stop writing its bytes into
  `memoryCache` and the IndexedDB store (Decision 4). After this task those two
  hold **server** content only, which is what makes the B7-13 hand-off clean.
- **Gotcha:** the server-hosted family (row 10) does **not** move here
  (Decision 3). The TOFU proxy keeps it. Do not add an "is this the server?"
  branch inside the broker.
- **Validate:** `tests/unit/attachments-*.test.ts`, `tests/unit/avatar.test.ts`
  green. Commit.

### Task 10: Cache ownership, partitioning and the aggregate budget

- **Action:** key the broker's cache by (profile/server, URL). Then take
  ownership of every cache that holds **external** content (Decision 4):
  `ogCache` (`embeds.ts:27`), `ytTitleCache` (`media.ts:129`) and
  `imageHeightCache` (`media.ts:55`) are folded into the broker cache, or at
  minimum cleared on teardown. Clear them from `MainPage.ts:954` alongside
  `clearAttachmentCaches`, and make the manual "clear cache" action
  (`AdvancedTab.ts:333-335`) clear the broker cache too. Add the process-wide
  aggregate byte budget and byte-weighted eviction B5 decision 2 deferred.
- **Why this is not optional:** with `ogCache` left unpartitioned and uncleared
  on teardown, a server switch still serves the previous server's previews out
  of the renderer however well the Rust cache is keyed — the acceptance box
  below would be ticked on a broker that does not deliver it.
- **Validate:** the partition test observed **red** with the key reverted to a
  bare URL; an over-budget read fails at a boundary value; a teardown test
  asserts the external caches are empty after `MainPage` teardown, observed red
  with the new clear call removed. Commit.

### Task 11: Narrow the capability **and** the CSP

- **Action:** with every row broker-served, shrink both controls in this PR:
  1. `http:allow-fetch` in `capabilities/default.json:16-43`. Confirm the
     loopback-only server paths still need `http://127.0.0.1:*` and that no
     external path needs `https://*`. Update `capabilities-scope.test.ts`.
  2. The CSP `img-src` in `tauri.conf.json:27`, today
     `img-src 'self' blob: https: data:`. Rows 2, 4, 6, 7 and 8 are webview
     `<img>` loads governed by this, **not** by the capability, so without this
     step nothing enforces that images go through the broker and a future
     `<img src="https://...">` silently works. Verify no legitimate consumer of
     `https:` in `img-src` remains, then drop it. `blob:` (broker bytes) and
     `data:` (the attachment cache's data URIs) stay. Pin the result in a new
     `tauri-conf-csp.test.ts`.
- **Gotcha:** capabilities are parsed by `tauri-build` at compile time and no
  local build is allowed (`Client/CLAUDE.md`), so a malformed pattern is caught
  only in CI's `tauri-build` job (B7-6's gate / PRD decision 12). The CSP
  string is not compile-checked at all — the `tauri-conf-csp.test.ts` pin and
  the native e2e run are its only gates.
- **Open, not decided here:** `connect-src` still carries a bare `https:`
  (`tauri.conf.json:27`). The same argument applies to it, but no renderer path
  was traced to it in this re-issue and the LiveKit SDK may need it. Record
  what you find; do not widen this task to cover it without the owner's call.
- **Validate:** the counts test, `capabilities-scope.test.ts` and
  `tauri-conf-csp.test.ts` green, each observed red against the pre-narrowing
  value. Commit.

### Task 12: Counts, docs and the final gate

- **Action:** update `docs/architecture/platform-contracts.md` — the counts
  table (**two** new `#[tauri::command]`s, so the handler count moves by two)
  and the new contract row. Add the one-paragraph clause-1 note to
  `docs/trust-model.md` (Decision 3): why the server-hosted family stays on the
  cert-pinned TOFU proxy rather than joining the broker, so clause 1 reads as
  answered rather than unmet. If `src/platform/**`'s knip ignore is now stale,
  record it under Open items rather than editing `Client/knip.json` (out of
  file table).
- **Gotcha:** the merged plan deferred the clause-1 note to "B7-5 or B7-18".
  B7-5 cannot take it — its file table is closed and names neither
  `docs/trust-model.md` nor the note (Verify row 14). B7-16 takes it here.
- **Validate:**

  ```
  npm --prefix Client test
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client run lint
  ( cd Client/src-tauri && cargo test )
  ( cd Server && go test ./safefetch/ )
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
( cd Client/src-tauri && cargo test )             # every corpus vector, plus the OG parser
( cd Server && go test ./safefetch/ )             # the corpus read + the prefix-coverage test
node scripts/ci-select.test.mjs                   # the corpus selects rust as well as server
npm run check:docs && npm run check:hygiene
# → then the ci-check skill; this PR touches Client/src-tauri/**, the
#   capability JSON and the CSP, so expect the tauri-build job (PRD decision
#   12), and it touches Server/safefetch test files, so expect the server job
```

## Risks

| Risk                                                                                            | Mitigation                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Rust classifier drifts from the Go one, reopening a blocked range                           | Task 2's three-part gate: a shared corpus, a Go test forcing a vector per prefix, and the `ci-select` entry that runs Rust when the corpus changes. Any one alone is not a gate                                              |
| Moving an image path to bytes regresses rendering (GIF freeze, lightbox, virtual-scroll height) | Keep `observeMedia`/lightbox call sites; assert them in the existing media/embeds suites before and after                                                                                                                    |
| The iframe (row 5) cannot be brokered into bytes and stays a frame load                         | Keep the fixed host + sandbox, and record the residual explicitly rather than claiming clause 1 fully met for frames                                                                                                         |
| Narrowing `https://*` (Task 9) breaks a path that still needs it                                | Only narrow after every row is broker-served in the same PR; prove the wildcard removal red-first in `capabilities-scope.test.ts`                                                                                            |
| Cache re-keying collides with B7-13's profile-isolation work                                    | Decision 4 sets the boundary by content, not by age: external-content caches are B7-16's, server-content caches are B7-13's. Task 9 makes the split true, so the hand-off B7-13 receives is "these hold server content only" |
| `AdvancedTab.ts` conflicts with B7-5, which also has it in its file table                       | Expected. Different functions in the same file — keep both edits (see Files to Change)                                                                                                                                       |
| The OG parser ported to Rust loses a case `parseOgTags` handled                                 | Task 5 carries each existing TS test case across as a Rust case **before** the TS function is deleted in Task 7                                                                                                              |
| Renderer `blob:` copies grow unbounded outside the Rust byte budget                             | Task 7 bounds the blob count FIFO, the way `mediaObjectUrls` (`attachments.ts:373`) already is                                                                                                                               |
| Dropping `https:` from `img-src` breaks an image path nobody traced                             | Task 11 verifies no legitimate consumer remains first, pins the result in `tauri-conf-csp.test.ts`, and the native e2e run exercises the real webview                                                                        |
| `tauri-build` cannot run locally, so a bad capability pattern is CI-only                        | Task 9's gotcha; the `tauri-build` job is the gate                                                                                                                                                                           |

## Out of scope

- The render gate and consent UI — B9 (`docs/plans/b5-community-content-moderation-2026-09-04.md:289-300`;
  PRD Out of scope).
- Server-side unfurling or any **production** change to `Server/safefetch` —
  decision 3. Its `classify_test.go` and `testdata/` are in scope (Decision 1).
- Moving profiles/connection isolation, and re-keying the durable IndexedDB
  store — B7-13 (Decision 4).
- The server-hosted attachment/avatar/emoji family (inventory row 10) — it
  keeps the cert-pinned TOFU proxy (Decision 3). B7-16 only records why in
  `docs/trust-model.md`.
- Narrowing `connect-src` — flagged in Task 11, not decided here.
- Decomposing `embeds.ts`/`media.ts`/`attachments.ts` beyond what moving the
  calls requires — B7-10.
- Browser adapter (`platform/browser/`) — B8, deferred.
- Any protocol or schema change. None is needed.

## Decisions (resolved 2026-09-20)

The merged plan carried six open questions. All six are answered; five change
tasks or the file table. Two were not preferences at all — the merged plan's
stated default contradicted something else inside the same plan, so it could
not have been implemented as written. A seventh item is a gap neither the plan
nor the questions covered.

Each decision says what was decided, why, and which task carries it.

### Decision 1 — keep the Rust classifier in sync via a shared vector corpus

**Decided:** option (b), the language-neutral corpus — **plus two wiring fixes
the merged plan omitted, without which shared vectors do not deliver what they
promise.** → Task 2, Files to Change (`Server/safefetch/testdata/`,
`classify_test.go`, `scripts/ci-select.mjs`).

Duplicating the list with a mirrored test (option a) drifts the day Go adds a
range. Generating Rust from Go source (option c) means parsing Go for a 40-row
table. The Go test is already a literal table (`classify_test.go:13-72`), so
lifting it to JSON is cheap.

But a corpus alone is not a gate:

1. **CI would not run the Rust tests when the corpus changes.**
   `scripts/ci-select.mjs:173-217` maps `Server/**` to server + integration +
   native and never rust; `protocol/**` omits rust too. A vector added in a
   server PR merges with the Rust suite never run.
2. **Vectors only catch drift if someone adds one.** A Go test asserting every
   `blockedPrefixes` entry has at least one vector makes a new Go range force a
   vector, and that vector turns Rust red.

**This relaxes the plan's own "do not edit `Server/safefetch/`" rule**, which
the merged plan stated one section after preferring option (b) — the
contradiction is resolved in favour of the corpus: no production change there,
`classify_test.go` and `testdata/` only.

### Decision 2 — keep the known-crawler User-Agent (owner's ruling)

**Decided by the owner, overruling the reviewer:** keep the
`facebookexternalhit` spoof, or an equivalent known-crawler UA. → Task 7.

**Why:** some sites serve OG tags only to known crawler UAs, and preview
coverage is the priority.

**The trade-off, stated plainly rather than hidden:** this is deliberate
impersonation of a third party's crawler. It is fragile as well as dishonest —
the real crawler comes from Meta's published address ranges, so a site that
verifies the requester's IP against those ranges, rather than trusting the UA
string, can still detect and block a preview coming from a residential IP. The
spoof buys coverage from sites that check the string and nothing from sites
that check the address.

The reviewer's other two grounds were an honest bot token
(`Mozilla/5.0 (compatible; OwnCord; +<repo URL>)`) and consistency with B6-15.
Those are overruled. **One part of the reviewer's concern stands and costs
nothing:** every preview goes from the viewer's machine to a host the message
author chose, so an exact version string would pair each viewer's IP with their
client build. **Do not carry the client version in the UA.** Today's literal
carries none; keep it that way.

### Decision 3 — the broker does not take over server-hosted attachments, avatars or emoji

**Decided:** the merged plan's default stands — rows 1–9 only; row 10 keeps the
cert-pinned TOFU proxy. → Task 9 gotcha, Task 12, Out of scope.

**Why, more strongly than the merged plan put it:** the two paths have opposite
trust models. The broker is web-PKI, public addresses only, no credentials. The
server path is a TOFU-pinned self-signed certificate, any address including the
LAN and the private ranges the classifier rejects **by design**, plus a bearer
token. Merging them puts an "is this the server?" branch inside the security
core, where a bug either skips classification for an attacker-chosen URL or
sends the bearer token to one. Two native paths make that bug class impossible,
and clause 1's intent is already met by `http_proxy.rs`.

**The hand-off error this fixes:** the merged plan deferred the clause-1
confirmation to "B7-5 or B7-18". B7-5's merged plan has a closed file table
that does not mention it and has not accepted it (Verify row 14). B7-16 takes
the one-paragraph note in `docs/trust-model.md` itself, in Task 12, and
`docs/trust-model.md` is added to the file table.

### Decision 4 — split cache ownership by what the cache holds, not by "old vs new"

**Decided:** by content. B7-16 owns every cache of **external** content;
B7-13 owns every cache of **server** content. → Task 9, Task 10, the cache
table above, Files to Change (`MainPage.ts`, `AdvancedTab.ts`).

**Why:** as worded, the merged plan failed its own acceptance. If `ogCache`
stays unpartitioned and uncleared on teardown, a server switch still serves the
previous server's previews out of the renderer however well the Rust cache is
partitioned. Verified: `MainPage.ts:954` clears attachment caches only, and
`clearEmbedCaches` / `clearMediaCaches` are called only from
`AdvancedTab.ts:333-335`.

So: `ogCache`, `ytTitleCache` and `imageHeightCache` are B7-16's — folded into
the broker cache, or at minimum cleared on teardown. Task 9 also stops writing
external bytes into `memoryCache` / IndexedDB once `fetchServerFile`'s external
branch moves, after which those hold server content only. The manual "clear
cache" action must clear the broker cache too.

`AdvancedTab.ts` is also in B7-5's file table; a conflict is expected and
resolved by keeping both edits.

### Decision 5 — image bytes cross as raw IPC bytes turned into a `blob:` URL, and that forces two commands

**Decided:** raw bytes over `tauri::ipc::Response` → `blob:` URL in the
renderer, **and the single command is split in two.** → Task 1, Task 4, Task 7.

**Why the transport:** `blob:` is already in the CSP `img-src`, the renderer
already manages `blob:` lifecycles, and `blob:` is same-origin, so the
GIF-freeze canvas path is not tainted — a custom URI scheme would risk exactly
that. Base64 costs 33% plus a JSON parse per image; temp files add a lifecycle.

**The design consequence the merged plan missed:** a raw-bytes response cannot
also carry the JSON typed minimum, so Task 3's "one command returns metadata
plus image bytes" does not work. Split it — `preview(url)` returns the typed
minimum with an opaque image handle, `image(handle | url)` returns raw bytes.
Rows 4, 6, 7 and 8 need only the second.

**And bound the blobs:** renderer-side `blob:` copies sit outside the Rust byte
budget, so cap their count FIFO the way `mediaObjectUrls` already is.

### Decision 6 — parse the OG HTML in Rust (this reverses the merged plan's default)

**Decided:** the broker parses; no body crosses the boundary. Same for oEmbed —
parse the JSON in Rust and return the title. → Task 5.

**Why the merged plan's default could not stand:** it contradicted clause 7 of
`docs/trust-model.md` ("never raw status, headers or bodies to
message-controlled code") **and** its own Task 3 - now Task 4 - ("No raw
status, headers or body crosses the boundary"). Returning the body hands the renderer a "GET any
public URL and read it" primitive — the general-purpose client clause 1 forbids
— and clause 7 could not honestly be closed without weakening a public security
document.

**And the cost was overstated.** The merged plan called Rust parsing "a
separate, larger change". `html5ever` is already in `Cargo.lock` via Tauri
(Verify row 15), so extracting `<title>` and the `og:*` metas from the first
50 kB is roughly 100–150 lines with no new build dependency — and because
`html5ever` is a spec-compliant parser, it is a faithful port of the DOMParser
fix rather than a regex regression.

### Decision 7 (the gap) — narrow the CSP, not only the capability

**Found in review; covered by neither the plan nor its questions.** → Task 11,
Verify row 13, Files to Change (`tauri.conf.json`, `tauri-conf-csp.test.ts`).

B7-16 narrows the wrong control for images. Clause 8 and the merged plan's
Task 9 narrow the `http:allow-fetch` capability — but rows 2, 4, 6, 7 and 8 are
webview `<img>` loads governed by the **CSP**, and `tauri.conf.json:27` still
reads `img-src 'self' blob: https: data:`. After the broker lands, nothing
enforces that images go through it: a future `<img src="https://...">` would
silently work.

Verify no legitimate user of `https:` in `img-src` remains, then drop it, in
the same PR as the broker.

## Open items this re-issue does not resolve

- **`connect-src` still carries a bare `https:`** (`tauri.conf.json:27`). The
  Decision 7 argument applies to it as well: once the broker owns every
  renderer fetch, the renderer's own `fetch` reaches the plugin over
  `http://ipc.localhost`, not `https:`. The only direct renderer `fetch` traced
  in this re-issue is `noise-suppression.ts:81` (`/rnnoise.wasm`, same-origin),
  but the LiveKit SDK's signalling path was **not** traced and may need it.
  Left open deliberately: narrowing it is a separate verification, not a line
  this plan can add blind. Task 11 records what the implementer finds.
- **The `src/platform/**` ignore in `Client/knip.json`** may be stale after
  the new contract lands. It is out of this file table because B7-5 owns it
  (`.claude/plans/b7-5-adapter-media-shell.plan.md:127`); Task 12 records what
  it finds rather than editing the file.

### What the implementation found (2026-09-21)

- **`connect-src` keeps its bare `https:` — something legitimate needs it.**
  Traced in `livekit-client` (`dist/livekit-client.esm.mjs`): the SDK itself
  calls the renderer's `fetch` on `toHttpUrl(<voice URL>)` — a `HEAD` from its
  browser `online`/`offline` handlers (network-reconnect detection), a GET of
  `/rtc/validate` after a signalling failure, and, for a LiveKit Cloud host,
  `/settings/regions` during connect. Through the TOFU proxy the voice URL is
  `ws://127.0.0.1:<port>/livekit`, so those land on `http://127.0.0.1:*`,
  already allowed. But `LiveKitUrlResolver.resolve` returns the server's
  `direct_url` unchanged when the configured host is loopback, and that is the
  operator's `livekit.url` — a `wss://` LiveKit (LiveKit Cloud, or a TLS
  LiveKit on another host) makes every one of those fetches `https:`.
  Dropping it would silently degrade that configuration: a refused `HEAD`
  reads as "still offline", so the SDK skips the immediate reconnect it makes
  when the network returns, and Cloud region discovery fails. `noise-suppression.ts:81` is same-origin. So `connect-src`
  is unchanged, and `tauri-conf-csp.test.ts` pins that it still carries
  `https:` so any later change is a decision. Narrowing it needs the LiveKit
  direct-URL path to go through a proxy first.
- **`Client/knip.json`'s `src/platform/**` ignore: B7-5 removed it** before
  this branch merged, and `knip` is part of `check:client`. It then flagged
  five of this milestone's type re-exports from `platform/contracts/index.ts`
  (`ExternalContentFailure`, `ExternalContentResult`, `ExternalImageHandle`,
  `ExternalImageSource`, `ExternalPreview`) as unused — every consumer imports
  them from `contracts/externalContent.ts` directly — so `index.ts` re-exports
  only `ExternalContentBroker`, the one `Platform` needs.
- **The User-Agent is the bare `facebookexternalhit/1.1` token**, without the
  crawler's `(+http://www.facebook.com/…)` comment: `src-tauri/src/config_gates.rs`
  forbids third-party host literals anywhere in the crate, and sites key on
  the product token. Still a known-crawler spoof, still no OwnCord version
  (Decision 2); pinned by `the_user_agent_is_a_crawler_token_with_no_owncord_version`.
- **The broker's cache is cleared on teardown without a third command.** Every
  call names a partition (server host + renderer cache epoch); naming a new
  one drops everything the old one cached. Teardown and the manual clear bump
  the epoch and immediately send an empty-URL preview under the new partition,
  which is refused before any network work — so the handler count still moves
  by exactly two.
- **A sixth refusal class, `expired-handle`.** The broker keeps at most 4096
  image handles and forgets the oldest; `image()` on a forgotten
  handle is refused as `expired-handle` rather than `unavailable`, so the
  renderer re-asks for the preview (once per URL per cache epoch) only when a
  fresh handle can actually help.
- **Tasks 3–5 landed as one commit**: the classifier, the vetted fetch, the
  OG/oEmbed parser and the two commands are one module whose tests need each
  other's types.

## Acceptance

- [ ] Every external renderer fetch (inventory rows 1–9) goes through one
      native broker; no renderer call site holds a general-purpose HTTP client
- [ ] The broker parses URLs, resolves and classifies **every** A/AAAA answer
      against the full `safefetch` range list, dials only validated addresses,
      disables automatic redirects, and bounds time, bytes, content type and
      concurrency
- [ ] The renderer receives a typed minimum; no raw status/headers/body and no
      remote image URL for a second un-brokered fetch
- [ ] The renderer never receives an HTML body or an oEmbed JSON document:
      OG and oEmbed parsing happen in Rust (Decision 6), and every case the TS
      `parseOgTags` covered has a Rust test
- [ ] One shared classifier corpus is read by both the Go and the Rust suite;
      a Go test fails if any `blockedPrefixes` entry has no vector; and
      `ci-select` selects `rust` when the corpus changes, pinned in
      `ci-select.test.mjs`. Each of the three observed red when removed
- [ ] The Rust classifier is observed red on a deleted prefix
- [ ] **Every** external-content cache is partitioned by profile/server and
      cleared on teardown — the broker's, plus `ogCache`, `ytTitleCache` and
      `imageHeightCache` (Decision 4) — and the manual "clear cache" action
      clears the broker cache. `memoryCache` / IndexedDB hold server content
      only, with the B7-13 hand-off recorded
- [ ] The aggregate byte budget and byte-weighted eviction have a boundary
      test, and the renderer-side `blob:` count is FIFO-bounded
- [ ] The preview User-Agent is a known-crawler token carrying **no** OwnCord
      version (Decision 2)
- [ ] The `ExternalContent` suite runs green against the desktop binding and is
      a null subject in `suites-are-falsifiable.test.ts`
- [ ] `http:allow-fetch`'s `https://*` is narrowed once every row is
      broker-served, pinned in `capabilities-scope.test.ts`
- [ ] The CSP `img-src` no longer carries `https:` (Decision 7), pinned in
      `tauri-conf-csp.test.ts`; what was found about `connect-src` is recorded
- [ ] `docs/trust-model.md` records why the server-hosted family stays on the
      TOFU proxy, so clause 1 reads as answered rather than unmet (Decision 3)
- [ ] `platform-contracts.md` counts updated for **two** new commands; the
      counts test is green
- [ ] No new `oxlint-disable` / `eslint-disable` / `@ts-ignore` /
      `@ts-expect-error` / `.skip` / `.only`; no loosened assertion; cycle ceiling
      not raised
- [ ] `ci-check` green, including the `tauri-build` job this branch triggers
