# Platform contract map — desktop and browser

**Kind:** target-state map. **Status:** design record only — the seam described
here **does not exist in the code yet**.
**Measured against:** `dev` @ `a3a0a49b`, 2026-09-18.
**Closes:** `RL-02` / `L-02` (B1-8). **Executed by:** B7.

OwnCord is a Tauri desktop app whose frontend talks to native APIs directly.
The plan is for the same frontend to also run in a browser _(amended
2026-09-18, owner decision: B8, the browser client, is deferred to
post-beta — the beta ships desktop-only; B7's contracts below still land in
the beta so the browser target stays possible without rework)_. This document
records **where the seam between "shared app" and "native host" will go**, and
what has to move across it — so that B7 executes a decided plan instead of
rediscovering the surface.

> **Nothing here is implemented.** B1 was an explicitly non-functional phase:
> _"No native behaviour moves in B1. Adapter extraction is B7 and must not be
> smuggled in."_ This file adds no directory, no interface, and no code.

## Target layout

```
Client/src/platform/
├── contracts/   # TypeScript interfaces only. No imports from @tauri-apps.
├── desktop/     # Tauri implementations. The ONLY place @tauri-apps may appear.
└── browser/     # Web-standard implementations, or an explicit refusal.
```

The rule this eventually enforces is `BPR-025`
([traceability](../plans/beta-requirements-traceability-2026-08-23.md)):

> Static checks keep native imports inside desktop ownership; the same
> domain/store/protocol suites run against desktop and browser adapters.

Two consequences worth stating now, because they shape the interface design:

- **Contracts must be async everywhere.** Some operations are synchronous in a
  browser and IPC round-trips on desktop. A contract that exposes a sync method
  cannot be implemented by the desktop side.
- **A browser adapter is allowed to refuse.** Three capabilities below have no
  web equivalent. The contract must let an adapter say "unsupported" and let the
  app degrade, rather than force a fake implementation that fails at runtime.

## What exists today

Measured with `git grep`, not estimated:

| Measure                                                    | Value |
| ---------------------------------------------------------- | ----- |
| Files under `Client/src/` importing `@tauri-apps/*`        | 21    |
| Distinct `invoke` command names called from `Client/src/`  | 29    |
| `#[tauri::command]` handlers in `Client/src-tauri/`        | 33    |
| TS calls with no matching Rust handler                     | 0     |
| Uses of the `window.__TAURI__` global                      | 0     |
| Environment-detection helper (`isDesktop()` or equivalent) | none  |
| Files under `Client/src/platform/`                         | 0     |

The handler count covers both attribute spellings — 21 `#[tauri::command]` plus
12 `#[tauri::command(async)]` — so a `git grep '#\[tauri::command\]'` with exact
brackets undercounts to 21. Attributes and registrations are two different
counts: of the 33 attributed functions, 31 appear in `generate_handler!`
(`Client/src-tauri/src/lib.rs`), and one of those, `open_devtools`, sits behind
`#[cfg(feature = "devtools")]`, so a default build registers 30.

Reproduce:

```bash
git grep -l "@tauri-apps" -- 'Client/src/**' | wc -l
git grep -hoE '(tauriInvoke|invoke)(<[^>]*>)?\(\s*"[a-z_]+"' -- 'Client/src/**' \
  | grep -oE '[a-z_]+"$' | tr -d '"' | sort -u | wc -l
```

Note the alias: `Client/src/lib/ws.ts` binds `core.invoke` to a local
`tauriInvoke` before calling it, so a regex that only matches `invoke("…")`
undercounts by four (`ws_connect`, `ws_send`, `ws_disconnect`,
`accept_cert_fingerprint`). Any future lint rule enforcing the seam must match
the binding, not the call site.

One registered Rust handler is never invoked from `Client/src/`:
`get_cert_fingerprint`, which the native E2E harness calls directly
(`Client/tests/e2e/native/helpers.ts`) and `Client/tests/e2e/helpers.ts` stubs.
It stays registered as "consumed by tests, unconsumed in production" (B7 PRD
open question 11). `probe_credential_store`, the one handler with no caller
anywhere, was deleted in B7-0. An earlier revision of this paragraph also named
`store_cert_fingerprint` and `ptt_get_key`; neither command has ever existed in
`generate_handler!`, so nothing further is owed there.

There is no `window.__TAURI__` access, and the only environment branching is
the SDK `isTauri` guard in `lib/pendingMessages.ts` (imported, not global), which is
good news: every native dependency is a static or dynamic **import**, so a
static check can find all of them. The only `typeof window` guards in
`Client/src/lib/` are in `channel-mutes.ts` and `logger.ts`, and are unrelated
to desktop/browser branching.

## Proposed contracts

