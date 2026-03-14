# Developer Setup Guide

What you need to install yourself vs what Claude Code can handle.

---

## You Install (Claude Code can't do these)

These require GUI installers, admin privileges, or system-level changes.

### Required

1. **Git** — https://git-scm.com/download/win
   - Claude Code needs this to manage the project. Just use the default install options.

2. **Go** — https://go.dev/dl/
   - Download the Windows amd64 `.msi` installer. Default install path is fine.
   - After install, open a new terminal and verify: `go version`

3. **Node.js (LTS)** — https://nodejs.org
   - Claude Code itself runs on Node. You likely already have this if you're using Claude Code.
   - Verify: `node --version`

4. **Visual Studio Build Tools** (probably needed for the client)
   - If Claude Code picks C++ (Qt), C# (WPF/.NET), or Rust — it will need a compiler.
   - Install **Visual Studio Build Tools 2022**: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
   - During install, select:
     - "Desktop development with C++" (covers C++ and Rust)
     - ".NET desktop development" (covers C#/WPF)
   - Selecting both covers all possible client language choices (~5-8 GB disk space).
   - If Claude Code picks a language that doesn't need this, skip it — Claude Code will tell you what's missing.

### Depends on Client Language (install if Claude Code asks)

- **Qt 6** — If C++ is chosen. Online installer: https://www.qt.io/download-qt-installer
  - Select: Qt 6.x for MSVC, Qt WebSockets, Qt Multimedia modules.
  - Set `QT_DIR` environment variable to install path.

- **.NET 8 SDK** — If C#/WPF is chosen. https://dotnet.microsoft.com/download/dotnet/8.0
  - Verify: `dotnet --version`

- **Rust** — If Rust is chosen. https://rustup.rs
  - Verify: `rustc --version`

### Optional but Recommended

5. **Windows Terminal** — https://aka.ms/terminal
   - Much better than cmd.exe for running Claude Code. Get it from the Microsoft Store.

6. **VS Code** — https://code.visualstudio.com
   - For browsing the code Claude Code generates. Install the Go extension.

---

## Claude Code Can Handle These

Claude Code can install and configure all of the following via the terminal:

### Go Dependencies (server)
```
go mod init, go get, go mod tidy
```
All Go libraries (chi, pion, sqlite, bcrypt, etc.) are installed automatically when Claude Code runs `go get`. No manual action needed.

### NPM Packages (if any JS tooling is needed for admin panel)
```
npm install
```

### NSIS (installer builder)
Claude Code can download and install NSIS via:
```
winget install NSIS.NSIS
```
Or use `choco install nsis` if Chocolatey is installed.

### Development tools
- `golangci-lint` (Go linter) — Claude Code can install via `go install`
- `air` (Go hot-reload) — Claude Code can install via `go install`
- `sqlc` (SQL code generator) — Claude Code can install via `go install`

---

## Quick Check — Run These After Installing

Open a terminal and verify everything works:

```
git --version
go version
node --version
```

If all three print version numbers, you're ready. Start Claude Code in your project folder and tell it:

```
@CLAUDE.md Start phase 1 — set up the server project structure and build a hello world that compiles to chatserver.exe
```

Claude Code will read CLAUDE.md, pull in the other spec files, and start building. If it needs something you haven't installed (like Qt or .NET SDK based on the client language it picks), it will tell you.

---

## Summary

| Tool | You Install | Claude Code Installs |
|------|:-----------:|:-------------------:|
| Git | ✅ | |
| Go | ✅ | |
| Node.js | ✅ | |
| VS Build Tools | ✅ | |
| Qt / .NET SDK / Rust | ✅ (when asked) | |
| Go libraries | | ✅ |
| NSIS | | ✅ (via winget) |
| Linters & dev tools | | ✅ |
| NPM packages | | ✅ |
