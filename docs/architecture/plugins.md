# Plugins — the experimental boundary

**Kind:** reference + boundary record. **Verified against:** `dev` @
`2b2d58ab`, 2026-08-29. **Satisfies:** BPR-080, BPR-081, BG-17; feeds HP-2
question 6.

OwnCord has a WASM plugin runtime. It is **experimental, off by default, and
absent from every shipped artifact**. This document says exactly what exists,
what it may not be relied on for, what could become a plugin after beta, and
what never will.

## Status: off, twice — and not in the release at all

| Layer          | Fact                                                                                                                                                                    | Anchor                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Build tag      | WASM execution compiles only under `-tags wazero`. The default build discovers and lists manifests but **never executes a module**                                      | `Server/plugin/sandbox_default.go:1-5` (`//go:build !wazero`); `sandbox_wazero.go` is the tagged twin |
| Config         | `plugins.enabled` defaults to `false`; the example config block is commented out and says "Disabled by default so existing operators are unaffected"                    | `Server/config/config.go:352`; `:449-457`                                                             |
| Startup        | The registry is only built when the flag is on; otherwise the plugin admin handler gets `nil`, lifecycle calls answer 503 and the list is empty                         | `Server/main.go:394`; `Server/api/router.go:35-37`, `:184`                                            |
| Release builds | `release.yml` builds `chatserver.exe` / `chatserver` with a plain `go build` — no `wazero` tag. The Docker image does the same. **No shipped binary can run a plugin.** | `.github/workflows/release.yml:261`, `:268`; `Server/Dockerfile:13`                                   |
| CI             | The `wazero` variants are compiled on every PR so they cannot rot, but their tests run only under the tag                                                               | `.github/workflows/ci.yml:52-55`, `:79`                                                               |

Configuration audit for HP-2 question 6 — is WASM off in every shape a server
can take?

| Shape                      | Verdict | Why                                                                                                                                                                                                                                       |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh install              | off     | default `false` (`config.go:352`); the generated `config.yaml` has the block commented out (`:452-457`)                                                                                                                                   |
| Upgraded install           | off     | an older `config.yaml` has no `plugins` key; koanf loads defaults first, so the absent key reads as `false`. A misspelled key is warned about and ignored (`Server/config/config.go:520`), which also leaves the default `false` in force |
| Docker                     | off     | image built without the tag (`Dockerfile:13`); `OWNCORD_PLUGINS_ENABLED=true` (`config.go:525-526` env provider) would flip the flag but the binary still cannot execute a module                                                         |
| Standalone release binary  | off     | same — no tag (`release.yml:261`, `:268`)                                                                                                                                                                                                 |
| Source build with the flag | **on**  | only `go build -tags wazero` **and** `plugins.enabled: true` together run WASM. This is the developer path and the only one                                                                                                               |

## No API promise

The plugin ABI — the five guest exports (`command_dispatch`, `allocate`,
`deallocate`, `list_commands`, and the manifest contract) — **may change or be
removed in any release without a deprecation period**
(`Server/plugin/examples/hello/README.md:6-10`). There are no supported
plugins, so there is nothing to keep compatible with. The example under
`Server/plugin/examples/hello/` is a reference for the ABI as it stands, not a
promise about the ABI to come; its prebuilt `.wasm` is not tracked
(`.gitignore:59`) and is not byte-reproducible (TinyGo embeds host paths —
`hello/README.md:70-74`).

**Release-notes wording for beta.** Use this text, unchanged, in the beta
release notes and anywhere plugins are mentioned to operators:

> Plugins are experimental. The WASM runtime is compiled out of release
> binaries and disabled by default in source builds. The plugin API carries no
> compatibility promise and may change or be removed without notice. Do not
> build on it for production use.

## What exists today (for the record)

Enough to know what "experimental" is guarding. All paths under `Server/plugin/`.

