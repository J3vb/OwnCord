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
  did not set up — because the connection is TLS, **with one window**: on the
  desktop's very first connection to a server, the app shows the certificate
  fingerprint and asks you to trust it. It does this for **every** kind of
  certificate — self-signed or from a public CA — because the desktop pins
  the fingerprint it sees rather than checking the certificate against the
  public CA list (`Client/src-tauri/src/ws_proxy.rs:140-147`,
  `Client/src-tauri/src/tofu.rs:72-111`). It cannot know whether that
  fingerprint is the server's or an attacker's on the path. Compare it with
  the fingerprint the operator gives you another way (chat elsewhere, a call)
  before clicking; every later connection is then checked against that pin.
  A public-CA certificate closes this window only for a browser, which trusts
  its own CA list, and a server run with TLS switched off has no protection
  on the wire at all (see "Transport").
- **Voice, video and screen share are different**: they are end-to-end
  encrypted between the people in the call. The server passes the encrypted
  media along and never has the key, so an operator who only reads what the
  server stores or relays cannot listen in. An operator who **changes the
  server** is a different matter: the server decides who is in a call, and
  your client accepts any new participant's key the first time it sees it —
  so a modified server can add a participant it controls and receive the
  room key. Pinning catches a **known** person's key changing, not a new
  person appearing. Today, E2EE media is not a defence against an operator
  who modifies the server (see "What is end-to-end encrypted").

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
  (`Server/api/router.go:47`; enrolment encrypts at
  `Server/api/totp_handler.go:323`). **Exception:** a database from before
  that encryption landed may still hold plaintext secrets; nothing rewrites
  them in place. The server returns such a value as-is and logs a warning on
  every read (`Server/auth/totp_encrypt.go:109-117`). Disabling and
  re-enabling 2FA on that account stores it encrypted.
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

The identity-key store is the trust root. On the desktop the private key
lives beside the session token in the OS keychain, one slot per account per
server — keychain account `identity:{userId}@{host}`
(`Client/src/lib/identity.ts:221-222`, `Client/src-tauri/src/credentials.rs:214-220`;
`identity:{host}` is the legacy slot that entry was migrated from). Its
protection is **trust on first use**, and that is the
limit: the first time your client meets a peer it has no pin, so it accepts
the public key the server delivers, checks that the announce is signed by
that key, and pins it (`Client/src/lib/livekitE2EE.ts:611-620`). A malicious
operator who substitutes a key at that first contact is not detected by the
pin. What the pin catches is any **later** change to a peer you have already
pinned — that is when the mismatch modal blocks, and why a "Trust new key"
click should be rare and deliberate. To close the first-contact window,
compare identity-key fingerprints out of band (the verification surface in
[architecture/ux/voice-and-e2ee.md](architecture/ux/voice-and-e2ee.md) §7
shows them). Pins are **one per account**, keyed `{host}:{userId}`
(`Client/src/lib/identity.ts:11-12`; `livekitE2EE.ts:521`, `:612`), while
identity keys are per install — so a peer's second device shows up as a
mismatch of the same account, trusting it overwrites the pin, and their first
device then mismatches in turn. Until a stable device identifier exists,
expect that flip-flop with multi-device peers and verify each key out of
band.

## Transport

In every `tls.mode` except `off`, everything between client and server is
TLS; `off` served directly is plaintext, and is only safe behind a
TLS-terminating reverse proxy the operator controls (its row below). Which
certificate, and how the client decides to trust it:

