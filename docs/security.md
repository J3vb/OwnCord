# Security Policy

This page is for server operators and contributors. It explains how to report
a security problem, what stays private, and how OwnCord protects accounts,
data and the desktop client.

## Reporting Vulnerabilities

Report privately through GitHub Security Advisories:
[github.com/J3vb/OwnCord/security/advisories/new](https://github.com/J3vb/OwnCord/security/advisories/new).

**Do NOT open public issues for security bugs.**

The repository-root [SECURITY.md](../SECURITY.md) is the main reporting
policy. It says what to include and gives the response time (a first reply
within 7 days). Those details live only there, so the two files cannot
disagree.

## What stays private, and for how long

These rules apply to weaknesses in the repository's own automation and
settings (workflow permissions, credential scope, release gating) just as much
as to bugs in the server or client. Planning documents point to this section
as the rule.

- **Public records carry only four things.** Commits, issues, pull request
  descriptions and changelogs carry an **opaque identifier, the affected
  property, safe acceptance criteria, and a status**. Nothing more.
- **Details stay in the private advisory.** That means reproduction steps,
  source-to-sink traces, the conditions needed to exploit it, and the state a
  fix replaced. A commit that fixes a weakness describes the control it adds,
  not the gap it closes.
- **Every private finding has exactly one public owner.** So nothing is
  tracked only in private, and nothing is silently dropped.
- **Release notes may describe the repaired impact** once the fix is
  coordinated, but without the detail needed to reproduce it.

This repository is public. A commit message can reveal a weakness.

## Trust model

[trust-model.md](trust-model.md) is the one place that says:

- what the server operator can and cannot read;
- what is end-to-end encrypted;
- how data is protected in transit and at rest;
- what the beta does not claim.

Every claim there cites the code line or test that makes it true.

**Secrets set from the admin panel are write-only.** These are `gif.api_key`,
`github.token`, and the LiveKit key and secret. They are stored in
`<data_dir>/config-overrides.json` (mode `0600`). The panel is told only
whether a value is set. The server never returns, logs or audits the value.
Treat that file like `config.yaml` in your backups. See
[server-configuration.md](server-configuration.md#changing-settings-from-the-admin-panel).

## Two-Factor Authentication

OwnCord supports two-factor authentication (2FA) with TOTP codes from an
authenticator app.

**Enrolling and recovery codes**

- Users enrol in Settings > Account, with a QR code and backup codes.
- Emergency recovery codes: ten `XXXXX-XXXXX` codes are issued once at
  enrolment, and again on every `POST /api/v1/users/me/totp/recovery-codes`
  (which needs the password).
- Each code works once, in place of a TOTP code, at `verify-totp`. The reply
  then reports `recovery_codes_remaining`.
- The server stores only bcrypt hashes of the codes. Turning off 2FA or
  deleting the account removes the set.
- Security questions do not exist, and will not be added.

**Durable state and keys**

- Second-factor state survives a restart (migration 032). This covers the
  login challenge, a pending enrolment (encrypted under the TOTP key) and the
  90-second replay window. They are stored as digests and ciphertext, never as
  a token or code in the clear.
- If that store fails, the server fails closed. It issues no challenge and
  accepts no code on trust.
- **TOTP encryption key** (`data/totp.key`, or `OWNCORD_TOTP_KEY`):
  - It is generated only when the server confirms it is absent.
  - Any other read error stops the server from starting. Replacing the key
    would orphan every stored secret.
  - The key is written atomically.
  - Back it up next to the database. A backup does not contain it.
- **Erasure marker key** (`data/erasure.key`, or `OWNCORD_ERASURE_KEY`)
  follows the same rules: generated only when confirmed absent, any other read
  error stops the start-up, atomic write.
  - Deletion markers in `data/erasure/markers.sqlite` name erased accounts
    only as an HMAC under this key.
  - Back up both next to the database. If a restore is missing them, the
    server cannot recognise an account the backup brings back, and so cannot
    erase it again.

**Server-wide rules and limits**

- Admins can require 2FA for everyone with the `require_2fa` setting in the
  admin panel.
- `require_2fa` needs every user to have 2FA turned on, and needs
  `registration_mode` to be `closed`. While it is on, registration cannot be
  reopened.
- **Session expiry:**
  - A session expires 30 days after it was last used.
  - An authenticated REST request, the WebSocket handshake and the WebSocket
    heartbeat each extend `expires_at`. This happens at most once a minute per
    session, and the write is batched up to a minute later.
    [schema.md](schema.md#sessions) owns the exact bound and its edge case.
  - A session never lives more than 365 days from sign-in.
  - Use never revives a session that has already expired or been revoked.
- The login flow returns `requires_2fa: true` with a `partial_token`. That
  token lasts 10 minutes and allows 5 attempts.
- Auth challenges are rate-limited to 10 requests per minute per IP address.
- **Password-hashing budget:**
  - Every bcrypt computation on an authentication route goes through one
    process-wide limit (`security.expensive_auth_concurrency`, default twice
    the CPU core count). This covers password checks and hashes, and
    recovery-code matching.
  - Login, registration, first-run setup and recovery-code checks over that
    limit wait in a bounded first-in, first-out queue for up to 10 seconds.
  - A refused attempt gets `429 AUTH_BUSY`. That happens when the queue is
    full, the wait runs out, or a password confirmation is over the limit. A
    refused attempt runs no bcrypt and does not count as a failed attempt.
- TOTP codes are compared in constant time (`subtle.ConstantTimeCompare`). This
  prevents timing side-channel attacks.

## Account Recovery

**The recovery kit** is a secret the account holder keeps offline. The server
stores only an argon2id verifier of it.

- The setup wizard offers to create the owner's kit at first run. It is shown
  once, on the finish step, and only its verifier is stored.
- Any account can enrol or replace a kit from the desktop client while signed
  in.
- Redeeming the kit, in one transaction:
  - replaces the password;
  - revokes every session and API token;
  - uses up the kit;
  - writes an audit row with no content;
  - then signs the holder in without the second factor. The kit exists for
    when the holder's devices are gone.
- A used or lost kit cannot be recovered by the server. The holder issues a new
  one while signed in.
- Five failed attempts lock recovery for 15 minutes.

See [docs/trust-model.md](trust-model.md).

**Owner-assisted recovery.** Only the server owner, or a member holding the
Issue Recovery permission, can issue a recovery credential. A holder can do so
only for members ranked below them, and not for an account carrying an
owner-level permission the holder lacks.

- The owner first checks the person's identity outside OwnCord, and records
  how, as one of four fixed values: `in_person`, `voice_call`, `video_call`
  or `trusted_contact`. No free text is accepted.
- The credential works once, expires in 15 minutes, and is stored only as an
  argon2id verifier.
- It redeems through the same route, with the same results: a new password,
  every session and API token revoked, and no second factor.
- No administrator below the owner can reset anyone's credentials.
- Issuing and using it are audited (`recovery_assist_issued`,
  `recovery_assist_used`).

## Account Deletion

Users can delete their own account with `DELETE /api/v1/auth/account`, which
needs their password. The last admin account cannot be deleted. After 3 failed
password attempts, the endpoint locks for 15 minutes.

## First-run setup

**The setup token.** While setup is open, the server prints a one-time
**setup token** in its start-up output, next to the banner.
`POST /admin/api/setup` refuses any request that does not carry it.

- Why it is needed: the admin IP allowlist checks the connecting address.
  Behind a reverse proxy on the same host, or a container port relay, with
  `server.trusted_proxies` empty, every request looks local. The token makes
  sure that creating the Owner account still needs access to the server's own
  console.
- The token is written to stderr only, never to the log stream.
- A new token is created at every start.

**Single-use download links.** The full-archive download uses the same
single-use pattern as the log stream.

- The owner asks for a link (`POST /admin/api/archive/link`) with normal
  authentication. The browser then opens the returned URL as a plain download,
  so a large archive is never held in the page.
- The link token is 32 random bytes. It is bound to the owner who asked for
  it, works once, lasts about a minute, and is never written to a log or audit
  row.
- Like the log-stream ticket, it stores the hash of the credential that asked
  for it, and checks it again when used. So a revoked session, a ban or a lost
  Owner role cancels an unused link.
- An unknown, expired, used or cancelled token always gets the same `403`.
- Downloading a single backup from the panel works the same way
  (`POST /admin/api/backups/{name}/link`). That token is also bound to the one
  file and kept in a separate store. So an archive token opens no backup, and
  a backup token opens neither the archive nor another backup.

**The `setup_completed` flag.** `POST /admin/api/setup` needs no login,
because it is how the first Owner account is created. Until account erasure
existed, the only thing guarding it was "no users exist". Erasure can now
empty the users table:

- the administrator erases the last account; or
- a deletion marker is replayed against a restored backup whose only user is
  the erased owner (the replay does not apply the last-admin guard).

So the user count is no longer the gate. The `setup_completed` setting is
(migration 043). It is written in the same transaction as the first Owner and
the server never clears it. An emptied users table therefore leaves setup
closed, rather than open to the first caller on an allowed network.

A server upgrading into migration 043 is judged the same way. Setup closes if
any of these exist:

- a live user;
- an `erasure_jobs` row;
- a `server_setup`, `account_deleted` or `account_erasure_replayed` audit row.

So a server whose users table was already emptied before the upgrade closes
too, instead of looking fresh. Only those three audit actions count, not any
audit row. A server that was never set up still writes `backup_create` from
the scheduled-backup loop, and closing setup on that would block its own
first run.

**Reopening a locked server.** A server with no accounts and the flag set is
locked on purpose. Reopening it is an operator action that needs filesystem
access to the database, not a network action:

```sql
UPDATE settings SET value = '0' WHERE key = 'setup_completed';
```

The server prints the setup token only at start-up, and only while setup is
open. So **restart the server after this change**. It then prints a fresh
one-time token next to the banner. The next `POST /admin/api/setup` that
carries it creates a new Owner and sets the flag again. A running server does
not print a token when setup is reopened, so restart it rather than reuse a
token from an earlier start.

**Which values open setup.** `0` is the only _value_ that opens setup. The gate
guards an endpoint with no login, so any other value (corrupted, or
hand-edited to something the server does not know) counts as closed.

A missing row is the one exception. Every database from before migration 043
looks like that, so there the user count decides, and a server that was truly
never set up can still run its wizard. The migration writes the row on every
upgrade. After that, the row is missing only if something removed it, and
removing it needs the same write access to the database file as setting it to
`0`.

**Restores.** The flag lives in the database, so a restore rolls it back with
everything else. That includes a backup taken before the server was ever set
up, which the scheduled-backup loop may well have made.

The deletion markers close that gap. They live outside the database. An
account marker proves an account existed here and was erased. So at start-up,
the replay closes the flag whenever the marker file holds an account marker,
whatever the restored database says. A marker file with only retention markers
leaves a truly fresh server alone.

The `setup_completed` key is deliberately not in the settings PATCH allowlist.
No logged-in route can write it. Only the operator can, with access to the
database file.

### Erasure marker sequence floors

A deletion marker names its subject by a one-way token. The id behind that
token must never be handed out again. If a new account got that id, it would
hash to the old marker and be erased at the next start-up.

`sequence_floors` in the marker file holds the id counters that prevent this,
and every new marker records its own. A marker file from before those floors
existed records none. So the first start-up after the upgrade recovers them: it
hashes candidate ids against the markers' tokens until every marker is matched.
It then records the recovery in `floor_probes`, so later start-ups skip it.

**When the server refuses to start.** A marker may name an id beyond the
probe's reach (`SequenceFloorProbeCeiling`, 16,777,216, which is past any real
id space). Then no floor can be proven safe. The server refuses to start rather
than run with a floor that only looks safe. The log names the two statements
that fix it.

Only the operator can fix it, because only they know the highest id their
server ever handed out. Run both statements against the **marker file**
(`data/erasure/markers.sqlite`), not the main database:

```sql
INSERT INTO sequence_floors (name, seq) VALUES ('users', <highest id ever handed out>)
  ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq);
INSERT OR IGNORE INTO floor_probes (name) VALUES ('users');
```

The second statement is the acknowledgement. It records that the floor is
settled, so the next start-up uses it instead of probing again. Use
`'channels'` in place of `'users'` when the refusal names that table.

### Erasure marker key

A marker names its subject by an HMAC of the id under `data/erasure.key`. So
the markers only make sense under the key they were written with.

Under a different key, every token would miss. That happens with a key
regenerated after the file was lost, or with `OWNCORD_ERASURE_KEY` pointing
somewhere else. The start-up replay would then erase nothing, report success,
and leave a restored backup's erased accounts in service.

To prevent this, the marker file records an `erasure-key-fingerprint` in
`marker_meta`. It is an HMAC of a fixed label under the key. The key itself is
never in the file. The server refuses to start on a key that does not match.

There are two refusals, and both are the operator's to fix. The log names the
statement for each. Run them against the **marker file**
(`data/erasure/markers.sqlite`), not the main database:

- **The file records a different key.** Put the original `erasure.key` back.
  The log prints the first 12 hex characters of both fingerprints, so you can
  tell which backup holds it. Only if that key is gone for good, and you accept
  that the markers can no longer match, point the file at the running key:

  ```sql
  UPDATE marker_meta SET value = '<running key fingerprint from the log>'
    WHERE name = 'erasure-key-fingerprint';
  ```

- **The file holds markers but no fingerprint.** It was written before the key
  was bound to the file. The server will not adopt a key it cannot prove,
  because adopting the wrong one is the silent failure described above. Check
  that the running key is the one those markers were written under, then
  approve the file:

  ```sql
  INSERT INTO marker_meta (name, value)
    VALUES ('erasure-key-fingerprint', '<running key fingerprint from the log>');
  ```

Deleting or moving `markers.sqlite` is not a way past either refusal. The file
also holds:

- `sequence_floors`. Without them, an erased account's id is handed out again,
  and its innocent new holder is erased by the old marker at a later start-up.
- the account markers that keep the first-run setup gate closed against a
  restore of a backup from before the owner existed.

## Diagnostics and Telemetry

OwnCord sends no automatic product or usage telemetry.

Every diagnostic feature stays on the machine: the health probe, connectivity
diagnostics, metrics, logs, the audit log and backups. Every outbound network
connection the server makes is one of these:

- an action an admin or user took;
- a feature an operator turned on in the configuration;
- a connection to this machine itself.

[docs/architecture/diagnostics.md](architecture/diagnostics.md) has the details:

- the list of outbound connections;
- the `egress-sites` invariant that enforces it;
- the runtime capture proving the built-in defaults open nothing beyond
  loopback;
- the data rules the support bundle follows.

How an administrator makes a support bundle, and what it holds, is in the
Deployment Guide's [Support bundle](deployment.md#support-bundle) section.

## Audit Logging

Security-relevant actions are recorded in the `audit_log` table, with actor,
action, target and detail:

- **Auth:** `user_register`, `user_login`, `user_logout`, `login_blocked_banned`, `account_deleted`, `password_change`, `session_revoke`, `session_revoke_all`, `recovery_kit_issued`, `recovery_kit_used`, `recovery_kit_locked`, `recovery_assist_used`, `account_erasure_replayed`
- **2FA:** `totp_enabled`, `totp_verified`, `totp_disabled`, `recovery_codes_regenerated`
- **Admin:** `role_change`, `role_add`, `role_remove`, `role_create`, `role_update`, `role_delete`, `role_reorder`, `user_ban`, `user_unban`, `force_logout`, `setting_change`, `server_setup`, `api_token_create`, `api_token_revoke`, `config_write`, `config_override_change`, `invite_create`, `invite_revoke`, `registration_mode_change`, `registration_approve`, `registration_deny`, `recovery_assist_issued`, `plugin_install`, `plugin_uninstall`, `retention_policy_change`, `channel_retention_change`, `permission_explain`, `permission_preview`
- **Content:** `channel_create`, `channel_update`, `channel_delete`, `channel_perms_update`, `channel_perms_clear`, `channel_user_perms_update`, `channel_user_perms_clear`, `message_delete`, `message_purge`, `emoji_create`, `emoji_delete`, `sticker_create`, `sticker_update`, `sticker_delete`
- **Voice moderation:** `voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move`, `voice_mod_kick`
- **Profile:** `profile_update`, `identity_key_update`
- **Ops:** `backup_create`, `backup_delete`, `backup_restore`, `backup_archive`, `archive_link`, `backup_link`, `backup_download`,
  `log_level_debug_on`, `log_level_reverted`, `update_apply`, `update_applied`,
  `update_failed`, `server_restart_requested`, `ws_connect`

**Audit rows about an erased account.** Erasure unlinks them
(`Server/db/erasure.go`, `erasureUnlinkPrincipalRows`):

- Each row keeps its action, time and order.
- `actor_id` and `target_id` become 0, and `detail` is cleared.
- The deletion marker's token takes the id's place. The token is an
  HMAC-SHA256 of the user id under `data/erasure.key`. It goes in
  `subject_token` where the erased user was the target, and in `actor_token`
  where they acted.
- The same token replaces the id in the report, report-note, report-event,
  moderation-action and appeal rows that name them.

What this means:

- A row that names two erased users keeps both tokens.
- Rows about one user stay linkable to each other for anyone allowed to read
  them, any `VIEW_AUDIT_LOG` holder included.
- The trail identifies the person again only for whoever holds `erasure.key`.
  (That is the erasure-key holder, not the voice key holder from the E2EE
  section.)

Two things the token does not cover:

- The `erasure_jobs` row names the user by their plain user id and is never
  pruned (an owner decision). Whoever may read it knows the identity without
  the key.
- Free text the erased account wrote while moderating others
  (`report_notes.body`, `moderation_actions.reason`, `appeals.decision_note`)
  is unlinked but not cleared.

The erasure's own `account_deleted` row is written in the unlinked form from
the start. `account_erasure_replayed` records a start-up that erased a restored
backup's copy of the account again.

Note: `backup_restore` is written to the live database _before_ the
pre-restore safety copy is taken. So the row survives inside the
`pre_restore_*.db` backup. The restored database itself will not contain it,
because the restore replaces the database file completely.

## Client Security Hardening

The Tauri desktop client uses the following security measures.

### Credential Storage

- **Where credentials are kept.** Credentials are stored in the OS keyring
  (Windows Credential Manager, macOS Keychain or Secret Service) through the
  `keyring` crate. Every write is read back and checked. If no keyring is
  available, they fall back to an encrypted file: Windows DPAPI with
  `CRYPTPROTECT_UI_FORBIDDEN`, or ChaCha20-Poly1305 elsewhere. See
  [credential-storage.md](credential-storage.md).
- **Passwords never reach the frontend.** Plaintext passwords are **never**
  returned to the frontend over IPC. Only tokens are visible to JavaScript.
  The field is `#[serde(skip)]` on `CredentialData`, and a test locks this in
  (`credential_data_never_serializes_the_password`). A remembered password is
  shown in the login form as a placeholder. The `login_with_saved_password`
  command reads the password in Rust and logs in through the same pinned
  loopback proxy a normal request uses.
- **Auto-login uses tokens.** It uses stored tokens to reconnect, not
  passwords.
- **Commands are scoped to the active host.** Credential and identity commands
  only act on the active session host, which Rust holds in its state.
  - That host is set only when the proxy relays the server's `auth_ok` over the
    pinned socket, never by a renderer command. It is cleared when that
    connection ends, or on `ws_disconnect`.
  - The relayed `auth_ok` also records every host a login was verified for
    during this app run. That set survives a disconnect and a credential
    removal.
  - While no session is active, the connect-page credential prefill, stored
    token resume and saved-password login work only for a host in that set,
    never for another saved host.
  - Before any login has been verified in this app run, the set is empty and
    the first-run behaviour applies. So a restart can still auto-login from a
    saved credential.
  - The pending-message commands (unsent message text) act on the active
    host, or while no session is active on a host in that set. They never
    skip the set, even before the first verified login.

### Tauri Capabilities (Least Privilege)

- **Filesystem access is limited to `$APPLOG`.** The renderer reads and writes
  its own logs there. Every other save from the frontend goes through the
  native save dialog, and the dialog plugin grants the chosen path on the fly.
  `$APPDATA` is deliberately out of scope. It holds `credential_fallback.json`
  and `.key`, `certs.json` and `identity_pins.json`, so a renderer compromise
  could otherwise read the fallback credential store or the TLS and identity
  pins. `fs:default` (whose recursive read covers `$APPDATA`) and the old
  `$APPDATA/**` write scope were removed for this reason.
- **DevTools are off in release builds.** The DevTools command is behind the
  `devtools` feature flag, which release builds leave out.
- **HTTP fetch reaches only loopback.** It is restricted to
  `http://127.0.0.1:*`, the Rust TOFU proxies' loopback tunnels. No `https://`
  destination is allowed at all. As a second layer of defence, it still
  **denies** `https://localhost[:*]` and `https://127.0.0.1[:*]`, in case a
  wildcard ever comes back.
- **Only `http:allow-fetch` carries a URL scope.** `tauri-plugin-http` checks
  the URL once, in the `fetch` command. `fetch_send` and `fetch_read_body` work
  on an already-checked `ResourceId` and never look at a scope. So `allow` and
  `deny` blocks on those identifiers would do nothing. They were removed
  rather than left in place looking like a control that does not exist.
- **No `https://*` wildcard.** Link previews, external images, GIFs and
  external avatars are fetched by the native external-content broker
  (`src-tauri/src/external_content.rs`), and the CSP `img-src` no longer
  allows `https:`. The broker's policy is in [trust-model.md](trust-model.md),
  section "Desktop preview destination policy (C-09)".
- **CSP `connect-src` allows only local targets.** It allows `'self'`, IPC and
  loopback `http:` and `ws:` (`localhost`, `127.0.0.1`). There is no `https:`
  or `wss:` source, so a compromised renderer's own `fetch` or `WebSocket`
  cannot reach a remote host.
  - REST and the chat socket go through IPC. LiveKit goes through the loopback
    TOFU tunnel.
  - A local server's LiveKit `direct_url` is used as-is only when it is a
    loopback `ws:` or `http:` address. This rule is the same on every platform,
    Linux native voice included.
  - Anything else is tunnelled like a remote server's
    (`src/platform/desktop/nativeProxies.ts`). That covers LiveKit Cloud, a TLS
    LiveKit elsewhere, or a compose-internal name like `ws://livekit:7880` that
    does not resolve on the host.
- **Regression tests guard all of this:** `tests/unit/capabilities-scope.test.ts`
  and `tests/unit/tauri-conf-csp.test.ts`. The original reasoning is in
  [docs/plans/tauri-capability-narrowing.md](plans/tauri-capability-narrowing.md).

### TLS and Certificate Pinning (TOFU)

- Self-signed certificates are supported through Trust-On-First-Use (TOFU)
  pinning: the client remembers the certificate the first time it connects.
- The WebSocket proxy (`ws_proxy`) pins the server certificate fingerprint on
  first connection.
- The HTTP proxy (`http_proxy`), which carries REST traffic, pins against the
  same store.
- The LiveKit proxy (`livekit_proxy`) reuses the pinned fingerprint from the
  WebSocket proxy.
- All three native tunnels share one TOFU module and one pin store. The
  WebSocket and HTTP tunnels pin on first use. The LiveKit tunnel only checks
  an existing pin. See [trust-model.md](trust-model.md).
- **A certificate mismatch opens a modal** that the user must acknowledge.
  Saving a pin that changes what is trusted also needs a native OS
  confirmation dialog, in `accept_cert_fingerprint`. That command is the only
  user-confirmed writer of a pin, and its dialog names the host and
  fingerprint. So a renderer compromise cannot silently pin a host. The
  artifact smoke test seeds the pin in the profile instead of answering the
  dialog. Test-only builds use the `e2e-auto-confirm` feature, which no shipped
  build turns on.
- **On first contact, compare the fingerprint over another channel.** The
  trust decision rests on the fingerprint. Read it from the server's start-up
  banner (it is also on the admin Dashboard and the setup wizard's finish
  step). Compare it with the prompt, character for character, over a channel
  the server is not part of. The client cannot tell a wrong fingerprint from
  an interception attempt, so accepting a mismatch is the same as accepting an
  interception. The same rule applies when a certificate changes and every
  client shows the mismatch prompt again. (A routine public-CA renewal is
  re-pinned without a prompt.) See [trust-model.md](trust-model.md) and
  [Rotating the self-signed certificate](deployment.md#rotating-the-self-signed-certificate).
- Update downloads check that `server_url` uses `https://`, and reject URLs
  that contain a username or password (userinfo).

### Input Validation

- IPC commands check host format, string lengths and allowed characters.
- Push-to-talk virtual key codes are checked against the Win32 range (1–254).
- The LiveKit proxy's `remote_host` is checked for CRLF injection.
- The API client checks the host format before building URLs.
- **File uploads** accept any type the server's file-type policy allows.
  - The composer checks the size and the policy before sending.
  - The server detects the real type from the content, refuses executables by
    content, and refuses blocked final extensions by name.
  - By default the blocked extensions are Windows scripts, installers and disk
    images. The owner can change the list in `config.yaml` and the admin panel
    (see [SECURITY.md](../SECURITY.md)).
- Error messages from server responses are capped at 200 characters.
- Notification titles are cleaned: control characters are stripped and the
  length is capped.

### XSS Prevention

- All user-generated content is rendered with `textContent` or `setText`,
  never `innerHTML`.
- The single `innerHTML` use (SVG icons) works on compile-time constants, with
  a runtime guard.
- URLs are checked with `isSafeUrl`, which rejects `javascript:`, `data:` and
  `vbscript:`.
- YouTube embeds use the `sandbox` attribute on iframes.
- `image/svg+xml` is not one of the safe MIME types a fetched server image or
  clip may carry as its Blob type.
- GIF media URLs are checked against the trusted Klipy CDN origins.
- Linkified URLs drop trailing punctuation, so the destination is not
  misleading.

### Search and Rate Limiting

- Client-side search requests are rate-limited: at least 500 ms between
  requests, plus a 300 ms debounce.

## Known Limitations

[known-limitations.md](known-limitations.md) is the operator-facing list of
what the beta does not do: certificate lifecycle and pin-break prompts,
first-run defaults, owner lockout, restore and health limits, and unsigned
Windows installers. This section lists only the security-relevant items.

- Server auto-updates depend on a dedicated, pinned minisign/Ed25519 server
  release key in
  [Server/updater/server_update_public_key.txt](../Server/updater/server_update_public_key.txt).
  They also depend on a signed release manifest that ties the shipped binary's
  hash to the release version. Windows Authenticode and SmartScreen code
  signing is separate work that is not done yet.

## Security Hardening Checklist for Operators

- [ ] Turn on TLS. Self-signed is the default; your own certificates are
      recommended for production.
- [ ] Capture stdout (journald, the Docker log driver, or NSSM `AppStdout`), so
      a crash leaves something to send. See
      [deployment.md — Logs](deployment.md#logs).
- [ ] Back up the whole set of files, not just the database. See
      [deployment.md — Backup Strategy](deployment.md#backup-strategy).
- [ ] Keep registration invite-only (the default) or closed. `approval` holds
      new accounts until you approve them in the admin panel. `open` lets
      anyone in.
- [ ] Set a strong admin password.
- [ ] Review the rate limits. The defaults are sensible, but check them for
      your use.
- [ ] Run regular backups from the admin panel.
- [ ] Keep the server updated. The admin panel shows available updates.
- [ ] Firewall:
  - expose port 8443 (HTTPS);
  - for voice and video, also expose 7881/TCP (LiveKit's TCP fallback) and the
    media UDP ports: `50000-60000` by default, or a single `voice.udp_port`.
    See [deployment.md](deployment.md);
  - expose port 80 only when you use ACME;
  - do not expose 7880 (LiveKit's own API). OwnCord clients tunnel signalling
    through `/livekit` on 8443.
- [ ] Require 2FA server-wide once all users have enrolled.
- [ ] Set `admin_allowed_cidrs` to limit admin panel access to trusted
      networks. Two areas are not covered by it, because they need a session
      or token issued by this server:
  - member moderation at `/api/v1/moderation/members`, which also needs the
    permission and rank checks;
  - channel create, edit and delete at `/api/v1/moderation/channels`, which
    also needs `MANAGE_CHANNELS`.

Background: the emergency recovery codes trace to requirement BPR-046, and
the no-telemetry rule to BPR-055. The recovery kit,
owner-assisted recovery, account erasure and the removal of the `https://*`
wildcard were delivered as work packages B4-5, B4-6, B4-10 and B7-16. The
`erasure_jobs` retention is owner decision B6-15/3.