| Aspect        | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Anchor                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | wazero, one module instance per plugin, closed on context done                                                                                                                                                                                                                                                                                                                                                                                                                                       | `sandbox_wazero.go:102-103`                                                                                                 |
| Manifest      | JSON `plugin.json`; TOML `plugin.toml` only under the tag and preferred when both exist. Entrypoint must be a relative `.wasm` path. A zip with both is rejected as ambiguous (OC-0318)                                                                                                                                                                                                                                                                                                              | `manifest.go:52-61`, `:115`, `:144-148`; `manifest_toml.go:1-5`; `loader.go:39`; test `registry_test.go:696-700`            |
| Capabilities  | closed set `commands`, `events`, `storage`, `http`, `ui`; anything else fails load                                                                                                                                                                                                                                                                                                                                                                                                                   | `manifest.go:97-112`, `:151`                                                                                                |
| Memory        | **server-wide** cap: the shared wazero runtime is sized from `plugins.max_memory_mb` (default 64 MiB), clamped to the wazero page limit. A manifest's `resources.max_memory_mb` is validated but **not applied** — a plugin declaring 8 MiB can still grow to the server limit                                                                                                                                                                                                                       | `sandbox_wazero.go:83-102`; `config.go:126`, `:354`; manifest value only read in `manifest.go`                              |
| CPU           | a wall-clock deadline per invocation — the manifest's `cpu_budget_ms` if positive, else `plugins.cpu_budget_ms` if positive, else 100 ms as the final default (not a minimum: the example's 50 ms stays 50 ms). Not fuel-based: a runaway loop is killed by closing the module                                                                                                                                                                                                                       | `sandbox_wazero.go:300-325`; `config.go:128`, `:355`; TOML resource keys decode (OC-0338) — test `manifest_test.go:149-155` |
| HTTP          | only hosts on `plugins.http_allowlist` (empty by default), re-checked on every redirect hop; carried by `Server/safefetch`, so also http/https on 80/443 only, no credentials in the URL, every resolved address classified before the connect and the connect bound to those addresses, at most 5 hand-followed redirects with no scheme downgrade, a 10 s total deadline, a streaming 5 MiB ceiling on the wire and after inflation, and a content-type allowlist checked against the sniffed type | `host_http.go:40-53`, `:67-98`, `:105-136`, `:154-187`; `Server/safefetch/`; tests `TestHTTPDo_*`, `TestFetch_*`            |
| Storage       | a per-plugin key/value namespace, scan size clamped; no other table is reachable                                                                                                                                                                                                                                                                                                                                                                                                                     | `pluginstore.go:12-24`; `host_storage.go:27-66`                                                                             |
| Filesystem    | none — no WASI preview-1 filesystem is mounted                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `sandbox_wazero.go:77-78`                                                                                                   |
| Host imports  | `wasi_snapshot_preview1` is instantiated (`sandbox_wazero.go:105`) — clocks, randomness, standard streams; no preopened filesystem. **The OwnCord-specific imports are not wired yet:** the `http`, `storage`, `events` and `ui` APIs exist on the Go side of the registry, and a guest module today can only receive `command_dispatch`                                                                                                                                                             | `sandbox_wazero.go:311-316`                                                                                                 |
| Admin surface | `GET /`, `POST /install` (zip), `POST /{id}/enable`, `POST /{id}/disable`, `DELETE /{id}` under `/api/v1/admin/plugins`, behind the admin IP allowlist **and** an admin session — a LAN peer on the allowed CIDR cannot install without one. Install and uninstall are audited                                                                                                                                                                                                                       | `Server/api/plugins_handler.go:43-47`; `Server/api/router.go:171-186`; test `TestAuditCoverage_PluginLifecycle`             |
| Client        | no plugin UI exists in the desktop client                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `grep -rn plugin Client/src` hits only `@tauri-apps/plugin-*` imports                                                       |

## Could become a plugin after beta (BPR-081)

Cohesive features and provider integrations that are natural plugin shapes.
**During beta they stay where they are**, in core, behind the same tests — the
audit names them so the boundary is a decision, not drift. Nothing on this list
moves behind the experimental runtime before a supported plugin API exists.

| Candidate                                             | Lives today                                                                                                 | Why it is a candidate                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| GIF provider (Klipy)                                  | `Server/api/gif_handler.go` (server proxy, `gif.api_key`)                                                   | one vendor behind one endpoint; swapping vendors should not touch core      |
| Link-preview and embed providers (YouTube oEmbed, OG) | `Client/src/components/message-list/media.ts`, `embeds.ts` (moves behind the B7 native broker first — C-09) | provider-shaped; the destination policy stays core                          |
| Slash commands and automation                         | the `plugin_command` protocol family already exists (`protocol/schema.json`)                                | the one thing the runtime can dispatch today                                |
| Webhooks (inbound and outbound)                       | not implemented                                                                                             | classic integration seam                                                    |
| Optional moderation automation                        | not implemented; human moderation in `Server/service/moderation.go`                                         | may _suggest_; **human authority and the moderation audit trail stay core** |
| UI tabs / panels                                      | `ui` capability reserved (`host_ui.go`), no client side                                                     | display-only extension point                                                |
| Import/export bridges (other chat platforms)          | not implemented                                                                                             | one-shot data movers with no security surface of their own                  |
| Observability exporters                               | `Server/telemetry/` (OTel, `-tags otel`, exporter `none` by default)                                        | already a build-tagged optional edge                                        |

## Core that never moves

These stay in the server and client proper, permanently, whatever the plugin
system becomes. A plugin may _call_ some of them; none may _replace_ or
_bypass_ them.

| Concern                       | Owner                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Authentication, sessions, 2FA | `Server/auth/`, `Server/api/auth_handler.go`                                               |
| Authorization                 | `Server/permissions/` (one predicate per property — B2-5)                                  |
| TLS and certificate pinning   | `Server/auth/tls.go`; `Client/src-tauri/src/tofu.rs`                                       |
| Safe outbound fetch           | `Server/safefetch/` (C-09 clauses 2–6, server side); the B7 native broker (C-09 1, 7, 8)   |
| Quotas and rate limits        | `Server/auth/ratelimit*.go`, per-action limits in `Server/service/`                        |
| Voice/video E2EE              | `Client/src/lib/e2eeCrypto.ts`, `livekitE2EE.ts`, `identity.ts`; `Server/ws/voice_e2ee.go` |
| Updates and signatures        | `Server/updater/`, `Server/api/client_update.go`                                           |
| Deletion and account removal  | `Server/db/account.go`                                                                     |
| Backup and recovery           | `Server/admin/handlers_backup.go`, `Server/db/admin_queries.go`                            |
| Moderation audit              | `Server/db/audit*.go`, `Server/db/audittest/`, `TestAuditCoverage_*`                       |

The trust statements these back are in [../trust-model.md](../trust-model.md).

## Maintenance

**Source of truth:** `Server/plugin/`, `Server/config/config.go` (`PluginsConfig`
and its defaults), `Server/main.go` (registry construction),
`.github/workflows/release.yml` and `Server/Dockerfile` (build flags),
`Server/plugin/examples/hello/README.md` (ABI and toolchain). A change to any of
those that alters a row above updates this document in the same PR. The
release-notes paragraph is quoted verbatim by the beta release; change it here
first.