| Server `tls.mode` (`Server/config/config.go:255-262`, semantics `Server/auth/tls.go:87-117`) | Certificate                                                                                                                                                                                                                                                                                                           | Desktop client                                                                                                                                                                                                             | Browser client (B8, does not exist yet)                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `self_signed` (default, `config.go:316`)                                                     | generated on first run                                                                                                                                                                                                                                                                                                | **TOFU pinning.** First connect shows the fingerprint and asks; the pin is stored (`Client/src-tauri/src/ws_proxy.rs:379-425`, only writer) and every later connection must match (`Client/src-tauri/src/tofu.rs:132-166`) | Must use a publicly trusted or locally installed CA certificate; no pinning |
| `acme`                                                                                       | Let's Encrypt via `autocert` (`Server/auth/tls.go:164-193`)                                                                                                                                                                                                                                                           | Pinned the same way                                                                                                                                                                                                        | Trusted by the browser's CA store                                           |
| `manual`                                                                                     | operator-supplied files                                                                                                                                                                                                                                                                                               | Pinned the same way                                                                                                                                                                                                        | Trusted if the CA is                                                        |
| `off`                                                                                        | none. **Served directly, every connection is plaintext HTTP** — passwords, tokens and messages are readable by anyone on the path (`Server/auth/tls.go:94-95`, `Server/main.go:636-639`). Nothing in the server enforces a proxy; the operator must put a TLS-terminating reverse proxy in front and expose only that | Pins the proxy's certificate (behind a proxy); no protection without one                                                                                                                                                   | Trusted if the proxy's CA is (behind a proxy); plaintext without one        |

Desktop pinning details, each with its test:

- The pin is the SHA-256 of the leaf certificate (`tofu.rs:25`); a mismatch
  rejects the connection before the auth frame or any WebSocket payload is
  sent (`tofu.rs:157-163`). The WebSocket upgrade request itself — path and
  headers, which carry no credential, since the token travels in the first
  frame — does reach the peer before the verdict
  (`Client/src-tauri/src/ws_proxy.rs:148-178`).
  Tests: `decide_first_use_when_no_pin`, `decide_trusted_when_pin_matches`,
  `decide_mismatch_when_pin_differs`, `capture_verifier_records_leaf_not_intermediate`.
- First use also rejects: the app shows the fingerprint, and only an explicit
  accept writes a pin (`tofu.rs:6-10`, `:380-381` "deciding never writes a
  pin"). Tests: `valid_fingerprint_is_accepted` and the six rejection cases in
  `ws_proxy.rs:440-503`.
- The first-use prompt is the same in every `tls.mode`: the desktop does
  not validate a public-CA certificate against the CA list on the OwnCord
  connection — it pins what it sees (`ws_proxy.rs:140-147`,
  `tofu.rs:72-111`). Web-PKI validation exists only in the updater's
  `HostScopedVerifier` (`tofu.rs:191-215`) for the GitHub download, not for
  the server connection. Out-of-band fingerprint comparison is therefore the
  only first-contact defence on the desktop, whatever certificate the server
  has.
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
fetch URLs that other users chose. Today those fetches are made from the
renderer through the Tauri HTTP plugin and the webview's own image loading,
with destination policy applied in TypeScript per call site rather than in
one place (`Client/src/components/message-list/embeds.ts`, `attachments.ts`,
`media.ts`; `docs/security.md` §"Tauri Capabilities") — which is the C-09
finding as publicly recorded: the policy is **not centralised at the native
boundary**, and not every automatic fetch path applies the same checks. Until
B7 lands, treat every automatic remote fetch on the desktop as governed by
the capability scope and CSP only. The B7 platform seam replaces that with
**one native fetch broker** that owns the whole policy. This is the
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
   documentation, benchmarking, or otherwise non-global. The server's
   `ipAllowed` (`Server/plugin/host_http.go:224-249`) is the starting point,
   not the whole list: it rejects loopback, private, link-local, unspecified,
   multicast and carrier-grade NAT, and **does not** reject the documentation
   ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
   `2001:db8::/32`), the benchmarking range (`198.18.0.0/15`) or the other
   reserved non-global blocks. The broker adds those; extending `ipAllowed`
   to match is a separate server change.
4. **Connect only to the validated addresses**, keeping the hostname for SNI
   and certificate checks. No second unconstrained lookup after validation
   (`host_http.go:182-216` is the server-side shape).
5. **Disable automatic redirects.** Follow at most a small fixed number by
   hand, re-running steps 2–4 on every hop; reject scheme downgrades.
6. **Bound time, bytes and concurrency** — a total deadline, a streaming byte
   ceiling enforced while reading (a `Content-Length` header is not a limit),
   an allowed content-type list, and a cap on concurrent fetches.
