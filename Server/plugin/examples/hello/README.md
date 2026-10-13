# hello plugin

This folder is a worked example of an OwnCord plugin. It shows the plugin ABI
(the functions a plugin must export) and the manifest the loader reads. It is
source only: the `.wasm` is not checked in.

> **The plugin ABI is experimental and has no compatibility promise.** The
> plugin system is off in two ways. It compiles only under `-tags wazero`
> (`Server/plugin/sandbox_default.go`). And `plugins.enabled` defaults to
> `false` (`Server/config/config.go`). The five exported functions may change
> or disappear in any release, with no deprecation period.

## Manifest

`plugin.json` lists the `commands`, `events` and `storage` capabilities under
`permissions`.

- The manifest is the only file the default build (without `-tags wazero`)
  needs. The registry saves it into the plugins table without running the
  `.wasm`.
- The `commands` block is the per-command access list. Activation binds only
  the names listed there, so any other name that `list_commands` returns is
  ignored.
- Keep the list in `plugin.json` and `listCommandsJSON` in `main.go` in sync. A
  name in the WASM but not in the manifest never binds.

## Building the WASM

`main.go` in this folder implements the full plugin ABI: `allocate`,
`deallocate`, `list_commands`, `command_dispatch` and `on_event`. Build it
before you point a plugin directory at this example. `hello.wasm` is
gitignored. You build it locally; it is not distributed.

### Prerequisites

This table is the single source of truth for the plugin toolchain.
`docs/contributing.md` links here rather than repeating it.

| Tool     | Version      | Notes                                                                                                                              |
| -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| TinyGo   | 0.40.1       | Supports Go 1.19–1.25 only                                                                                                         |
| Go       | 1.25.x       | TinyGo 0.40.1 rejects Go 1.26+. Install it next to your normal Go: `go install golang.org/dl/go1.25.3@latest && go1.25.3 download` |
| wasm-opt | Binaryen 129 | TinyGo needs it for the `wasi` target. Download it from Binaryen's GitHub releases                                                 |

Note the Go row. This repository's own module is pinned to Go 1.27
(`Server/go.mod`). So building a plugin needs a _second_, older Go SDK
installed alongside. That conflict is why there is no CI job for this (see
[Provenance](#provenance)).

On Windows:

1. Extract TinyGo somewhere, for example `C:\tools\tinygo`.
2. Add `<tinygo>\bin` and `<binaryen>\bin` to `PATH`.
3. Point TinyGo at the compatible Go SDK:

   ```pwsh
   $env:GOROOT = "$env:USERPROFILE\sdk\go1.25.3"   # installed via: go install golang.org/dl/go1.25.3@latest
   $env:PATH   = "$env:GOROOT\bin;$env:PATH"
   ```

### Build command

```sh
# Run from this folder (Server/plugin/examples/hello/)
tinygo build -o hello.wasm -target wasi ./main.go
```

Any WASM toolchain that exports the five ABI functions works just as well, for
example Rust with `wasm32-wasi`, or AssemblyScript. TinyGo is simply the one
this example uses.

## Provenance

The `.wasm` that used to be committed here was built with **TinyGo 0.40.1, Go
1.25.3 and Binaryen 129**, on Windows. It has since been removed.

It is **not byte-reproducible**, and that is why no CI job compiles and
compares it. TinyGo writes absolute paths from the build machine's Go SDK and
module cache into its output, and it has no `-trimpath` option. Two machines
building the same source produce different bytes. So a byte-for-byte check
cannot pass, even in principle. The requirement asks for the example WASM to
be _reproducible or provenance-verified_, and this section is the
provenance record.

A compile-only drift check would still be possible. But it needs three pinned
downloads (TinyGo, a second Go SDK, Binaryen) on every PR, for a subsystem
that is off at compile time _and_ at runtime. That work is deferred to a later
phase.

## Tests

Nothing in the Go build or test graph reads this folder. `main.go` has
`//go:build tinygo`, so `go list ./plugin/...` returns one package, with or
without `-tags wazero`, and `examples/hello` is not in it.

The plugin tests build their own fixtures instead:

- `plugin_test.go` writes manifests and stub bytes into `t.TempDir()`.
- `sandbox_wazero_test.go` uses a 41-byte inline WASM literal, with the comment
  _"Using a literal here avoids dragging a binary asset into the repo."_

The test suite had already made that choice, and the example now follows it.

Background: this example dates from roadmap Phase C Step 9. The `.wasm` was
removed in B1-6 (RL-08). The provenance requirement is BPR-080, and the
deferred compile check is the second phase of issue-register item L-08,
assigned to B2.
