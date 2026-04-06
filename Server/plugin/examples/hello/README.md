# hello plugin

Phase C Step 9 — proof-of-life plugin used by `Server/plugin/plugin_test.go`.

## Manifest

`plugin.json` declares the `commands`, `events`, and `storage` capabilities.
The manifest is the only file the default (no-`-tags wazero`) build needs —
the registry persists it into the plugins table without executing the .wasm.

## Building the WASM

The .wasm binary is intentionally NOT checked in. Build it locally with TinyGo
or any other WASM toolchain that emits a module exporting `command_dispatch`,
`on_event`, and `_start`:

```sh
# TinyGo example (writes hello.wasm into this directory)
tinygo build -o hello.wasm -target wasi ./main.go
```

A trivial main.go that satisfies the host API is sketched in
`Server/plugin/sandbox_wazero.go`'s docstring.

## Tests

`Server/plugin/plugin_test.go` exercises the manifest parser and the loader
against this directory. It does not require the .wasm to be present —
manifest-only validation is the default-build coverage path.
