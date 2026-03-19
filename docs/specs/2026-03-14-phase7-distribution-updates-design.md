# Phase 7: Distribution & Updates — Design Spec

## Overview

Add CI/CD pipelines, auto-update for both server and client, and project documentation. Installer deferred to a later phase.

## 1. GitHub Actions CI

### `ci.yml` — Continuous Integration

**Triggers:** push/PR to `main` and `feature/*` branches.

**Jobs:**

- **server-build-test:** (runs on `windows-latest`)
  - `actions/checkout@v4`
  - `actions/setup-go@v5` (Go 1.25)
  - `go build -o chatserver.exe -ldflags "-s -w" .`
  - `go test ./... -cover`
  - `golangci-lint run ./...` via `golangci/golangci-lint-action`

- **client-build-test:** (runs on `windows-latest`)
  - `actions/checkout@v4`
  - `actions/setup-dotnet@v4` (.NET 8)
  - `dotnet build Client/OwnCord.Client.sln`
  - `dotnet test Client/OwnCord.Client.Tests/`

### `release.yml` — Release Pipeline

**Trigger:** push tag matching `v*` (e.g. `v1.0.0`).

**Steps:**

1. Checkout code
2. Extract version from tag (strip `v` prefix)
3. Build server: `go build -o chatserver.exe -ldflags "-s -w -X main.version=$VERSION" .`
4. Build client as single-file: `dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/client`
5. Generate SHA256 checksums for all binaries
6. Create GitHub Release via `gh release create` with `--generate-notes`
7. Attach binaries and checksum file to the release

**Artifacts:**
- `chatserver.exe` — server binary (~13MB)
- `OwnCord.Client.exe` — single-file self-contained client
- `checksums.sha256` — SHA256 hashes for integrity verification

## 2. Server Auto-Update

### Version Accessibility

Create a shared `version` package or pass the version string to `admin.NewAdminAPI` as a parameter. The `main.version` variable (set via ldflags) is passed down at startup:

```
main.go → admin.NewAdminAPI(database, versionString) → update handler uses it for comparison
```

### Semver Comparison

Use `golang.org/x/mod/semver` for version comparison. All tags must follow `vMAJOR.MINOR.PATCH` format.

### API Endpoints

**`GET /admin/api/updates`** (admin-only)
- Server-side HTTP call to `https://api.github.com/repos/J3vb/OwnCord/releases/latest`
- Parses latest tag, compares against running version using `semver.Compare`
- Caches result for 1 hour (in-memory, reset on restart)
- Optional `github_token` in config.yaml for authenticated requests (5,000 req/hr vs 60 unauthenticated)
- Response: `{ "current": "1.0.0", "latest": "1.2.0", "update_available": true, "release_url": "...", "download_url": "...", "release_notes": "..." }`

**`POST /admin/api/updates/apply`** (owner-only, Bearer token auth — not cookie-based, so no CSRF risk)
- Validates download URL matches `https://github.com/J3vb/OwnCord/releases/download/...` pattern before downloading
- Downloads `chatserver.exe` from the GitHub Release to `chatserver.exe.new`
- Verifies SHA256 checksum against `checksums.sha256` from the release
- Broadcasts `server_restart` WebSocket message to all connected clients (see below)
- Waits 5 seconds for clients to prepare
- Renames: `chatserver.exe` → `chatserver.exe.old`, `chatserver.exe.new` → `chatserver.exe`
- Spawns new process detached from parent (`os.StartProcess` with `syscall.SysProcAttr{CreationFlags: DETACHED_PROCESS}`)
- Exits current process via graceful shutdown

**On startup:**
- New process retries port binding for up to 10 seconds (old process may still be releasing)
- Verifies it can open the database and bind the port successfully before deleting `chatserver.exe.old`
- If startup fails, `chatserver.exe.old` remains for manual rollback

### WebSocket Restart Notification

Add to PROTOCOL.md:
```json
{ "type": "server_restart", "payload": { "reason": "update", "delay_seconds": 5 } }
```
Clients display "Server restarting for update..." and auto-reconnect after the delay.

### Admin Panel UI

