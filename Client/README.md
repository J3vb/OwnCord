# OwnCord Client

The OwnCord desktop app. It uses Tauri v2: a TypeScript frontend built with
Vite (plain TypeScript, no React or Vue) and a deliberately thin Rust backend
in `src-tauri/`. The Rust side only does what a web page cannot, such as
native voice on Linux, the system tray, credential storage and update installs. Voice
and video go through LiveKit.

For the detail agents and maintainers need (rules, gotchas), read
[CLAUDE.md](CLAUDE.md). For the full command list, read
[docs/contributing.md](../docs/contributing.md#client-tauri-v2).

For a task-to-code map across the server, client, native code and admin panel,
start with [Starting a change](../docs/contributing.md#starting-a-change).

## Folder map

| Folder                   | What is in it                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `src/main.ts`            | Frontend entry point.                                                                   |
| `src/stores/`            | Observable state stores. Server events reach them only through `src/lib/dispatcher.ts`. |
| `src/lib/`               | Protocol, WebSocket, voice and E2EE modules. `protocolTypes.ts` is generated.           |
| `src/pages/`             | Top-level pages (connect page, main page).                                              |
| `src/components/`        | UI components.                                                                          |
| `src/features/`          | Feature modules, such as voice, messaging, moderation and navigation.                   |
| `src/platform/`          | The desktop/browser seam. Only `platform/desktop/` may import `@tauri-apps`.            |
| `src/i18n/`              | English text catalogs. New UI text goes here.                                           |
| `src/styles/`            | CSS. `app.css` imports the fragments in `app/`; the import order matters.               |
| `src/assets/`, `public/` | Static assets.                                                                          |
| `src-tauri/`             | Rust backend, Tauri config (`tauri.conf.json`), icons and installer packaging.          |
| `tests/unit/`            | Vitest unit tests (jsdom). Some unit tests sit next to the code in `src/`.              |
| `tests/integration/`     | Vitest integration tests.                                                               |
| `tests/contract/`        | Tests that read or run `Server/`-owned files, such as the admin panel.                  |
| `tests/browser/`         | Vitest browser-mode tests.                                                              |
| `tests/e2e/`             | Playwright end-to-end tests, including `admin/` and `native/`.                          |
| `scripts/`               | Build and check scripts: bundle budget, mutation shards, Linux toolchain.               |
| `patches/`               | `patch-package` patches applied on `npm install`.                                       |

`src/lib/protocolTypes.ts` is generated from `protocol/schema.json`. Do not
edit it by hand. Use the `protocol-change` skill.

## Run it

You need Node 26 and npm 11 (see `.nvmrc`). Rust is needed for the Tauri app.
From this folder:

```bash
npm ci
npm run dev           # Vite dev server (alias for dev:desktop)
npm run tauri dev     # launch the Tauri app in dev mode
npm run build         # type check and production build
npm run tauri build   # release installer
```

**Linux Rust builds need a toolchain first.** The Linux client links LiveKit's
Rust SDK, which needs clang 21 or newer and a prebuilt libwebrtc. Run this in
each shell before `npm run tauri dev`, `cargo test`, `cargo clippy` or `tauri build`:

```bash
eval "$(Client/scripts/linux-webrtc-toolchain.sh)"
```

Run it from the repository root, or adjust the path. A Linux build also needs
the GStreamer headers. Both are explained in
[docs/contributing.md](../docs/contributing.md#client-tauri-v2). Windows builds
and frontend-only work need none of this.

## Test it

From this folder:

```bash
npm test                 # all vitest tests (unit, integration, contract)
npm run test:unit        # unit tests only
npm run test:e2e         # Playwright, mocked Tauri
npm run typecheck        # TypeScript
npm run lint             # oxlint, import cycles, ESLint
```

Formatting is done once at the repository root with `npm run format`. To run
the main client CI checks from the root, use `npm run check:client`. For the
Rust side, use `npm run check:rust`.
