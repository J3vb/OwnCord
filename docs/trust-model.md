# Trust model — who can read what

**Kind:** reference. **Verified against:** `dev` @ `2b2d58ab`, 2026-08-29.
**Satisfies:** BPR-050, BPR-051 (plain disclosure of the operator trust
model); the C-09 contract for B7; the absence proofs for BPR-040/082/083.

Every claim below points at the code line or the test that makes it true, in
`path:line` form or by test name. If a claim and the code disagree, the code
is right and this document has a bug — file it like any other.

## The short answer

**Who can read my messages?**

- **You and everyone in the channel or DM** — that is what a chat server is
  for.
- **The person who runs the server** (the _operator_) can read every text
  message, every file, and every name and timestamp. Text and files are stored
  on the server in plain form so it can deliver, search, moderate and back
  them up. Nothing about OwnCord hides stored text or files from the machine
  they are stored on.
- **Moderators** can read and delete messages in the channels their role
  allows.
- **Nobody in between** — not your network, not a reverse proxy the operator
  did not set up — because the connection is TLS.
- **Voice, video and screen share are different**: they are end-to-end
  encrypted between the people in the call. The server passes the encrypted
  media along and never has the key. The operator cannot listen in.

If the operator is someone you trust with your words, OwnCord is built to keep
everyone else out. If you do not trust the operator, do not type there.
OwnCord is one server run by one person or group; there is no company behind
it that can see your data.

## What the server can read, and why

The server sees text and files in the clear. Each reason maps to a feature that
would not work otherwise.

| Data                       | Stored as                                                                                                                                           | Why the server needs it in the clear                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Channel messages           | plain `content` column — `Server/migrations/001_initial_schema.sql:76`; written by `Server/db/queries/sqlite/messages.sql:2`                        | **Delivery** to members who were offline (replay), **edit** history, **search**                                                |
| Direct messages            | the same table — a DM is a `channels` row of type `dm` (`Server/migrations/009_dm_tables.sql:6`, body read at `Server/db/queries/sqlite/dm.sql:50`) | Same as channels. There is no separate, more private DM store                                                                  |
| Uploaded files             | the bytes you sent, unchanged, under `upload.storage_dir` — `Server/storage/storage.go:136`, `:157`; served by `Server/api/upload_handler.go:281`   | **Delivery** with permission checks (`upload_handler.go:293`), size caps                                                       |
| Search index               | SQLite FTS5 over message text — `Server/migrations/001_initial_schema.sql:87-91`; queried at `Server/db/message_queries.go:385`                     | **Search** (`GET /api/v1/search`, `Server/api/channel_handler.go:79`). Test: `TestSearchMessages_FindsMatch`                   |
| Names, times, who-is-where | `users`, `messages`, `sessions` rows (`001_initial_schema.sql:37-46`)                                                                               | **Everything** — routing, permissions, unread counts                                                                           |
| Backups                    | a full plain copy of the database via `VACUUM INTO` — `Server/db/admin_queries.go:404`; written to `backup.dir` (`Server/config/config.go:275`)     | **Backup and restore** (`Server/admin/api.go:163-172`). There is no download endpoint; the backup lives on the operator's disk |

What the server does **not** keep in the clear:

- **Passwords** — bcrypt, cost 12: `Server/auth/password.go:38`, `:17`.
  Test: `Server/auth/password_test.go`.
- **Session tokens and API tokens** — SHA-256 of the token, never the token:
  `Server/auth/session.go:21-22`; stored hashed at `Server/api/auth_handler.go:201`
  and `Server/migrations/018_api_tokens.sql:17` (the `sessions.token` column
  name is historical; `018_api_tokens.sql:9` says what it holds). Test:
  `Server/auth/session_test.go`, `Server/auth/resolve_test.go`.
- **2FA secrets** — encrypted with a server-local AES-256 key
  (`Server/api/router.go:47`, `Server/auth/totp_encrypt.go`).