Fifteen capability clusters. Each becomes one file under `contracts/`, with
matching implementations under `desktop/` and `browser/`.

| Contract          | Files today                                                                   | Native surface                                       | Browser outlook                                           |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| HTTP fetch        | `lib/api.ts`, `lib/profiles.ts`, `message-list/{attachments,embeds,media}.ts` | `plugin-http`                                        | native `fetch` — but CORS becomes a server concern        |
| WebSocket         | `lib/ws.ts`                                                                   | `api/core`, `api/event`; 4 invokes, 4 event listens  | ⚠ see hard cases                                          |
| Secret storage    | `lib/credentials.ts`, `lib/identity.ts`, `lib/pendingMessages.ts`             | `api/core`; 11 invokes, plus the SDK `isTauri` guard | ⚠ see hard cases                                          |
| Settings          | `lib/profiles.ts`                                                             | `api/core` (`save_settings`, `get_settings`)         | `localStorage` / IndexedDB                                |
| Native proxies    | `lib/httpProxy.ts`, `lib/livekitUrlResolver.ts`                               | `api/core`; 3 invokes                                | not needed — the proxies exist to work around desktop TLS |
| Notifications     | `lib/notifications.ts`                                                        | `plugin-notification`, `api/window`                  | Notification API + Page Visibility                        |
| Filesystem / logs | `lib/logPersistence.ts`, `settings/AdvancedTab.ts`, `settings/LogsTab.ts`     | `api/path`, `plugin-fs`                              | in-memory ring buffer + download                          |
| Window            | `lib/window-state.ts`, `lib/notifications.ts`                                 | `api/window`                                         | mostly unsupported; degrade                               |
| Updater / process | `lib/updater.ts`, `settings/AdvancedTab.ts`                                   | `api/core`, `plugin-process`, `plugin-autostart`     | unsupported — the page reloads instead                    |
| Shell / opener    | `lib/admin-panel.ts`, `main.ts`                                               | `plugin-opener`                                      | `window.open`                                             |
| File save / pick  | `message-list/attachments.ts`                                                 | `plugin-dialog`, `plugin-fs`                         | `<a download>` / File System Access API                   |
| Input / PTT       | `lib/ptt.ts`                                                                  | `api/core`, `api/event`; 5 invokes                   | ⚠ see hard cases                                          |
| Deep links        | `lib/deep-link.ts`                                                            | `plugin-deep-link`                                   | URL routing                                               |
| App metadata      | `settings/LogsTab.ts`                                                         | `api/app`                                            | build-time constant                                       |
| Dev tools         | `main.ts:86-89`, `settings/AdvancedTab.ts:70`                                 | `api/core` (`open_devtools`)                         | unsupported — the browser has its own devtools already    |

Two files appear under more than one contract (`lib/profiles.ts` does HTTP and
settings; `settings/AdvancedTab.ts` spans four). That is expected — the clusters
are capabilities, not a file partition, and those files split during extraction.

## Hard cases — where a browser adapter cannot be a shim

These three are not implementation details. Each is a product decision that B7
must take deliberately, and each changes what the browser build **is**.

**`lib/ws.ts` — certificate TOFU.** The desktop client tunnels its WebSocket
through Rust specifically so it can pin a self-signed certificate on first use
(`accept_cert_fingerprint`, the `cert-tofu` event). A browser cannot inspect or
pin a certificate; the user agent decides, and a self-signed server is simply
refused. The browser adapter must **degrade honestly** — require a
publicly-trusted certificate and say so — not emulate the flow. This trust path
has been hardened twice already (identity TOFU, then a re-pin TOCTOU); do not
let a browser adapter quietly reopen it.

**`lib/credentials.ts` / `lib/identity.ts` — OS keychain.** Secrets live in
Windows Credential Manager / GNOME Keyring / macOS Keychain, and
`Client/src-tauri/src/secret_store.rs` reads each write back before returning.
The browser has no peer for this. Whatever the browser adapter stores, it is
strictly weaker, and the E2EE identity key is among the secrets involved. This
is a security-posture decision, not a storage swap.

**`lib/ptt.ts` — push-to-talk.** PTT is deliberately hand-rolled rather than
using `plugin-global-shortcut`, because it must observe a key held down while
OwnCord is unfocused. A browser cannot see keys outside its tab. The browser
adapter can offer in-tab PTT or voice-activity detection, but not the desktop
behaviour.

## Contracts (B7-3)

B7-3 implemented this design. `Client/src/platform/contracts/` holds one
type-only file per row of the map above (17 files, `index.ts` re-exporting
each and a `Platform` interface with one readonly member per interface), and
`Client/src/platform/desktop/index.ts` is an empty, typed `Partial<Platform>`
that B7-4/B7-5 fill in one capability at a time. Nothing moved: every call
site still lives where the "Files today" column above says it does.

