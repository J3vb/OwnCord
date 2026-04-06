# OwnCord — Phase C: Differentiation

**Step 9 | When Phase 6 Features Start | Community Scale Edition**

*Wazero Plugin Runtime • Game Detection • Server Browser • Stats*

---

## Phase Overview

Phase C is about what makes OwnCord different from every other Discord alternative. The plugin system is the core differentiator — game detection, server browser, stats, leaderboards, screenshots. All of these are implemented as plugins, not core features, which keeps the server lean while enabling an ecosystem.

This phase has a single step: implementing the plugin runtime using Wazero. It waits until the plugin features from the product roadmap (Phase 6) are actively being built. There is no urgency to implement the runtime before the features that use it are in scope. The server foundation from Phase A and the client framework from Phase B must be in place first.

### Timeline

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 9 | Wazero plugin runtime | 4–6 weeks | Step 1 | When Phase 6 starts |

### Milestone Gate

**After Phase C:** The plugin runtime enables the gaming features that differentiate OwnCord from every other Discord alternative. Game detection, rich presence, playtime tracking, server browser, stats, and leaderboards all run as sandboxed WASM plugins. Third-party developers can build and distribute plugins through the plugin marketplace.

### Prerequisites

- **Phase A complete:** The service layer (Step 1) provides the host API surface that plugins call into. The Store interface (Step 3) provides plugin-scoped storage. The pub/sub hub (Step 5) enables plugins to emit events to subscribed clients.
- **Phase B complete:** The Solid.js frontend (Step 6) enables plugin UI tabs and widgets. OpenTelemetry (Step 8) provides plugin performance monitoring.

---

## Step 9: Use Wazero for Plugin Runtime

**Effort:** High (4–6 weeks) | **Impact:** High | **Phase:** C — Differentiation

### Problem

The plugin system is OwnCord's core differentiator — game detection, server browser, stats, leaderboards — but the runtime is only designed, not implemented. The design mentions WASM or shared library loading. Shared libraries (.so/.dll) offer no sandboxing, crash the host process on failure, and are platform-specific. At community scale, a misbehaving plugin taking down a 100-user server is unacceptable.

### Options

| Option | Details | Verdict |
|--------|---------|---------|
| **Wazero** | Pure-Go WebAssembly runtime. No CGO. Memory-sandboxed, resource-limited, language-agnostic plugin authoring (Rust, Go, C, AssemblyScript). | **RECOMMENDED** |
| Extism | Plugin framework built on Wazero. Higher-level API, easier plugin development. Adds a dependency layer on top of Wazero. | VIABLE |
| Shared libs | Native .so/.dll loading via Go plugin package. No sandboxing, platform-specific, crashes take down the server. | AVOID |
| gRPC sidecar | Plugins as separate processes communicating via gRPC. Strong isolation but heavy: each plugin is a full process with its own lifecycle. | VIABLE |

### Why Wazero

Wazero is the recommended choice because it is pure Go (no CGO, matching the existing constraint), provides real memory sandboxing, supports resource limits per plugin (CPU and memory caps), and enables language-agnostic plugin development. Plugins compile to WASM from Rust, Go, C, or AssemblyScript. A crashing plugin cannot take down the server. At community scale this isolation is non-negotiable — you cannot allow a third-party plugin to crash a server serving 100+ users.

Extism is a viable alternative if you want a higher-level abstraction over Wazero. It simplifies plugin authoring with PDKs (Plugin Development Kits) for multiple languages and handles memory management between host and guest. The tradeoff is an additional dependency and less control over the low-level WASM runtime. For OwnCord's plugin use cases (game detection, server queries, stats computation), the raw Wazero API is sufficient and more transparent.

### Pros & Cons (Wazero)