- **Message bodies in logs** — no `slog` call in server code logs `content`;
  `Server/db/logvalue.go:14`, `:26` and `Server/config/logvalue.go:57` redact
  hashes and secrets from every log line. Tests:
  `TestUserSessionRedactedInLogs`, `TestSecretConfigsRedactedInLogs`.
- **Message bodies in the audit log** — `Server/db/audittest/audittest.go:95`
  `AssertSafeDetails` fails any audit row whose detail carries a body, token,
  hash or secret. Tests: `TestAuditCoverage_ServiceMutations`,
  `TestAuditCoverage_APIMutations`, `TestAuditCoverage_AdminMutations`,
  `TestAuditCoverage_PluginLifecycle`.

Text chat is **not** end-to-end encrypted, on purpose. The client sends the
composer string as-is in `chat_send`
(`Client/src/pages/main-page/ChannelController.ts:259-262`); the only
cryptography in the client is the voice key exchange (`Client/src/lib/e2eeCrypto.ts`,
`livekitE2EE.ts`, `identity.ts`). This is the hybrid model in BPR-050, the same
trade Discord makes: server-readable text buys search, moderation, replay and
backup.

## What is end-to-end encrypted

Voice, video and screen share. The design is in
[architecture/voice-e2ee.md](architecture/voice-e2ee.md); the rules and their
tests:

| Rule                                                                                                 | Code                                                                                                                                                | Test                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The room key is made on a participant's machine, never on the server                                 | `Client/src/lib/e2eeCrypto.ts:202-204` (`generateRoomKey`, WebCrypto random); called from `Client/src/lib/livekitE2EE.ts:223-227`                   | `livekit-e2ee.test.ts` "setupKeyExchange as key holder generates the room key and sends a signed announce"                                                                        |
| One participant (the **key holder**, lowest user ID) wraps the key for each peer with ECDH + AES-GCM | `e2eeCrypto.ts:240` `wrapRoomKey`, `:269` `unwrapRoomKey`                                                                                           | `e2eeCrypto.test.ts` "round-trips a room key between two keypairs"                                                                                                                |
| Media frames are encrypted before they leave the machine; the SFU (LiveKit) relays ciphertext        | `Client/src/lib/livekitSession.ts:424-429`, `:439` `setE2EEEnabled(true)`                                                                           | `livekit-session.test.ts` "enables E2EE on the room created by createRoom (OC-0095)"                                                                                              |
| The server relays wrapped keys as opaque bytes; it checks size and encoding, never decodes           | `Server/ws/voice_e2ee.go:182-193`, `:225` (copied verbatim), `:239` (delivered only to a member of that voice channel)                              | `TestE2EE_Offer_KeyHolderCanSend`, `TestE2EE_Offer_RejectsNonKeyHolder`, `TestE2EE_Offer_TargetChannelCheckAtomicWithLookup`                                                      |
| The server holds no room key                                                                         | Absence: the only E2EE state on the server is the public-key map and the key-holder map (`voice_e2ee.go:47`, `:77`, `:278`); no decrypt path exists | Pinned by the relay tests above; there is no positive "no key" assertion because there is nothing to assert on                                                                    |
| Each user has a long-lived identity key; peers pin it on first sight (TOFU) and block on a change    | `Client/src/lib/identity.ts:116`, `:158`; decision in `livekitE2EE.ts:520-562`, first-sight pin `:611-620`                                          | `identity.test.ts` "getIdentityPin reports a store error as 'unavailable', never 'unpinned' (DC-08)"; `livekit-e2ee.test.ts` "[finding 2] marks a first-sight peer 'unverified'…" |
| Accepting a new key re-pins the key the human saw, not a fresh read the server could have swapped    | `livekitE2EE.ts:671-677` `rePinPeerIdentity(userId, verifiedKey)`                                                                                   | `livekit-session.test.ts` "re-pins the verified key, not a store re-read a malicious server mutated (TOCTOU)"                                                                     |
| When someone leaves, the key holder rotates the key, so the leaver cannot decrypt what comes next    | `livekitE2EE.ts:1235-1246` `handleParticipantLeft`, `:1217-1233` `rotateRoomKey`                                                                    | `livekit-session.test.ts` "rotates the room key when a keyed peer leaves while I stay key holder (forward secrecy)"                                                               |
| The key also rotates on a timer while the call runs                                                  | `livekitE2EE.ts:1443` `rotateKeyPeriodically`                                                                                                       | `livekit-e2ee.test.ts` "[T-47] arms the periodic rotation timer for the key holder…"                                                                                              |
| A reconnect during a rotation gets the current key, not a stale one                                  | `Server/ws/hub.go:664-681` (re-announce on resume, OC-0316)                                                                                         | `TestRegisterNow_ReannouncesOwnKeyOnResume`; client `"[OC-0007] confirms the room key after a reconnect re-announce…"`                                                            |
| The server still decides **who may join and publish** — E2EE hides content, not membership           | `Server/ws/livekit.go:90` `GenerateToken`, `:110-135` per-permission `CanPublishSources`; `Server/ws/voice_join.go:382`                             | `TestE2EE_VoiceToken_IncludesIsKeyHolder`; `Server/ws/voice_moderation_overrides_test.go`                                                                                         |