7. **Return a typed minimum** — title, description, dimensions, and the
   preview image **as bytes or an opaque local handle fetched by the broker
   under clauses 2–6** — never a remote image URL for the renderer to load
   itself (a second, un-brokered request would bypass every control above),
   and never raw status, headers or bodies to message-controlled code.
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
| Server backups             | plain database copies under `backup.dir`                                                        | Same — treat the backup directory as the database. Uploads are **not** included; back up `upload.storage_dir` alongside it                                                                                                                                              |
| Server secrets             | password hashes, token hashes, encrypted TOTP secrets                                           | See "What the server does not keep in the clear" above                                                                                                                                                                                                                  |
| Desktop session + identity | OS keychain via the `keyring` crate: Windows Credential Manager, macOS Keychain, Secret Service | Every write is read back and verified (`Client/src-tauri/src/secret_store.rs:94`). If the keychain fails the round trip, a sealed file (DPAPI on Windows, ChaCha20-Poly1305 elsewhere) takes over until it works again — [credential-storage.md](credential-storage.md) |
| Desktop certificate pins   | `certs.json` in the app data dir (`Client/src-tauri/src/constants.rs:2`)                        | Plain file; a user who can edit it can re-pin, which is the same user who can click "trust"                                                                                                                                                                             |
| Desktop identity pins      | `identity_pins.json` (`Client/src/lib/identity.ts:11-12`)                                       | Plain file; same reasoning. The identity _private_ key is in the keychain, not here                                                                                                                                                                                     |

## What the operator can and cannot do

Can, by design:

- Read, search and delete any text or file on the server; export the text
  via the database backup. **Uploaded files are not in that backup** — it is
  `VACUUM INTO` of the SQLite file only (`Server/admin/handlers_backup.go:76-84`,
  `Server/db/admin_queries.go:404`); `upload.storage_dir` must be backed up
  separately or a restore loses every attachment.
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

- Read a voice, video or screen-share stream from what the server stores
  or relays (see "What is end-to-end encrypted"). The active attack — a
  modified server adding a participant it controls — is in the next
  paragraph, and it works.
- Recover a password (bcrypt) or a live session token (hashed) from the
  database.
- Impersonate a user's E2EE identity to a peer who has already pinned it — the
  peer's client blocks with a mismatch modal.
- Read a user's messages on another OwnCord server: each server is an island
  (next section).

Can, with effort outside the code — and this is the honest boundary: an
operator with shell access can edit the binary, the database or the
configuration. No control in this document survives a hostile operator with
root on the box, **E2EE media included**. Call membership is
server-controlled and unauthenticated: a modified server can add a member —
an invented user id, or a real peer's first contact — with an identity key
and an ephemeral key the operator holds, the client accepts and pins any
first-sight identity (`Client/src/lib/livekitE2EE.ts:603-638`), and the key
holder wraps the room key to it (`:842-912`). Pinning every legitimate peer
and comparing keys out of band does not close this: pins detect a **known**
peer's key changing, not an unknown member joining. What E2EE gives today is
exact and narrower: the server never holds the room key, so an operator who
**reads** — database, logs, relayed frames, backups — gets nothing, and a
known peer's key cannot be swapped without the mismatch modal. A defence
against a modified server needs authenticated membership or the client
refusing unrecognised participants; neither exists in beta (see "What beta
does not claim").

## Multi-device sessions

- A user may hold up to 25 sessions; the 26th evicts the oldest
  (`Server/db/auth_queries.go:237`, `:249-251`).
- Each session records device, IP, creation, last use and expiry
  (`001_initial_schema.sql:37-46`).
- Users list and revoke their own sessions: `GET`/`DELETE /api/v1/users/me/sessions`
  (`Server/api/profile_handler.go:92-93`); revocation is scoped to the calling
  user (`Server/service/user.go:366`).
- Sign-out-everywhere: `DELETE /api/v1/users/me/sessions` revokes every
  session of the calling account, the current one included, and never
  another account's (`UserService.RevokeAllSessions`, audit
  `session_revoke_all`; test `TestRevokeAllSessions_OnlyTheCallersAccount`).
