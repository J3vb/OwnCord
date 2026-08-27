# hello plugin

Phase C Step 9 — a worked reference implementation of the plugin ABI, and the
manifest the loader parses. Source only: the `.wasm` is not checked in.

> **The plugin ABI is experimental and carries no compatibility promise.** The
> subsystem is disabled twice over — it compiles only under `-tags wazero`
> (`Server/plugin/sandbox_default.go`), and `plugins.enabled` defaults to
> `false` (`Server/config/config.go`) — and the five exported functions may
> change or be removed in any release without a deprecation period.

## Manifest

`plugin.json` declares the `commands`, `events`, and `storage` capabilities.
The manifest is the only file the default (no-`-tags wazero`) build needs —
the registry persists it into the plugins table without executing the .wasm.

The `commands` block is the per-command ACL: activation binds only the names
listed there, so `list_commands` returning anything else is ignored. Keep
`plugin.json`'s list and `listCommandsJSON` in `main.go` in sync — a name in
the WASM but not the manifest simply never binds.

## Building the WASM

`main.go` in this directory implements the full plugin ABI
(`allocate`, `deallocate`, `list_commands`, `command_dispatch`, `on_event`).
Build it before pointing a plugin directory at this example — `hello.wasm` is
gitignored and produced locally, not distributed.

### Prerequisites

This table is the single source of truth for the plugin toolchain;
`docs/contributing.md` links here rather than repeating it.

| Tool     | Version      | Notes                                                                                                                            |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| TinyGo   | 0.40.1       | Supports Go 1.19–1.25 only                                                                                                       |
| Go       | 1.25.x       | TinyGo 0.40.1 rejects Go 1.26+. Install alongside the system Go: `go install golang.org/dl/go1.25.3@latest && go1.25.3 download` |
| wasm-opt | Binaryen 129 | Required by TinyGo for the `wasi` target; download from Binaryen GitHub releases                                                 |

Note the Go row: this repository's own module is pinned to Go 1.26
(`Server/go.mod`), so building a plugin needs a _second_, older Go SDK
side-installed. That conflict is why there is no CI job for this — see
Provenance.

On Windows, extract TinyGo to e.g. `D:\Local-Lab\Coding\Software\tinygo` and
add `<tinygo>\bin` plus `<binaryen>\bin` to `PATH`. Then point TinyGo at the
compatible Go SDK:

```pwsh
$env:GOROOT = "$env:USERPROFILE\sdk\go1.25.3"   # installed via: go install golang.org/dl/go1.25.3@latest
$env:PATH   = "$env:GOROOT\bin;$env:PATH"
```

### Build command

```sh
# Run from this directory (Server/plugin/examples/hello/)
tinygo build -o hello.wasm -target wasi ./main.go
```

Any WASM toolchain (Rust/`wasm32-wasi`, AssemblyScript, …) that exports the five
ABI functions is equally valid. TinyGo is just the toolchain this example uses.

## Provenance

The `.wasm` that used to be committed here was produced by **TinyGo 0.40.1 with
Go 1.25.3 and Binaryen 129**, on Windows. It was removed in B1-6 (RL-08).

It is **not byte-reproducible**, and that is why no CI job compiles and compares
it: TinyGo embeds absolute host paths from the building machine's Go SDK and
module cache into its output, and offers no `-trimpath` equivalent. Two
machines building the same source produce different bytes, so a byte-identity
gate cannot pass in principle — not merely "is unbuilt". BPR-080 asks that the
example WASM be _reproducible or provenance-verified_; this section is the
second branch.

A compile-only drift check would still be possible, but it needs three pinned
downloads (TinyGo, a second Go SDK, Binaryen) on every PR for a subsystem that
is disabled at compile time _and_ at runtime. That is deferred to B2, which the
issue register already names as L-08's second phase.

## Tests

Nothing in the Go build or test graph reads this directory. `main.go` carries
`//go:build tinygo`, so `go list ./plugin/...` returns one package with and
without `-tags wazero`, and `examples/hello` is not in it.

The plugin tests build their own fixtures instead: `plugin_test.go` writes
manifests and stub bytes into `t.TempDir()`, and `sandbox_wazero_test.go` uses a
41-byte inline WASM literal — with the comment _"Using a literal here avoids
dragging a binary asset into the repo."_ That call was already made for the test
suite; RL-08 extends it to the example.