What E2EE does **not** hide from the operator: who is in which voice channel,
when, for how long, and who is muted or deafened. Those are server state.

The identity-key store is the trust root. On the desktop it lives beside the
session token in the OS keychain (`docs/credential-storage.md`, account
`identity:{host}`). A malicious operator can serve a wrong public key; the pin
and the mismatch modal are what catch it, which is why a "Trust new key"
click should be rare and deliberate.

## Transport

Everything between client and server is TLS. Which certificate, and how the
client decides to trust it:

| Server `tls.mode` (`Server/config/config.go:255-262`, semantics `Server/auth/tls.go:87-117`) | Certificate                                                    | Desktop client                                                                                                                                                                                                             | Browser client (B8, does not exist yet)                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `self_signed` (default, `config.go:316`)                                                     | generated on first run                                         | **TOFU pinning.** First connect shows the fingerprint and asks; the pin is stored (`Client/src-tauri/src/ws_proxy.rs:379-425`, only writer) and every later connection must match (`Client/src-tauri/src/tofu.rs:132-166`) | Must use a publicly trusted or locally installed CA certificate; no pinning |
| `acme`                                                                                       | Let's Encrypt via `autocert` (`Server/auth/tls.go:164-193`)    | Pinned the same way                                                                                                                                                                                                        | Trusted by the browser's CA store                                           |
| `manual`                                                                                     | operator-supplied files                                        | Pinned the same way                                                                                                                                                                                                        | Trusted if the CA is                                                        |
| `off`                                                                                        | none — only behind a TLS-terminating reverse proxy you control | Pins the proxy's certificate                                                                                                                                                                                               | Trusted if the proxy's CA is                                                |

Desktop pinning details, each with its test:

- The pin is the SHA-256 of the leaf certificate (`tofu.rs:25`); a mismatch
  rejects the connection before any application byte is sent (`tofu.rs:157-163`).
  Tests: `decide_first_use_when_no_pin`, `decide_trusted_when_pin_matches`,
  `decide_mismatch_when_pin_differs`, `capture_verifier_records_leaf_not_intermediate`.