| Pros | Cons |
|------|------|
| Pure Go — no CGO, matches existing constraint | WASM has limited I/O capabilities by design |
| Real memory sandboxing (plugins can't crash server) | Plugin performance is slower than native (~2–5x) |
| Resource limits per plugin (CPU, memory) | Debugging WASM plugins is harder than native code |
| Language-agnostic: Rust, Go, C, AssemblyScript → WASM | Plugin authors must learn WASM toolchain |
| Well-defined host API for plugin ↔ server communication | Complex host API design for game detection, UI tabs, etc. |
| Critical for community scale — isolation is non-negotiable | |

---

## Architecture

The plugin runtime has four components: the loader, the host API, the sandbox, and the client bridge.

### Plugin Loader

Reads plugin.toml manifests, validates declared permissions, loads the .wasm binary into a Wazero runtime instance. Each plugin gets its own isolated module with a dedicated memory space. The loader handles plugin lifecycle: install, enable, disable, uninstall, update.

### Host API

The server exposes functions that plugins can call through WASM imports. These are the capabilities a plugin requests in its manifest:

- **commands:** Register slash commands (/playtime, /serverstatus, /stats). The command dispatcher routes user input to the owning plugin.
- **events:** Subscribe to server events (message_send, user_join, voice_join). The pub/sub hub (Step 5) delivers subscribed events to the plugin.
- **storage:** Plugin-scoped key-value storage via the Store interface (Step 3). Each plugin gets its own namespace. No cross-plugin data access.
- **http:** Outbound HTTP requests (for querying game servers, APIs). Proxied through the server with configurable allowlists per plugin.
- **ui:** Register UI tabs and widgets that render in the Solid.js client (Step 6). Plugin declares HTML/JS assets, client renders them in an iframe sandbox.

### Sandbox

Each plugin instance runs with enforced limits: maximum memory allocation (default 64MB), CPU time budget per invocation (default 100ms), and no direct filesystem or network access. The server monitors resource usage and kills plugins that exceed their budget. A crashed or killed plugin is automatically disabled and the admin is notified via the mod log channel.

### Client Bridge

Plugins that declare UI capabilities get a rendering surface in the Solid.js client. Plugin UI runs in a sandboxed iframe with postMessage communication to the host client. The host provides a theme-aware CSS injection so plugin UIs match OwnCord's look and feel. The client bridge also handles plugin-specific settings panels.

---

## Implementation Plan

1. Define the plugin.toml manifest format: name, version, author, permissions (commands, events, storage, http, ui), resource limits. Validate against a JSON schema.
2. Implement the Wazero runtime wrapper: module loading, memory allocation, function imports/exports, lifecycle management (start, stop, restart).
3. Implement the host API functions one capability at a time. Start with commands (simplest — input/output only), then events (requires pub/sub integration), then storage, then HTTP.
4. Build the first plugin: game detection. This exercises commands (user queries playtime), events (presence updates), storage (playtime database), and HTTP (Steam API queries). If game detection works, the architecture is validated.
5. Add the UI capability: client-side iframe sandbox, postMessage bridge, theme injection. Build the server browser plugin to validate the UI integration.
6. Implement plugin marketplace: browse available plugins, install/update/remove from within the admin panel. Plugin packages are .wasm + assets in a zip archive hosted on a registry (GitHub Releases initially).

---

## Complete Timeline — All Phases

For reference, here is the complete execution timeline across all three phases.

### Phase A: Foundation (Weeks 1–7)

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 1 | Extract service/domain layer + permission cache | 2–3 weeks | — | No |
| 2 | Adopt sqlc | 1 week | — | Yes (with 1) |
| 3 | Abstract DB + PostgreSQL target | 2–3 weeks | Steps 1+2 | No |
| 4 | Consolidate logging | 1–2 days | — | Yes (anytime) |
| 5 | Refactor hub to pub/sub + global rate limits | 2–3 weeks | Step 1 | After Step 1 |

### Phase B: Acceleration (Weeks 6–14)

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 6 | Adopt Solid.js (incremental) | 4–6 weeks | — | Yes (client-side) |
| 7 | Event persistence layer | 1–2 weeks | Steps 1+3 | Yes (with 6, 8) |
| 8 | Add OpenTelemetry | 1–2 weeks | Step 1 | Yes (with 6, 7) |

### Phase C: Differentiation (When Phase 6 Features Start)

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 9 | Wazero plugin runtime | 4–6 weeks | Step 1 | When ready |

### Total

**14–18 weeks** for Steps 1–8. Step 9 is deferred until plugin features are in scope. Phases overlap, so calendar time is shorter than the sum of estimates.

The central principle: stop building infrastructure, start using infrastructure. Every hour spent maintaining a custom query layer, a custom component model, a custom broadcast loop, or a custom event buffer is an hour not spent on the 146 features that make OwnCord compete with Discord.
