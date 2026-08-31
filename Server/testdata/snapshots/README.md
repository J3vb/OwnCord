# Alpha snapshots

`v1.2.0-alpha.4.sqlite` is the anonymised, deterministic database snapshot the
B3-7 plan item promises: a server shaped like a real `v1.2.0-alpha.4` install
after a month of use, at rest between sessions. The schema is the alpha.4
migration set (31 applied migrations — unchanged since the tag), so opening it
with a newer server is a genuine in-place upgrade.

## Consumers

- **B4 — HP-4 drills**: identity/recovery/deletion rehearsals against
  realistic data.
- **B6 — upgrade rehearsal**: the deployment qualification's alpha→beta
  in-place upgrade input.
- **B10 — in-place upgrade**: the release candidate's required upgrade test
  (roadmap B10 item 4).
- `Server/db/alpha_snapshot_test.go` is the standing canary: every `go test`
  run opens a copy, applies HEAD's migrations, and checks the row counts.

## Shape

100 users (1 owner / 2 admins / 5 moderators / 92 members), 12 channels
(10 text + 2 voice; 3 with role overrides, 2 with user overrides, 1 archived),
20,000 messages over 30 simulated days on a diurnal curve (15% in DMs across
40 DM pairs), 300 attachment rows (60/10/10/20% image/audio/video/other,
10 KB–5 MB), 500 reactions, 30 invites (10 revoked), 1 disabled plugin row.
The numbers live as constants in `Server/cmd/seed/profile_alpha.go`; a number
found unrepresentative is changed there with the reason recorded in the B3-7
evidence block — never silently. Two constants deliberately leave no rows
(voice sessions are LiveKit-ephemeral; the replay log is empty as on any
server restarted for an upgrade) — the profile's package comment records why.

Every account's password is `alpha-dev-password`. Attachment rows are
metadata only — the files themselves are not part of a database snapshot, so
attachment downloads 404 until B6's rehearsal seeds an uploads directory to
match.

## Regenerating

```bash
cd Server
go run ./cmd/seed -confirm-dev -profile alpha \
  -db /tmp/alpha-fresh.db \
  -snapshot testdata/snapshots/v1.2.0-alpha.4.sqlite \
  -scrub testdata/snapshots/scrub.sql
```

The output is byte-for-byte reproducible (`TestAlphaProfileByteIdentical`
holds the property); regenerate only deliberately — on a newer migration set
the snapshot stops being an alpha.4 artifact, `alphaSnapshotMigrations` in
the canary must move with it, and the change belongs in the B3-7 evidence
block.

`scrub.sql` is the identity scrub, written so it can also anonymise a real
donated alpha database: usernames, profiles, secrets, sessions, tokens,
invite codes, audit detail, filenames and wall-clock migration timestamps.
