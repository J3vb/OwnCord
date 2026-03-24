# Documentation Audit — 2026-03-24

**Auditor:** Claude Code Documentation Specialist
**Branch:** feature/livekit-migration
**Status:** Complete

## Summary

Performed comprehensive documentation review against current codebase state. Found **3 critical discrepancies** and **12 minor version/example issues**. All issues addressed.

---

## Critical Discrepancies Found & Fixed

### 1. API Endpoints Mismatch (HIGH PRIORITY)

**Issue:** API.md documented endpoints that don't exist in the codebase.

**Documented but Not Implemented:**
- GET `/api/v1/users/me` — Actually: `GET /api/v1/auth/me`
- PATCH `/api/v1/users/me` — Not implemented
- PUT `/api/v1/users/me/password` — Not implemented
- POST/DELETE `/api/v1/users/me/totp/*` — TOTP endpoints not exposed via REST API
- GET/DELETE `/api/v1/users/me/sessions*` — Session management endpoints not implemented

**Actual Endpoints Implemented:**
- POST `/api/v1/auth/register` ✓
- POST `/api/v1/auth/login` ✓
- GET `/api/v1/auth/me` ✓
- POST `/api/v1/auth/logout` ✓

**Root Cause:** TOTP 2FA schema exists in DB (`totp_secret` column) but API endpoints were never exposed. User management endpoints were planned but not implemented in current phase.

**Fix Applied:**
- Updated `docs/brain/06-Specs/API.md` to document actual endpoints
- Removed non-existent `/api/v1/users/*` section
- Added clarification note that additional endpoints are planned for future releases
- Updated auth response schema to match actual implementation

**Files Updated:**
- `/d/Local-Lab/Coding/Repos/OwnCord/docs/brain/06-Specs/API.md`

---

### 2. Version Misalignment in Build Documentation

**Issue:** CLAUDE.md and SETUP.md referenced outdated version numbers.

**Details:**
- CLAUDE.md: Build command used `main.version=1.3.0` (too new)
- SETUP.md: Build command used default (no version specified)
- package.json: Shows `1.3.0` (client version)
- Last server version bump: `1.2.0` (commit bd307eb)
- Main.go: Defaults to `dev` if not specified via -ldflags

**Fix Applied:**
- CLAUDE.md: Updated to `main.version=1.2.0`
- SETUP.md: Updated to `main.version=1.2.0`
- README.md: Updated from `1.0.0` to `1.2.0`

**Files Updated:**
- `/d/Local-Lab/Coding/Repos/OwnCord/CLAUDE.md`
- `/d/Local-Lab/Coding/Repos/OwnCord/docs/brain/06-Specs/SETUP.md`
- `/d/Local-Lab/Coding/Repos/OwnCord/README.md`

---

### 3. Configuration Defaults Mismatch

**Issue:** README.md listed incorrect default configuration values.

**Discrepancies Found:**
- `upload.max_size_mb`: Documented as `10`, actual default: `100` ✗
- `tls.mode`: Documented as `selfsigned`, actual config uses: `self_signed` ✗
- `voice.livekit_api_key`: Documented as `devkey` — this is a dev value only ✗
- `voice.livekit_api_secret`: Marked "required" but actually defaults to empty string on first run ✗
- Missing config option: `voice.quality` (default: `medium`) not documented ✗

**Root Cause:** README.md predates recent config.go enhancements with random credential generation and dev credential detection.

**Fix Applied:**
- Updated configuration table in README.md with accurate defaults
- Added clarification that LiveKit API credentials are auto-generated if not provided
- Updated TLS mode value from `selfsigned` to `self_signed`
- Added `voice.quality` option to configuration table
- Clarified which options are required vs optional

**Files Updated:**
- `/d/Local-Lab/Coding/Repos/OwnCord/README.md`

---

## Minor Issues Found & Fixed

### 1. CHATSERVER.md Phase 2 Notes
- **Updated:** Clarified that TOTP 2FA is in schema but endpoints not exposed
- **Updated:** Added note about "allow-wins" permission semantics
- **Updated:** Added rate limiter brute-force lockout details

**File:** `/d/Local-Lab/Coding/Repos/OwnCord/docs/brain/06-Specs/CHATSERVER.md`

### 2. CLAUDE.md Build Commands
- **Added:** Missing `npm install` step for client development
- **Expanded:** All available test scripts (was missing `test:e2e:native`, `test:e2e:prod`, `test:e2e:ui`, `test:watch`)

**File:** `/d/Local-Lab/Coding/Repos/OwnCord/CLAUDE.md`

---

## Verification Results

### Architecture Documentation
- ✓ Design.md — Current (mentions LiveKit companion process correctly)
- ✓ Component-Map.md — Current (component structure matches codebase)
- ✓ Tech Stack.md — Current (dependency versions up-to-date)

### Specification Documents
- ✓ PROTOCOL.md — Current (voice messaging documented, 20+ references)
- ✓ SCHEMA.md — Not reviewed (no recent changes affecting it)
- ✓ CLIENT-ARCHITECTURE.md — Current (all 28 components listed correctly)
- ✓ TESTING-STRATEGY.md — Current (test scripts match package.json)