- Dashboard banner: "Update available: v1.2.0 — [Apply Update]" when `update_available` is true
- Confirmation dialog before applying: "This will restart the server. All connected users will be briefly disconnected."
- Status feedback during download/apply

### Security Considerations

- **Download URL validation:** Only accept URLs matching `https://github.com/J3vb/OwnCord/releases/download/...`
- **Integrity:** SHA256 checksum verification (authenticity via code signing deferred — documented as known limitation)
- **Authorization:** Only server owner can apply updates
- **No CSRF risk:** Endpoint uses Bearer token auth, not cookies

## 3. Client Auto-Update

### Single-File Distribution

Client is published with `-p:PublishSingleFile=true` so the entire app is one `.exe`. This enables the same rename-swap pattern as the server.

### Update Check Flow

1. On launch, client makes HTTP GET to `https://api.github.com/repos/J3vb/OwnCord/releases/latest`
2. Caches result — checks at most once per 24 hours (stored in local app data)
3. Compares local assembly version against latest tag
4. If newer version exists and not in "skipped" list, shows update dialog

### Update Dialog

- Shows current version, new version, and release notes (from GitHub Release body)
- Three buttons: **Update Now**, **Skip This Version**, **Remind Me Later**
- "Skip This Version" persists the skipped version in local settings
- "Remind Me Later" dismisses until next launch (but respects 24h cache)

### Update Apply Flow

1. Validate download URL matches `https://github.com/J3vb/OwnCord/releases/download/...`
2. Download new `OwnCord.Client.exe` from GitHub Release to temp location
3. Verify SHA256 checksum
4. Rename current exe to `.old`, move new to current path
5. Restart application
6. On startup, delete `.old` if present

### Installation Location

Client runs from a user-writable location (`%LOCALAPPDATA%\OwnCord`) to avoid UAC elevation requirements for self-update. When the installer is added later, it will use this path by default.

### Version Storage

- Client version embedded at build time (assembly version from `.csproj`)
- Skipped version and last-check timestamp stored in `%LOCALAPPDATA%\OwnCord\settings.json`

## 4. Documentation

### `README.md` (project root)

- Project name and one-line description
- Feature highlights (real-time chat, voice, admin panel, self-hosted)
- Quick start: build server, build client, connect
- Architecture overview (server + client diagram)
- Link to detailed docs
- License

### `SECURITY.md` (project root)

- How to report vulnerabilities (GitHub Security Advisories)
- Response timeline commitment
- Known limitations: no code signing yet (SHA256 integrity only)
- Security hardening checklist for operators:
  - Enable TLS (self-signed minimum)
  - Use invite-only registration
  - Set strong admin password
  - Configure rate limits
  - Regular backups
  - Keep server updated
  - Firewall: only expose needed ports

### `CONTRIBUTING.md` (project root)

- Development setup (Go 1.25, .NET 8, tools)
- Branch naming: `feature/`, `fix/`, `docs/`
- Commit format: conventional commits
- PR process: branch from main, CI must pass, code review
- Test requirements: 80%+ coverage, TDD workflow

### `docs/quick-start.md`

- Download latest release from GitHub
- Run server, first-run config generation
- Access admin panel, create invite
- Install client, connect with invite

### `docs/port-forwarding.md`

- Why it's needed (friends outside your LAN)
- Find your router admin page
- Forward TCP port (default 8443) to server machine
- Find your public IP
- Test the connection

### `docs/tailscale.md`

- What Tailscale is and why it's simpler than port forwarding
- Install Tailscale on server and client machines
- Connect using Tailscale IP
- Set TLS mode to "off" (Tailscale encrypts the tunnel)
- Benefits: no port forwarding, no dynamic DNS, works behind CGNAT

## 5. API.md Updates

Update API.md to add the update endpoints under the admin section, matching the existing `/admin/api/*` routing pattern.

## 6. PROTOCOL.md Updates

Add `server_restart` message type for pre-restart notification.

## 7. Out of Scope (Deferred)

- NSIS/WiX installer — will be added in a follow-up
- `chatserver://` protocol handler registration
- Windows Service mode (`--service install`)
- Code signing (documented as known limitation in SECURITY.md)
- Auto-start registry key
- GPG signing of release checksums (mitigates GitHub account compromise — add when code signing is implemented)