- A password change revokes every other session (`Server/service/user.go:336`).
- Admin force-logout revokes all of a user's sessions
  (`Server/admin/api.go:114`; test `TestForceLogout_AuthorizationMatrix`).
- Voice E2EE identity is per install, but peers keep **one pin per account**
  (`{host}:{userId}`, `Client/src/lib/identity.ts:11-12`): your second device
  appears to them as a key change, trusting it replaces the pin, and your
  first device then triggers the mismatch modal. Not per-device pinning.

## What beta does not claim

- **No deniability, no metadata privacy.** The operator sees who talked to
  whom and when.
- **No encrypted text.** If that changes it is a new protocol epoch, a new
  document, and a new trade-off against search, moderation and replay — not a
  toggle.
- **No protection against a hostile operator, E2EE media included.** E2EE
  resists an operator who reads. A modified server controls call membership
  and can add a participant it holds the keys for; pins do not cover a member
  that was never a known peer. Authenticated membership is not in beta.
- **No secure deletion.** Account deletion blanks message bodies and
  anonymises the name (`Server/db/account.go:116`, `:131`; test
  `TestDeleteAccount_AnonymisesUsername`), but backups taken before the
  deletion still hold the text, and SQLite does not scrub freed pages.
- **No browser client yet**, and when there is one it will not pin
  certificates.
- **No stable plugin API** — [architecture/plugins.md](architecture/plugins.md).

## What OwnCord does not have

Stated so the absence is a promise, not an accident (BPR-040, BPR-082,
BPR-083):

- **No federation and no cross-server messaging.** Servers never talk to each
  other. There is no protocol for it and no route that would carry it.
- **No directory, discovery or public listing.** Nobody can find your server
  unless you give them the address or an invite link.
- **No global identity.** An account is a row in one server's database
  (`users`, `Server/migrations/001_initial_schema.sql`). The same username on
  two servers is two unrelated people; nothing links them, and a ban, a role or
  a friend on one means nothing on the other. Even the voice E2EE identity is
  pinned per host (`Client/src/lib/identity.ts:11-12`, key `{host}:{userId}`).
- **No required external service.** A server on a LAN with no internet works.
  Every outbound connection it can make is in the next table, each with the
  condition that triggers it and the control where one exists. Two rows have
  a condition but no configuration switch: GitHub release metadata (only on
  request, never on a timer) and LiveKit signalling (only on a voice join,
  to `voice.livekit_url`).

The proof is three tests in `Server/api/absence_contract_test.go`, one per
boundary a new feature has to cross, each failing on the pattern
`federat|directory|discover|listing` and each with a floor on how much it
inspected so it cannot pass by looking at nothing:

- `TestAbsenceContract_NoFederationDirectoryOrListingRoutes` — builds the
  production router with every optional route family on and walks the whole
  mounted tree, admin and plugin subrouters included. Mounting a `/directory`
  route makes it red; that run is in the B2-7 evidence block.
- `TestAbsenceContract_NoFederationDirectoryOrListingWireTypes` — every
  WebSocket message type in `protocol/schema.json`, both directions.
- `TestAbsenceContract_NoFederationDirectoryOrListingConfigKeys` — every
  `koanf` key of `config.Config`, with one allowlisted on-disk path
  (`plugins.directory`).

What they prove is bounded and stated: they pin **vocabulary at the three
boundaries**, not semantics. A feature smuggled in under a neutral name would
pass them. The network boundary is covered differently — by the outbound-host
table below, which B6 checks against a packet capture — and the review rule is
the last line of defence: a route, message type or config key that
legitimately needs one of those words, or any feature that makes the server
talk to another server, must update this section and that table first.

## Outbound connections the server makes

For B6's network capture: everything the server process reaches out to, from
a read of every `http.Client`, `net.Dial` and URL literal in non-test server
code, plus the one companion process the server supervises. Traffic the
server **serves** — responses on `server.port` to clients it did not initiate —
is not in the table; the capture filters it by direction. **DNS** is not a
row either: every hostname below is resolved through the host's configured
resolver first, so queries to that resolver (and nothing else on port 53)
are expected and environment-dependent; the capture filters them by
destination. Anything else on the wire is a finding.