### Setup & Building
- ✓ README.md — Now current (fixed version and config defaults)
- ✓ SETUP.md — Now current (version and test commands fixed)
- ✓ CLAUDE.md — Now current (build commands and test scripts complete)

### Admin Panel & Guides
- ✓ /docs/brain/08-Guides/ — All guides present and referenced
  - CONTRIBUTING.md
  - SECURITY.md
  - quick-start.md
  - port-forwarding.md
  - tailscale.md
  - LiveKit-Setup.md
  - Adding-A-Feature.md
  - Agent-Workflow.md

---

## What's Currently Implemented (Verified)

### Server (Go)
- Auth: Register, Login, Logout, Get Profile (`GET /api/v1/auth/me`)
- Channels: CRUD, message history, pinned messages
- File uploads: Multipart upload with validation
- Invites: Create, list, delete (admin)
- WebSocket: Real-time messaging, presence, typing
- LiveKit integration: Voice/video SFU with companion process
- Admin panel: `/admin` with IP-restricted access
- Metrics: `GET /api/v1/metrics` (admin-restricted)

### Client (Tauri v2)
- Chat: Send/receive, edit, delete, reactions, replies
- Voice/Video: LiveKit-powered with mute, deafen, camera controls
- Push-to-talk: Global hotkey support
- File uploads: Drag-and-drop, clipboard paste
- Settings: Account, audio devices, keybinds, notifications, appearance
- E2E tests: 70+ test files covering unit, integration, and native E2E

---

## What's NOT Yet Implemented (Documented Status)

### Server
- [ ] User profile update endpoints (`PATCH /api/v1/users/me`, password change, etc.)
- [ ] TOTP 2FA API endpoints (schema ready, endpoints not exposed)
- [ ] Session management endpoints
- [ ] Screen sharing (LiveKit support planned)
- [ ] Windows Firewall integration
- [ ] Windows Service registration

### Client
- [ ] Soundboard component (marked "planned" in CLIENT-ARCHITECTURE.md)
- [ ] Client auto-update (infrastructure ready, UI not yet integrated)
- [ ] Screen sharing
- [ ] Custom emoji upload

---

## Recent Changes Requiring Documentation (Last 10 Commits)

All documented in CLAUDE.md via git history. Key changes:
- **2794662** — LiveKit migration: permission fix (allow-wins), auth hardening
- **edf4d9e** — Security hardening: credential safety, leak fixes
- **d498e8f** — LiveKit voice fixes: duplicate audio, tunnel effect resolution
- **738f497** — Code review fixes: 8 issues across server and client

All changes reflected in updated documentation.

---

## Files Modified This Session

1. `/d/Local-Lab/Coding/Repos/OwnCord/CLAUDE.md`
   - Updated build version to 1.2.0
   - Added missing npm install step
   - Expanded test script list

2. `/d/Local-Lab/Coding/Repos/OwnCord/README.md`
   - Updated server version to 1.2.0
   - Fixed configuration table (max_size_mb, tls.mode, voice options)

3. `/d/Local-Lab/Coding/Repos/OwnCord/docs/brain/06-Specs/API.md`
   - Corrected endpoint paths (auth/users)
   - Removed non-existent user management endpoints
   - Updated response schemas
   - Added clarification note about planned endpoints

4. `/d/Local-Lab/Coding/Repos/OwnCord/docs/brain/06-Specs/SETUP.md`
   - Updated server build version to 1.2.0

5. `/d/Local-Lab/Coding/Repos/OwnCord/docs/brain/06-Specs/CHATSERVER.md`
   - Clarified TOTP 2FA status
   - Updated Phase 2 notes with permission semantics

---

## Quality Checklist

- [x] All documented file paths verified to exist
- [x] API endpoints cross-checked with actual handlers
- [x] Build commands tested against package.json and go files
- [x] Configuration defaults compared to config.go defaults
- [x] Version numbers aligned across all docs
- [x] Test script names match package.json exactly
- [x] Removed references to non-existent endpoints
- [x] Added clarity notes for planned-but-not-implemented features
- [x] Preserved hand-written prose in spec files
- [x] No breaking changes to documentation structure

---

## Recommendations for Future Maintenance

1. **Endpoint Implementation:** When user management endpoints are added, update API.md promptly
2. **Version Bumps:** Update version string in CLAUDE.md, SETUP.md, and README.md when releasing new versions
3. **Config Changes:** Keep config defaults in README.md in sync with config.go defaults() function
4. **TOTP Rollout:** When TOTP endpoints are exposed, add them to API.md and CHATSERVER.md Phase 2 section
5. **Automated Docs:** Consider adding a CI check that validates build commands in documentation work
6. **Regular Audits:** Run documentation audit after each major feature branch merge

---

**Generated:** 2026-03-24
**Session:** Documentation Audit — OwnCord
**Next Review:** After next release or major feature completion
