# Security-Scan Remediation (Claude Security run 2026-07-22)

**Scan:** `CLAUDE-SECURITY-20260722-184557/` at revision `e983459` (branch `main`).
**Findings:** 8 — 4 MEDIUM (F1–F4), 4 LOW (F5–F8), all confidence `medium`, no HIGH.
**Branch:** `fix/security-scan-2026-07-22`.

This is a continuation/handoff doc: what is done, what remains, and how to resume.

## Status at a glance

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| F1 | MED | Login lockout keyed on un-canonicalized username (vs `COLLATE NOCASE`) | ✅ done, committed `7145f76` |
| F2 | MED | Unsynchronized concurrent wazero module invocation (data race) | ✅ done, committed `71b5f13` |
| F3 | MED | Voice E2EE trusts server-relayed ECDH keys (server MITM) | ⏳ **TODO — designed, not started** |
| F4 | MED | HTTP TOFU proxy accepts any cert on first use (credential exposure) | ✅ done, committed `f22985a` |
| F5 | LOW | Voice perms use stale connect-time role snapshot | ✅ done, committed `260d038` |
| F6 | LOW | Lost cache invalidation in `PermissionService.getOrPopulate` | ✅ done, **uncommitted** (see note) |
| F7 | LOW | ReDoS regex on link-preview HTML | ✅ done, committed `6952202` |
| F8 | LOW | WS TOFU verifier accepts any cert on first use | ✅ done, committed `f22985a` (with F4) |

## Resume checklist (do these first)

1. **Confirm the F4/F8 Rust compiles.** It could not be built in the dev sandbox
   (no local Tauri builds per `Client/tauri-client/CLAUDE.md`). Run
   `cd Client/tauri-client/src-tauri && cargo clippy -- -D warnings` (or push and
   let CI do it). Pure `tofu` logic has `#[cfg(test)]` unit tests; the frontend is
   covered by the 3311-green unit suite.
2. **F6 commit:** F6 lives in `Server/service/permission.go`, entangled with the
   uncommitted permission-consolidation edits. It rides with that work (per
   decision) — commit it when the consolidation branch lands, or cherry-pick.
3. **Then F3** — the only remaining finding (below).

## F6 detail (done, pending commit)

`getOrPopulate` read the DB then cached the snapshot with no version guard, so a
concurrent `InvalidateUser` racing the populate was silently overwritten (stale
perms served up to `permCacheTTL`). Fix: a `gen uint64` counter bumped by every
`Invalidate*`; `getOrPopulate` snapshots `gen` before its DB read and refuses to
cache if it changed. Test `TestGetOrPopulate_InvalidationDuringPopulateNotLost`
locks it. Verified `-race` + `-tags deadlock` green.

## F3 — Voice E2EE identity keys + TOFU (the remaining work)

**Problem.** `voice_e2ee_announce` carries only `{public_key}`; the server
attaches `user_id` on broadcast (`Server/ws/messages.go:136`) and relays/caches
keys — so a malicious server swaps `user_id ↔ ephemeral pubkey` and MITMs the
SFrame room key. Nothing authenticates peer keys; `computeKeyFingerprint`
(`e2eeCrypto.ts:63`) exists but is never used.

**Approach (approved: Signal-style TOFU). Additive** — the existing ephemeral
ECDH + HKDF + AES-GCM wrap is sound; add the missing authentication layer, do
not rewrite the key exchange.

**Trust anchor:** TOFU. Each client holds a long-term identity keypair; peers pin
each other's identity key on first sight and flag any later change. A malicious
server can only MITM at first-ever contact (the accepted TOFU window), and the
optional safety-number makes even that detectable.

### What gets signed
WebCrypto **ECDSA P-256** (same curve family as the existing ECDH; works in all
three webviews — Ed25519 is unreliable on WKWebView/WebKitGTK; zero new deps).
When announcing its ephemeral key `E_pub`, the client signs
`"owncord-voice-e2ee-announce-v1" ‖ myUserId ‖ E_pub_raw` with the identity
private key. Binding `myUserId` stops the server re-attributing a valid announce
to a different user. Receivers verify against the peer's **pinned** identity key.

