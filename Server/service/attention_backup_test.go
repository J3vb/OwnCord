package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// withArchive adds the full-archive and disk sources to the attention fixture.
func withArchive(f *attentionFixture, r *BackupArchiveReading, d *BackupDiskReading) {
	src := f.s.src
	if r != nil {
		src.BackupArchive = func(context.Context) (BackupArchiveReading, error) { return *r, nil }
	}
	if d != nil {
		src.BackupDisk = func(context.Context) (BackupDiskReading, error) { return *d, nil }
	}
	f.s.src = src
}

func TestAttention_BackupScopeSignal(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, schedule, scope string
		want                  string
	}{
		{"unset with a schedule", "daily", BackupScopeUnset, AttentionStatusWarning},
		{"unset with the schedule off", "off", BackupScopeUnset, AttentionStatusOK},
		{"database chosen", "daily", BackupScopeDatabase, AttentionStatusOK},
		{"everything chosen", "daily", BackupScopeEverything, AttentionStatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAttentionFixture(t)
			f.schedule = tc.schedule
			withArchive(f, &BackupArchiveReading{Scope: tc.scope}, nil)
			rep := f.step()
			wantStatus(t, rep, "backup_scope", tc.want)
			w := warning(rep, "backup_scope")
			if tc.want == AttentionStatusWarning {
				if w == nil || w.Title != "Automatic backups leave out uploads and key files" ||
					!strings.Contains(w.Action, "choose Everything") {
					t.Errorf("warning = %+v", w)
				}
			}
		})
	}
}

// Neither hint is a reason to wake the owner.
func TestAttention_BackupHintsAreNeverPushed(t *testing.T) {
	t.Parallel()
	for _, id := range []string{attentionBackupScopeSignal, attentionBackupDiskSignal} {
		if attentionPushSignals[id] {
			t.Errorf("%s is pushed to the owner", id)
		}
	}
}

func TestAttention_BackupDiskSignal(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		r    BackupDiskReading
		want string
	}{
		{"shared", BackupDiskReading{Dir: "/srv/data/backups", With: "/srv/data", Shared: true}, AttentionStatusWarning},
		{"shared but confirmed", BackupDiskReading{Dir: "/srv/data/backups", With: "/srv/data", Shared: true, Acked: true}, AttentionStatusOK},
		{"not detected", BackupDiskReading{Dir: "/mnt/backups"}, AttentionStatusOK},
		{"could not check", BackupDiskReading{Dir: "/mnt/backups", Unknown: "permission denied"}, AttentionStatusUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAttentionFixture(t)
			withArchive(f, nil, &tc.r)
			rep := f.step()
			wantStatus(t, rep, "backup_disk", tc.want)
			if tc.want == AttentionStatusWarning {
				w := warning(rep, "backup_disk")
				if w == nil || !strings.Contains(w.Action, "docs/hosting/backups.md#keep-them-off-the-servers-disk") {
					t.Errorf("warning = %+v, want the docs link in its action", w)
				}
				if w.Title != "Your backups may be on the same disk as your server" {
					t.Errorf("title = %q", w.Title)
				}
			}
		})
	}
}

// With Everything the backup is as old as the OLDER of the database copy and the full archive, so an archive
// that keeps failing ages the signal even while database copies stay fresh.
func TestAttention_BackupAgesOnTheOlderKind(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		scope     string
		dbAge     time.Duration
		zipAge    time.Duration // 0 = no archive
		failingAt time.Duration // age of the first failure, 0 = none
		reason    string
		want      string
		wantText  string
	}{
		{"both fresh", BackupScopeEverything, time.Hour, 2 * time.Hour, 0, "", AttentionStatusOK, ""},
		{"archive stuck, database fresh", BackupScopeEverything, time.Hour, 40 * time.Hour, 5 * time.Hour,
			"no space left on device", AttentionStatusWarning, "no space left on device"},
		{"archive long stuck", BackupScopeEverything, time.Hour, 80 * time.Hour, 5 * time.Hour,
			"no space left on device", AttentionStatusCritical, "full archive"},
		{"database stale, archive fresh", BackupScopeEverything, 80 * time.Hour, time.Hour, 0, "", AttentionStatusCritical, ""},
		{"no archive ever, failing for a while", BackupScopeEverything, time.Hour, 0, 40 * time.Hour,
			"disk full", AttentionStatusWarning, "disk full"},
		{"no archive yet, no failure: not judged yet", BackupScopeEverything, time.Hour, 0, 0, "", AttentionStatusOK, ""},
		{"database scope ignores an old archive", BackupScopeDatabase, time.Hour, 80 * time.Hour, 0, "", AttentionStatusOK, ""},
		{"unset scope ignores an old archive", BackupScopeUnset, time.Hour, 80 * time.Hour, 0, "", AttentionStatusOK, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAttentionFixture(t)
			f.schedule = "daily"
			f.last = f.now.Add(time.Minute - tc.dbAge)
			f.s.RecordJob(AttentionBackupJob, nil, f.now)
			r := &BackupArchiveReading{Scope: tc.scope, Reason: tc.reason}
			if tc.zipAge > 0 {
				r.Newest = f.now.Add(time.Minute - tc.zipAge)
			}
			if tc.failingAt > 0 {
				r.FailingSince = f.now.Add(time.Minute - tc.failingAt)
				r.FailedAt = f.now
			}
			withArchive(f, r, nil)
			rep := f.step()
			wantStatus(t, rep, "backup", tc.want)
			if tc.wantText != "" {
				w := warning(rep, "backup")
				if w == nil || !strings.Contains(w.Detail, tc.wantText) {
					t.Errorf("warning = %+v, want detail naming %q", w, tc.wantText)
				}
				if w != nil && !strings.Contains(w.Action, "scheduled archive failed") {
					t.Errorf("action %q does not point at the archive", w.Action)
				}
			}
		})
	}
}

// Only the archive's own failure changes the wording: a stale database copy keeps the old advice.
func TestAttention_BackupKeepsOldAdviceForTheDatabaseCopy(t *testing.T) {
	t.Parallel()
	f := newAttentionFixture(t)
	f.schedule = "daily"
	f.last = f.now.Add(time.Minute - 40*time.Hour)
	f.s.RecordJob(AttentionBackupJob, nil, f.now)
	withArchive(f, &BackupArchiveReading{Scope: BackupScopeEverything, Newest: f.now}, nil)
	w := warning(f.step(), "backup")
	if w == nil || !strings.Contains(w.Action, "take a backup now") {
		t.Errorf("warning = %+v, want the take-a-backup advice", w)
	}
}

// A source that fails leaves the hints out rather than inventing a state.
func TestAttention_BackupArchiveSourceError(t *testing.T) {
	t.Parallel()
	f := newAttentionFixture(t)
	f.s.src.BackupArchive = func(context.Context) (BackupArchiveReading, error) {
		return BackupArchiveReading{}, errors.New("unreadable")
	}
	rep := f.step()
	for _, s := range rep.Signals {
		if s.ID == "backup_scope" {
			t.Errorf("backup_scope present without a reading: %+v", s)
		}
	}
}
