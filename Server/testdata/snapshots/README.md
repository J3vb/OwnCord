# Alpha snapshots

This folder holds a test database shaped like a real older install. Read this
before you use it in a test or regenerate it.

`v1.2.0-alpha.4.sqlite` is an anonymised, deterministic database snapshot. It
looks like a real `v1.2.0-alpha.4` install after a month of use, at rest
between sessions. Its schema is the alpha.4 migration set: 31 applied
migrations, unchanged since that tag. So opening it with a newer server is a
genuine in-place upgrade.

## Who uses it

Tests work on a copy, never on the tracked file, so the committed file never
changes. Most get their copy from `Server/internal/alphasnap`. The canary makes
its own.

- **The standing canary:** `Server/db/alpha_snapshot_test.go`. Every `go test`
  run opens a copy, applies the current migrations, and checks the row counts.
- **Recovery and erasure drills:** `Server/db/hp4_drills_test.go` runs
  identity, recovery and deletion rehearsals against realistic data.
- **Destructive service tests:** `Server/service/erasure_test.go` and
  `Server/service/retention_test.go`.

The release plans also name it as the input for the alpha-to-beta in-place
upgrade test.

## What is in it

- **Users:** 100 (1 owner, 2 admins, 5 moderators, 92 members).
- **Channels:** 12 (10 text and 2 voice). 3 have role overrides, 2 have user
  overrides, and 1 is archived.
- **Messages:** 20,000 over 30 simulated days, following a day-and-night
  pattern. 15% are in DMs, across 40 DM pairs.
- **Attachments:** 300 rows, between 10 KB and 5 MB. 60% image, 10% audio,
  10% video, 20% other.
- **Other:** 500 reactions, 30 invites (10 revoked), and 1 disabled plugin row.

The numbers are constants in `Server/cmd/seed/profile_alpha.go`. If a number
turns out to be unrealistic, change it there and record the reason in the
evidence block of the plan item that owns this dataset. Never change it
silently.

Two constants deliberately produce no rows. Voice sessions are short-lived in
LiveKit, and the replay log is empty, as on any server restarted for an
upgrade. The profile's package comment explains why.

Every account's password is `alpha-dev-password`.

Attachment rows are metadata only. The files themselves are not part of a
database snapshot. So attachment downloads return 404 unless a test seeds a
matching uploads folder.

## Regenerating

```bash
cd Server
go run ./cmd/seed -confirm-dev -profile alpha \
  -db /tmp/alpha-fresh.db \
  -snapshot testdata/snapshots/v1.2.0-alpha.4.sqlite \
  -scrub testdata/snapshots/scrub.sql
```

The output is byte-for-byte reproducible. `TestAlphaProfileByteIdentical`
checks that.

Regenerate only on purpose. On a newer migration set the snapshot stops being
an alpha.4 artifact. Then `alphaSnapshotMigrations` in the canary must change
with it, and the change must be recorded in the plan item's evidence block.

## The scrub script

`scrub.sql` removes identities and credentials: usernames, profiles, secrets,
sessions, tokens, invite codes, audit detail, filenames, and wall-clock
migration timestamps.

It deliberately does not touch message content or channel names. Those are
synthetic here, but on a real database they need a human judgement call. So a
donated production database is **not** safe to share after this script alone.
Clear or rewrite its content (and rebuild the full-text search index) first,
or refuse the donation.

Background: the dataset is plan item B3-7. The drills are HP-4, and the
upgrade-test consumers named in the plans are B6 (upgrade rehearsal) and B10
(in-place upgrade, roadmap item 4).