### Verify + TOFU-pin (receive path)
In `handleE2EEAnnounce` (`livekitSession.ts` ~1195, before the `_peerPublicKeys`
store at ~1198 and the holder's wrap at ~1207), and the queued-drain at ~852-857:
1. Resolve the peer's identity key — first sight → take it from the member
   payload and **pin** it (`identity_pins.json`, key `{host}:{userId}`);
   subsequent → use the pin; delivered key differs → emit `identity-tofu`, block/
   warn until the user re-pins (copy of the TLS cert-mismatch flow).
2. Verify the announce signature against the pinned identity key. Invalid →
   reject (MITM), do not store/wrap.

### Infrastructure (mirror existing patterns)
- **Identity private key → OS keyring:** `save/load/delete_identity_key` Tauri
  commands mirroring `src-tauri/src/credentials.rs` `save_credential`, account
  `identity:{host}`; TS wrapper copies `src/lib/credentials.ts`. Never localStorage.
- **Peer pins → new `identity_pins.json`** `tauri-plugin-store` file +
  `store/get_identity_pin` commands, near-verbatim copy of the `certs.json`
  cert-pin commands in `src-tauri/src/commands.rs`.
- **Safety number:** repoint `computeKeyFingerprint` at the *stable* identity key;
  surface a per-peer/combined safety number in the voice panel (optional OOB verify).

### Server (db-change + protocol-change workflows)
- Migration `Server/migrations/017_user_identity_key.sql`:
  `ALTER TABLE users ADD COLUMN identity_public_key TEXT;` (mirrors `totp_secret`).
  Add `UpdateUserIdentityKey` query; include the column in the user + `ListMembers`
  SELECTs; `make sqlc-generate`. One column, **not** a multi-device table (YAGNI).
- **Publish:** extend the REST profile update (`Server/api/profile_handler.go`
  `updateProfileRequest`) to accept `identity_public_key`; client publishes once
  after first-login keygen.
- **Fetch:** add `identity_public_key` to the member payload in `ready`,
  `member_join`, `user_update` (`Server/ws/messages.go` `memberUserPayload`,
  `buildMemberJoin`, `userUpdatePayload`). Peers pin on first sight — no new WS msg.
- **The one protocol change:** add `signature` to the `voice_e2ee_announce`
  payload — `docs/protocol-schema.json` → `make protocol-generate`. Server
  validates size/base64 like `public_key`, and **stores the signature alongside
  the key in `SetE2EEPubKey`** (`Server/ws/client.go:34`, `voice_e2ee.go`) so the
  replay-to-late-joiners path (`voice_join.go:217-218`) doesn't drop it.

### Client session (`livekitSession.ts`)
Sign the ephemeral announce at all three sites (~916, ~467, ~891); verify+pin on
receive as above. Move the primary announce earlier (~876) so the added identity
round-trip doesn't stack on the existing 10s non-holder stall.

### Compatibility posture (transition)
Peer has published an identity key but the announce signature is missing/invalid
→ **fail closed** (reject). Peer has no identity key at all (legacy client) →
accept but mark **unverified** in the UI, pin-pending. Avoids a hard cutover for
alpha while closing the hole for upgraded clients.

### Suggested PR split
- **PR-a (server):** identity-key column + publish/fetch + `voice_e2ee_announce`
  signature field + `SetE2EEPubKey` carries the signature.
- **PR-b (client):** keygen + keyring commands, sign/verify, TOFU pin store,
  safety-number UI, receive-path verification.

### Verification (planned)
- vitest for `signEphemeralKey`/`verifyEphemeralKeySignature` and the TOFU pin
  (first-sight pins, changed key flags, invalid signature rejects); a "server
  substitutes a peer's ephemeral key → verify fails" test; keyring round-trip
  (Rust); manual two-client voice call confirming audio decrypts and safety
  numbers match; `make protocol-verify` + `make sqlc-verify`; full server
  `-race`/`-tags deadlock`; client `npm test` + typecheck/lint/format; `ci-check`.

## Notes carried from the build
- F4/F8 approach was simplified vs the original design: instead of a new
  `check_server_cert` peek command, first-use is handled by **reject-and-retry**
  — the proxy captures the fingerprint, rejects (ws `Err` / http `502`), and emits
  `cert-tofu{first_use}`; the connect page's existing `getHealth` is the natural
  pre-flight. A global `cert-tofu` listener (`ws.startCertListener`, registered at
  bootstrap in `main.ts`) surfaces the confirm modal before any WS connect.
- The scan report + machine-readable companion are in
  `CLAUDE-SECURITY-20260722-184557/`.
