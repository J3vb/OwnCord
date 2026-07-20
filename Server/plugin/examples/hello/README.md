# hello plugin

Phase C Step 9 — proof-of-life plugin used by `Server/plugin/plugin_test.go`.

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
The pre-built `hello.wasm` (925 KiB) is checked in, but you can rebuild it:

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| TinyGo | 0.40.1 | Supports Go 1.19–1.25 only |
| Go | 1.25.x | TinyGo 0.40.1 rejects Go 1.26+ |
| wasm-opt | Binaryen 129 | Required by TinyGo for the `wasi` target |

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

## Tests

`Server/plugin/plugin_test.go` exercises the manifest parser and the loader
against this directory. It does not require the .wasm to be present —
manifest-only validation is the default-build coverage path.