| Host                                                                                                                                                                                   | When                                                                                        | Why                                                                                                                                                                                                                           | Off switch                                                                                                                                                                                                                                                                                                         | Code                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `api.github.com`                                                                                                                                                                       | on request to `/api/v1/client-update/…` or the admin update panel; cached 1 h               | latest-release metadata for client and server updates                                                                                                                                                                         | none needed — never on a timer; `github.owner`/`github.repo` pick the repo                                                                                                                                                                                                                                         | `Server/updater/updater.go:22`, `:224-233`; `Server/api/client_update.go:34`; `Server/admin/update_handlers.go:24`   |
| `github.com` (+ `*.githubusercontent.com` on redirect)                                                                                                                                 | admin clicks "update server"                                                                | download and verify the signed server release                                                                                                                                                                                 | do not click; URL is prefix-checked against the configured repo                                                                                                                                                                                                                                                    | `Server/updater/download.go:21`, `:265-273`; `Server/updater/assets.go:164-174`                                      |
| `github.com/livekit/livekit/releases/download` (+ the GitHub asset hosts on redirect, `objects.githubusercontent.com` / `release-assets.githubusercontent.com`, as in the updater row) | startup, only if `voice.auto_download_livekit` and no `voice.livekit_binary`                | fetch the pinned, checksum-verified `livekit-server` binary ; fetched with `http.DefaultClient`, which follows redirects (`Server/ws/livekit_download.go:271-300`) — the pinned SHA-256 bounds what is accepted, not the host | `voice.auto_download_livekit: false` or set `voice.livekit_binary`                                                                                                                                                                                                                                                 | `Server/ws/livekit_download.go:31`, `:36`, `:272-300`; `Server/ws/livekit_process.go:230`                            |
| `api.klipy.com`                                                                                                                                                                        | a user opens the GIF picker                                                                 | GIF search/trending, proxied so the API key stays on the server                                                                                                                                                               | leave `gif.api_key` empty (default) — endpoints answer 503                                                                                                                                                                                                                                                         | `Server/api/gif_handler.go:34`, `:56-62`; `Server/config/config.go:68-76`                                            |
| STUN and cloud-metadata endpoints — external-address discovery by the **LiveKit subprocess** the server supervises                                                                     | LiveKit start-up, because the generated config sets `use_external_ip: true` unconditionally | learn the public address to advertise in ICE candidates                                                                                                                                                                       | not running LiveKit (as below); setting `voice.node_ip` advertises that address but does not turn discovery off (`Server/ws/livekit_process.go:130-133`)                                                                                                                                                           | `Server/ws/livekit_process.go:130-133`; `Server/config/config.go:160`                                                |
| participants' addresses — WebRTC media from the **LiveKit subprocess** the server supervises, UDP 50000–60000 and TCP 7881                                                             | a call is in progress                                                                       | encrypted media frames (E2EE); ICE/TURN                                                                                                                                                                                       | not running LiveKit (leave `voice.livekit_binary` unset and `voice.auto_download_livekit: false`) or hosting it elsewhere                                                                                                                                                                                          | `Server/ws/livekit_process.go:123-144` (`port_range_start`/`end`); ports in `docs/deployment.md` §Firewall and Ports |
| LiveKit at `voice.livekit_url` (default `ws://localhost:7880`)                                                                                                                         | a user joins voice; health probe of the supervised process                                  | media SFU signalling                                                                                                                                                                                                          | **none today**: empty credentials are replaced by random ones and an empty URL defaults to `ws://localhost:7880` (`Server/config/config.go:645-662`), so a voice join always attempts `voice.livekit_url`; with no LiveKit running the attempt fails on loopback. A real `voice.enabled` switch is a server change | `Server/api/livekit_proxy.go:23-28`; `Server/ws/livekit_process.go:47-52`, `:361-366`                                |
| hosts on `plugins.http_allowlist`                                                                                                                                                      | an installed plugin with the `http` capability calls out                                    | plugin feature                                                                                                                                                                                                                | empty by default; plugins off by default (`Server/config/config.go:352`, `:356`)                                                                                                                                                                                                                                   | `Server/plugin/host_http.go:66`, `:136-155`                                                                          |
| `acme-v02.api.letsencrypt.org`                                                                                                                                                         | startup and renewal, only when `tls.mode: acme`                                             | certificate issuance                                                                                                                                                                                                          | any other `tls.mode` (default `self_signed`)                                                                                                                                                                                                                                                                       | `Server/auth/tls.go:164-193`                                                                                         |
| operator's OTLP collector (`telemetry.otlp_endpoint`)                                                                                                                                  | startup, only when `telemetry.exporter: otlp`                                               | traces and metrics to a collector the operator runs                                                                                                                                                                           | `telemetry.exporter: none` (default)                                                                                                                                                                                                                                                                               | `Server/config/config.go:107-114`; `Server/main.go:373`                                                              |
| `8.8.8.8:80` (UDP, **no packet is sent**)                                                                                                                                              | startup banner                                                                              | asks the OS which local address routes out, to print the LAN URL                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                               | `Server/main.go:1005-1012`                                                                                           |
| `127.0.0.1:<port>/health`                                                                                                                                                              | `healthcheck` subcommand (Docker `HEALTHCHECK`)                                             | liveness probe of itself                                                                                                                                                                                                      | n/a — loopback                                                                                                                                                                                                                                                                                                     | `Server/main.go:748-757`                                                                                             |

