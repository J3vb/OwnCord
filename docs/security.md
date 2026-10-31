# Security for server owners

How to keep your server and your members' accounts safe. Found a security
problem? Report it privately: see [SECURITY.md](../SECURITY.md). Never in a
public issue.

People who change the code want the [security model](security-model.md)
instead.

## What you, the owner, can read

You can read text chat, direct messages and files, because the server stores
them. Calls (voice, video and screen share) are end-to-end encrypted, so you
cannot listen in. The full picture: [trust-model.md](trust-model.md).

OwnCord sends no telemetry. The server only connects out for things you or
your members ask for, such as update checks.

## Security Hardening Checklist for Operators

- [ ] **Keep TLS on.** The default certificate works. For a public domain, see
      [TLS and reverse proxies](hosting/tls-and-proxy.md). Never run with TLS
      off unless a proxy does HTTPS in front.
- [ ] **Keep registration invite only** (the default) or closed. `approval`
      holds new accounts until you say yes. `open` lets anyone in.
- [ ] **Use a strong Owner password** and turn on two-factor sign-in for your
      own account.
- [ ] **Save your recovery kit** somewhere offline.
- [ ] **Back up the whole data folder**, not just the database:
      [Backups and restore](hosting/backups.md).
- [ ] **Keep the log** (journald, Docker logs, or NSSM's `AppStdout`), so a
      crash leaves something to look at: [Monitoring](hosting/monitoring.md#logs).
- [ ] **Keep the server updated.** The admin panel shows new releases.
- [ ] **Open only the ports you need:** `8443/TCP`, and for voice `7881/TCP`
      plus the UDP media port. `80/TCP` only for built-in Let's Encrypt. Never
      `7880`.
- [ ] **Limit the admin panel** to trusted networks with
      `server.admin_allowed_cidrs`. (Moderation and channel edits from the app
      still work from anywhere, for members with the right role.)
- [ ] **Require two-factor sign-in for everyone** once all members have set it
      up (admin panel, `require_2fa`).

## Accounts

### Two-factor sign-in

Members turn it on in **Settings → Account** with an authenticator app. They
get ten one-time recovery codes. Each works once instead of an app code.

You can require it for everyone with `require_2fa` in the admin panel. That
needs every member to have it on, and registration set to closed.

**Keep `data/totp.key` safe.** It unlocks every member's two-factor secret. If
it is lost, everyone with two-factor sign-in is locked out and nothing can
reset it. It is not in a database backup: back up the whole `data/` folder.

### Sessions

A sign-in lasts 30 days after last use, and never more than a year. Members
can see and end their sessions in **Settings**.

### Recovery kit

The recovery kit is a secret each member can keep offline. It lets them back in
when they have lost their password and their devices. Using it sets a new
password, signs out every device and is used up. The setup wizard makes yours;
members make theirs in **Settings**. Five wrong tries lock it for 15 minutes.

### Helping a member who is locked out

Only you (or a member with the **Issue Recovery** permission) can issue a
one-time recovery code for someone ranked below you. First check who they are
outside OwnCord, in person, by voice or video call, or through a trusted
contact, and record which. The code works once and expires in 15 minutes.
Nobody else can reset another person's password.

### Deleting an account

Members delete their own account in **Settings**, with their password. The last
admin cannot be deleted. A deleted account stays deleted, even after you
restore an older backup, as long as you restore the whole `data/` folder.

## First-run setup

While setup is open, the server prints a one-time **setup token** at start-up.
The setup wizard needs it, so only someone who can see the server's console can
create the Owner account. A new token is printed at every start. It never goes
into the log.

Once setup is done it stays closed, even if every account is later deleted.

### Reopening a locked server

A server with no accounts left is locked on purpose. To reopen it, you need
direct access to the database file. Stop the server, then run against
`data/chatserver.db`:

```sql
UPDATE settings SET value = '0' WHERE key = 'setup_completed';
```

Start the server again. It prints a fresh setup token for the wizard.

## Erasure marker key

When an account is deleted, the server keeps a small deletion record in
`data/erasure/markers.sqlite`, locked with `data/erasure.key`. After a restore,
it uses these to delete that account again. Keep both files with your backups.

The server refuses to start if the two do not belong together. The log says
which case it is and prints the exact fix. Run the fix against
`data/erasure/markers.sqlite`, **not** the main database.

- **"The file records a different key."** Put the original `erasure.key` back
  from your backup. The log shows the start of both key fingerprints so you can
  find the right one. Only if that key is gone for good:

  ```sql
  UPDATE marker_meta SET value = '<running key fingerprint from the log>'
    WHERE name = 'erasure-key-fingerprint';
  ```

- **"The file holds markers but no fingerprint."** An older file. Check the
  running key is the one it was written with, then approve it:

  ```sql
  INSERT INTO marker_meta (name, value)
    VALUES ('erasure-key-fingerprint', '<running key fingerprint from the log>');
  ```

- **"No floor can be proven safe" (sequence floors).** Very rare. Set the
  highest user (or channel) number your server ever handed out:

  ```sql
  INSERT INTO sequence_floors (name, seq) VALUES ('users', <highest id ever handed out>)
    ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq);
  INSERT OR IGNORE INTO floor_probes (name) VALUES ('users');
  ```

  Use `'channels'` instead of `'users'` when the log names channels.

Deleting `markers.sqlite` does not get you past any of these. It would let
deleted accounts come back, and could even delete a new member by mistake.

## Audit log

The admin panel's **Audit log** records who did what: sign-ins, role and
permission changes, bans, setting changes, backups, restores and updates.
Passwords, keys and message text are never in it. When an account is deleted,
its entries stay but no longer name the person.

The full list of recorded actions is in the
[security model](security-model.md#audit-log-in-detail).

## Secrets you set in the admin panel

The GIF key, the GitHub token and the voice key and secret are write-only. The
panel only shows whether they are set. They are saved in
`data/config-overrides.json`, so treat that file like a password and keep it in
your backups.

## Known Limitations

- **Windows files are not code-signed yet**, so SmartScreen warns. Updates are
  still checked with OwnCord's own signature.
- **Text chat is not end-to-end encrypted.** See
  [trust-model.md](trust-model.md).
- The full list of what the beta does not do:
  [known-limitations.md](known-limitations.md).
