# Platform contract map — desktop and browser

**Kind:** target-state map. **Status:** design record only — the seam described
here **does not exist in the code yet**.
**Measured against:** `dev` @ `eb873fe7`, 2026-08-27.
**Closes:** `RL-02` / `L-02` (B1-8). **Executed by:** B7.

OwnCord is a Tauri desktop app whose frontend talks to native APIs directly.
Beta requires the same frontend to also run in a browser. This document records
**where the seam between "shared app" and "native host" will go**, and what has
to move across it — so that B7 executes a decided plan instead of rediscovering
the surface.

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
| Files under `Client/src/` importing `@tauri-apps/*`        | 20    |
| Distinct `invoke` command names called from `Client/src/`  | 26    |
| `#[tauri::command]` handlers in `Client/src-tauri/`        | 30    |
| TS calls with no matching Rust handler                     | 0     |
| Uses of the `window.__TAURI__` global                      | 0     |
| Environment-detection helper (`isDesktop()` or equivalent) | none  |
| Files under `Client/src/platform/`                         | 0     |

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

Four Rust handlers are registered but never invoked from `Client/src/`:
`get_cert_fingerprint` and `store_cert_fingerprint` (used by
`Client/tests/e2e/helpers.ts`), and `probe_credential_store` and `ptt_get_key`
(no caller anywhere). The latter two are dead-surface candidates — B7's call,
not B1's.

There is no `window.__TAURI__` access and no environment branching, which is
good news: every native dependency is a static or dynamic **import**, so a
static check can find all of them. The only `typeof window` guards in
`Client/src/lib/` are in `channel-mutes.ts` and `logger.ts`, and are unrelated
to desktop/browser branching.

## Proposed contracts

Thirteen capability clusters. Each becomes one file under `contracts/`, with
matching implementations under `desktop/` and `browser/`.

| Contract          | Files today                                                                   | Native surface                                      | Browser outlook                                           |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| HTTP fetch        | `lib/api.ts`, `lib/profiles.ts`, `message-list/{attachments,embeds,media}.ts` | `plugin-http`                                       | native `fetch` — but CORS becomes a server concern        |
| WebSocket         | `lib/ws.ts`                                                                   | `api/core`, `api/event`; 4 invokes, 4 event listens | ⚠ see hard cases                                          |
| Secret storage    | `lib/credentials.ts`, `lib/identity.ts`                                       | `api/core`; 8 invokes                               | ⚠ see hard cases                                          |
| Settings          | `lib/profiles.ts`                                                             | `api/core` (`save_settings`, `get_settings`)        | `localStorage` / IndexedDB                                |
| Native proxies    | `lib/livekitSession.ts`, `lib/httpProxy.ts`                                   | `api/core`; 4 invokes                               | not needed — the proxies exist to work around desktop TLS |
| Notifications     | `lib/notifications.ts`                                                        | `plugin-notification`, `api/window`                 | Notification API + Page Visibility                        |
| Filesystem / logs | `lib/logPersistence.ts`, `settings/AdvancedTab.ts`, `settings/LogsTab.ts`     | `api/path`, `plugin-fs`                             | in-memory ring buffer + download                          |
| Window            | `lib/window-state.ts`, `lib/notifications.ts`                                 | `api/window`                                        | mostly unsupported; degrade                               |
| Updater / process | `lib/updater.ts`, `settings/AdvancedTab.ts`                                   | `api/core`, `plugin-process`, `plugin-autostart`    | unsupported — the page reloads instead                    |
| Shell / opener    | `lib/admin-panel.ts`, `main.ts`                                               | `plugin-opener`                                     | `window.open`                                             |
| File save / pick  | `message-list/attachments.ts`                                                 | `plugin-dialog`, `plugin-fs`                        | `<a download>` / File System Access API                   |
| Input / PTT       | `lib/ptt.ts`                                                                  | `api/core`, `api/event`; 5 invokes                  | ⚠ see hard cases                                          |
| Deep links        | `lib/deep-link.ts`                                                            | `plugin-deep-link`                                  | URL routing                                               |
| App metadata      | `settings/LogsTab.ts`                                                         | `api/app`                                           | build-time constant                                       |

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

- `Client/src/lib/`, `Client/src/components/` — the 20 files listed above
- `Client/src-tauri/src/lib.rs` — the `generate_handler!` registration list
- [`docs/audit-2026-08-23-repository-layout.md`](../audit-2026-08-23-repository-layout.md) — `RL-02`, and the target tree
- [`docs/plans/beta-requirements-traceability-2026-08-23.md`](../plans/beta-requirements-traceability-2026-08-23.md) — `BPR-025`
- [`docs/architecture/client.md`](client.md) — the client as-built

Per this directory's maintenance rule: a PR that adds a new `@tauri-apps` import
to `Client/src/`, or a new `#[tauri::command]`, updates the counts and the
cluster table here in the same change.