Not in the table because it does not exist: analytics, crash reporting,
telemetry to the project, licence checks, a phone-home of any kind. The only
`telemetry` package is OpenTelemetry instrumentation whose exporter defaults to
`none`. The Docker image is distroless with no shell or `curl`
(`Server/Dockerfile:30`), and no tracked script the **server runs** fetches
an external host. One build-time exception, outside the server: the release
workflow's AppImage step downloads `appimagetool` from GitHub
(`Client/scripts/strip-appimage-bundled-libs.sh:25-26`, invoked by
`.github/workflows/release.yml`). That runs on the CI runner when a release
is cut, never on an operator's machine.

Two of the GitHub paths (`updater.go`, `livekit_download.go`) use a plain
`http.Client` against fixed, prefix-validated GitHub URLs; the Klipy proxy and
plugin HTTP go through the guarded dialer that refuses private and loopback
answers (`Server/plugin/host_http.go:182-249`; tests
`TestGuardedDial_FallsBackAcrossVettedIPs`,
`TestGuardedDial_PrivateRecordRefusesBeforeAnyDial`).

The **desktop client** reaches, on its own: the server; LiveKit **signalling**
through the server's `/livekit/*` proxy for remote servers, or **directly** to
the LiveKit URL the server hands out when the server is local
(`Client/src/lib/livekitSession.ts:711-738`, `direct_url`); LiveKit **media**
always directly, to the SFU's advertised ICE endpoints on TCP 7881 / UDP
50000–60000 (`Server/ws/livekit_process.go:130-133`; `docs/deployment.md`
§Firewall and Ports); `www.youtube.com` and `img.youtube.com` for video
embeds (`Client/src/components/message-list/media.ts:173-174`, `:210`, `:229`);
the Klipy CDN for GIF media; GitHub for its own updates via the server's
`client-update` endpoint; and any URL a user posted, for link previews — the
C-09 contract above governs that last one.

## How this document is kept true

- HP-2 question 3 requires every claim above to trace to a test or a code
  line; the anchors are that trace. Update them when the code moves.
- The absence proofs (federation, directory) are a test that fails when a
  matching route appears; see "What OwnCord does not have".
- BPR-051's exit evidence is one non-developer reading "The short answer" and
  answering "who can read my messages?" correctly — recorded in the B2-7
  evidence block of
  [plans/b2-protocol-trust-compat-2026-08-28.md](plans/b2-protocol-trust-compat-2026-08-28.md).