Six rules the reviewer checked, kept here because they hold for every future
addition to `contracts/`, not just B7-3's:

1. **Contracts mirror the native seam.** A contract method describes one
   native capability and the value its caller receives, with today's exact
   parameters and result types where an exported function already sits at
   that seam. No API redesign.
2. **Host-neutral, down to the text.** No `@tauri-apps` import, no Tauri
   type, no "Tauri"/"invoke" in an identifier — and the literal strings
   `@tauri-apps` and `invoke("` must not appear anywhere under
   `src/platform/`, comments included.
3. **No production imports, no domain types.** Contracts import nothing from
   `@lib/*`/`@stores/*`/`@components/*`/`@pages/*`. Small host result types
   are re-declared, structurally identical, rather than imported.
4. **Reuse before inventing.** Where an existing interface already has the
   right shape (`PersistenceBackend`, `PendingMessagePersistence`), the
   contract matches it member for member so the call-site move stays a pure
   rename.
5. **The typechecker is the oracle.** Each seam row's suite assigns today's
   legacy binding to a variable typed as the contract with no cast — a cast
   there would mean the contract is wrong.
6. **Suites assert behaviour, not wiring.** A suite sees only
   `{ subject, native }` and never a command name; command/argument
   assertions stay in the modules' existing unit tests.

Eight of the 17 rows already sit behind an exported function today (`seam`
in the responsibility map this milestone worked from) and got a behaviour
suite now, run against a legacy binding of today's `src/lib` exports:
`CredentialStore`, `IdentityStore`, `SettingsStore`, `LogFiles` (the
`logPersistence` half only), `NativeProxies` (`ensureHttpProxy` only),
`AppUpdater`, `PushToTalk`, `DeepLinks`. Those suites live in
`Client/tests/unit/platform/*.suite.ts`, run today against
`*.legacy.test.ts`; B7-4/B7-5 re-run the same suite files against
`platform/desktop` once each capability's call sites move — a green run
before and after is the evidence the move changed nothing. The remaining
rows (and the no-seam half of the two split rows above) are contract-only
until the milestone that creates their seam writes the suite.

**Suite coverage gaps.** A round-3 adversarial review found suite tests whose
only assertion a completely inert, do-nothing subject also satisfies —
`Client/tests/unit/platform/suites-are-falsifiable.test.ts` now runs every
suite against exactly such a subject to catch this mechanically. Two methods
have no caller-visible effect at their seam beyond "did not reject", which an
inert subject also never does, and are left untested rather than pinned to a
green that means nothing:

- `SettingsStore.save()`'s success path — `save(): Promise<void>` gives the
  caller nothing to observe beyond not rejecting; the rejection paths (native
  error, native host unavailable) are still covered.
- `DeepLinks.init()`'s native-host-unavailable path — resolving without
  calling either callback is exactly what a subject that does nothing at all
  also does; the cold-start paths (invite, message permalink) are still
  covered.

`Client/knip.json` ignores `src/platform/**` for now — every file under it is
exported for a consumer that doesn't exist yet. B7-4 removes that ignore the
moment the first production call site imports from `platform/desktop`.

## Ownership

**No human owners are recorded for these folders, here or anywhere in the
repository.** That is a real gap, not an omission in this document — assigning
them is unstarted work. Until then, ownership is by phase, matching the
convention already used in the
[issue register](../plans/repo-health-issue-register-2026-08-23.md):

| Area                                          | Phase  |
| --------------------------------------------- | ------ |
| `contracts/`, `desktop/`, `browser/`          | **B7** |
| The static check enforcing the seam (BPR-025) | **B7** |
| Browser build target and PWA packaging        | **B8** |
| Protocol contract both adapters speak         | **B2** |

## Source of truth

- `Client/src/lib/`, `Client/src/components/` — the 21 files listed above
- `Client/src-tauri/src/lib.rs` — the `generate_handler!` registration list
- [`docs/audit-2026-08-23-repository-layout.md`](../audit-2026-08-23-repository-layout.md) — `RL-02`, and the target tree
- [`docs/plans/beta-requirements-traceability-2026-08-23.md`](../plans/beta-requirements-traceability-2026-08-23.md) — `BPR-025`
- [`docs/architecture/client.md`](client.md) — the client as-built

Per this directory's maintenance rule: a PR that adds a new `@tauri-apps` import
to `Client/src/`, or a new `#[tauri::command]`, updates the counts and the
cluster table here in the same change. That rule is now enforced rather than
promised — `Client/tests/unit/platform-contracts-counts.test.ts` re-derives all
three counts from the tree and fails when the table above disagrees, so a
forgotten update is red in CI instead of drifting.
