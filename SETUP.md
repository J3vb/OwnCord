# Developer Setup Guide

What you need to install yourself vs what Claude Code
can handle.

---

## You Install (Claude Code can't do these)

These require GUI installers, admin privileges, or
system-level changes.

### Required

1. **Git** -- <https://git-scm.com/download/win>
   - Default install options are fine.

2. **Go** -- <https://go.dev/dl/>
   - Windows amd64 `.msi` installer.
   - Verify: `go version`

3. **Node.js (LTS)** -- <https://nodejs.org>
   - Required for Tauri frontend build tools.
   - Verify: `node --version` (v20+)

4. **Rust** -- <https://rustup.rs>
   - Required for the Tauri v2 client backend.
   - Install via `rustup-init.exe`.
   - Verify: `rustc --version`

5. **Visual Studio Build Tools 2022** --
   <https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022>
   - Required for Rust compilation on Windows.
   - During install, select:
     - "Desktop development with C++"
   - ~3-5 GB disk space.

### Optional but Recommended

1. **Windows Terminal** -- <https://aka.ms/terminal>
   - Much better than cmd.exe.

2. **VS Code** -- <https://code.visualstudio.com>
   - Install extensions: Go, Rust Analyzer, Tauri.

---

## Claude Code Can Handle These

### Go Dependencies (server)

```bash
go mod init && go get && go mod tidy
```

All Go libraries are installed via `go get`.

### NPM Packages (client)

```bash
cd Client/tauri-client && npm install
```

Vitest, Playwright, TypeScript, Vite, Tauri CLI.

### NSIS (installer builder)

```bash
winget install NSIS.NSIS
```

### Development tools

```bash
# Go tools
go install github.com/air-verse/air@latest
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Playwright browsers
npx playwright install --with-deps
```

---

## Quick Check -- Run These After Installing

```bash
git --version        # Git
go version           # Go
node --version       # Node.js (v20+)
rustc --version      # Rust
cargo --version      # Cargo (comes with Rust)
```

If all five print version numbers, you're ready.

---

## Project Build Commands

### Server (Go)

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w" .
go test ./...
```

### Client (Tauri v2)

```bash
cd Client/tauri-client
npm install                      # first time
npm run tauri dev                # dev mode (hot reload)
npm run tauri build              # release build
npm test                         # run all tests
npm run test:coverage            # coverage report
```

### Legacy WPF Client (reference only, on dev branch)

```bash
cd Client
dotnet build OwnCord.Client/OwnCord.Client.csproj
dotnet test OwnCord.Client.Tests/
```

---

## Summary

| Tool | You Install | Claude Code Installs |
| ---- | :---------: | :------------------: |
| Git | X | |
| Go | X | |
| Node.js | X | |
| Rust | X | |
| VS Build Tools | X | |
| Go libraries | | X |
| NPM packages | | X |
| NSIS | | X (via winget) |
| Linters and dev tools | | X |
| Playwright browsers | | X |