- First use also rejects: the app shows the fingerprint, and only an explicit
  accept writes a pin (`tofu.rs:6-10`, `:380-381` "deciding never writes a
  pin"). Tests: `valid_fingerprint_is_accepted` and the six rejection cases in
  `ws_proxy.rs:440-503`.
- All three native tunnels (WebSocket, HTTP, LiveKit) use the same verifier:
  `ws_proxy.rs:207`, `http_proxy.rs:405`, `livekit_proxy.rs:448`.
- The session token travels inside the first WebSocket frame, never in the
  URL: server `Server/ws/serve_auth.go:26-61`, client `Client/src/lib/ws.ts:546`
  (path only) and `:447-455` (auth frame). Test: `ws-lifecycle.test.ts`
  "sends auth message when Rust reports open".

A browser cannot inspect or pin a certificate. The browser adapter (B7/B8)
must require a certificate the browser already trusts and say so, not fake the
pinning flow — [architecture/platform-contracts.md](architecture/platform-contracts.md)
§"Hard cases" is the binding statement.

## Desktop preview destination policy (C-09) — contract for B7

Link previews, avatars and external inline images make the desktop client
fetch URLs that other users chose. Today that fetch is made from the renderer
through the Tauri HTTP plugin with a TypeScript hostname filter in front of it
(`Client/src/components/message-list/embeds.ts:132-142`, `:171-184`;
`docs/security.md` §"Tauri Capabilities"). The B7 platform seam replaces that
with **one native fetch broker** that owns the whole policy. This is the
contract B7 implements; it is written here so B7 does not rediscover it.

The broker MUST:

1. **Own every automatic remote fetch** — previews, avatars, external images,
   OG images, and any future automatic media path. Renderer code gets no
   general-purpose HTTP client.
2. **Parse in native code** — only the permitted schemes and ports; reject
   embedded credentials and malformed authorities.
3. **Resolve, then classify every answer** — all A and AAAA records,
   normalised (IPv4-mapped IPv6 included). Reject if **any** address is
   loopback, private, link-local, unspecified, multicast, carrier-grade NAT,
   documentation, benchmarking, or otherwise non-global. The server already
   has this exact list at `Server/plugin/host_http.go:224-249`; the broker
   mirrors it.
4. **Connect only to the validated addresses**, keeping the hostname for SNI
   and certificate checks. No second unconstrained lookup after validation
   (`host_http.go:182-216` is the server-side shape).
5. **Disable automatic redirects.** Follow at most a small fixed number by
   hand, re-running steps 2–4 on every hop; reject scheme downgrades.
6. **Bound time, bytes and concurrency** — a total deadline, a streaming byte
   ceiling enforced while reading (a `Content-Length` header is not a limit),
   an allowed content-type list, and a cap on concurrent fetches.
7. **Return a typed minimum** — title, description, image URL, dimensions —
   never raw status, headers or bodies to message-controlled code.
8. **Narrow the renderer capability** once the broker owns these requests:
   the `https://*` entry in `Client/src-tauri/capabilities/default.json` is a
   URL-pattern control, not a DNS control, and stays only as defence in depth.

Regression coverage B7 owes: names resolving into each blocked class, a public
name redirecting to a private target, mixed answer sets, CNAME chains, an
address that changes between validation and connect, and boundary tests for
the redirect count, deadline, byte ceiling, content types and TLS validity —
against the real preview, avatar and external-image entry points.

Status: contract (this document, B2-7); implementation B7; tracked as C-09 in
[plans/repo-health-issue-register-2026-08-23.md](plans/repo-health-issue-register-2026-08-23.md).

## At rest

| Where                      | What                                                                                            | Protection                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server database            | SQLite file in `server.data_dir`                                                                | **Not encrypted.** Plain `modernc.org/sqlite` driver, no cipher (`Server/db/db.go:17`, `:219`, DSN pragmas `:62-68`). Filesystem permissions and full-disk encryption are the operator's job                                                                            |
| Server uploads             | plain files under `upload.storage_dir`                                                          | Same                                                                                                                                                                                                                                                                    |
| Server backups             | plain database copies under `backup.dir`                                                        | Same — treat the backup directory as the database                                                                                                                                                                                                                       |
| Server secrets             | password hashes, token hashes, encrypted TOTP secrets                                           | See "What the server does not keep in the clear" above                                                                                                                                                                                                                  |
| Desktop session + identity | OS keychain via the `keyring` crate: Windows Credential Manager, macOS Keychain, Secret Service | Every write is read back and verified (`Client/src-tauri/src/secret_store.rs:94`). If the keychain fails the round trip, a sealed file (DPAPI on Windows, ChaCha20-Poly1305 elsewhere) takes over until it works again — [credential-storage.md](credential-storage.md) |
| Desktop certificate pins   | `certs.json` in the app data dir (`Client/src-tauri/src/constants.rs:2`)                        | Plain file; a user who can edit it can re-pin, which is the same user who can click "trust"                                                                                                                                                                             |
| Desktop identity pins      | `identity_pins.json` (`Client/src/lib/identity.ts:11-12`)                                       | Plain file; same reasoning. The identity _private_ key is in the keychain, not here                                                                                                                                                                                     |

## What the operator can and cannot do

Can, by design:

- Read, search, export (via backup) and delete any text or file on the server.
- See who is online, who is in which voice channel, session devices and IPs
  (`sessions` table, `001_initial_schema.sql:37-46`).
- Ban, force-logout (`Server/admin/api.go:114`), change roles, and change any
  setting. Each of these writes an audit row — the list is in
  [security.md](security.md) §"Audit Logging", and `TestAuditCoverage_*`
  fails if a new admin mutation ships without one.
- Install plugins, when the WASM runtime is compiled in and enabled —
  [architecture/plugins.md](architecture/plugins.md). Off by default
  (`Server/config/config.go:352`).

Cannot, and the code is what stops them:

- Listen to a voice, video or screen-share stream (see "What is end-to-end
  encrypted").
- Recover a password (bcrypt) or a live session token (hashed) from the
  database.
- Impersonate a user's E2EE identity to a peer who has already pinned it — the
  peer's client blocks with a mismatch modal.
- Read a user's messages on another OwnCord server: each server is an island
  (next section).

Can, with effort outside the code — and this is the honest boundary: an
operator with shell access can edit the binary, the database or the
configuration. No control in this document survives a hostile operator with
root on the box, except E2EE media, which never gave the box a key.

## Multi-device sessions

- A user may hold up to 25 sessions; the 26th evicts the oldest
  (`Server/db/auth_queries.go:237`, `:249-251`).
- Each session records device, IP, creation, last use and expiry
  (`001_initial_schema.sql:37-46`).
- Users list and revoke their own sessions: `GET`/`DELETE /api/v1/users/me/sessions`
  (`Server/api/profile_handler.go:92-93`); revocation is scoped to the calling
  user (`Server/service/user.go:366`).
- A password change revokes every other session (`Server/service/user.go:336`).
- Admin force-logout revokes all of a user's sessions
  (`Server/admin/api.go:114`; test `TestForceLogout_AuthorizationMatrix`).
- Voice E2EE identity is per install: a second device has its own identity
  key and is pinned separately by peers.

## What beta does not claim

- **No deniability, no metadata privacy.** The operator sees who talked to
  whom and when.
- **No encrypted text.** If that changes it is a new protocol epoch, a new
  document, and a new trade-off against search, moderation and replay — not a
  toggle.
- **No protection against a hostile operator** beyond what E2EE media gives.
- **No secure deletion.** Account deletion blanks message bodies and
  anonymises the name (`Server/db/account.go:116`, `:131`; test
  `TestDeleteAccount_AnonymisesUsername`), but backups taken before the
  deletion still hold the text, and SQLite does not scrub freed pages.
- **No browser client yet**, and when there is one it will not pin
  certificates.
- **No stable plugin API** — [architecture/plugins.md](architecture/plugins.md).

## How this document is kept true

- HP-2 question 3 requires every claim above to trace to a test or a code
  line; the anchors are that trace. Update them when the code moves.
- The absence proofs (federation, directory) are a test that fails when a
  matching route appears; see "What OwnCord does not have".
- BPR-051's exit evidence is one non-developer reading "The short answer" and
  answering "who can read my messages?" correctly — recorded in the B2-7
  evidence block of
  [plans/b2-protocol-trust-compat-2026-08-28.md](plans/b2-protocol-trust-compat-2026-08-28.md).
