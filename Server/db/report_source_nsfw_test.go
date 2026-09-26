package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

type sourceNSFWFixture struct {
	t        *testing.T
	database *db.DB
	reporter int64
	n        int
}

func (f *sourceNSFWFixture) channel(nsfw bool) int64 {
	f.t.Helper()
	id, err := f.database.CreateChannel(context.Background(), "src", "text", "", "", 0)
	if err != nil {
		f.t.Fatalf("CreateChannel: %v", err)
	}
	f.label(id, nsfw)
	return id
}

func (f *sourceNSFWFixture) label(channelID int64, nsfw bool) {
	f.t.Helper()
	v := 0
	if nsfw {
		v = 1
	}
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET nsfw = ? WHERE id = ?`, v, channelID); err != nil {
		f.t.Fatalf("label: %v", err)
	}
}

func (f *sourceNSFWFixture) file(channelID *int64) int64 {
	f.t.Helper()
	f.n++
	ref := string(rune('a' + f.n))
	id, err := f.database.FileReport(context.Background(), "src-nsfw-"+ref, f.reporter, 0, "message", ref, channelID, "spam", "", nil)
	if err != nil {
		f.t.Fatalf("FileReport: %v", err)
	}
	return id
}

func (f *sourceNSFWFixture) expect(reportID int64, want *bool) {
	f.t.Helper()
	r, err := f.database.GetReport(context.Background(), reportID)
	if err != nil {
		f.t.Fatalf("GetReport: %v", err)
	}
	switch {
	case want == nil && r.SourceNSFW == nil:
	case want != nil && r.SourceNSFW != nil && *want == *r.SourceNSFW:
	default:
		f.t.Fatalf("report %d SourceNSFW = %v, want %v", reportID, fmtBoolPtr(r.SourceNSFW), fmtBoolPtr(want))
	}
}

func fmtBoolPtr(b *bool) string {
	if b == nil {
		return "nil"
	}
	if *b {
		return "true"
	}
	return "false"
}

var (
	yes = func() *bool { b := true; return &b }()
	no  = func() *bool { b := false; return &b }()
)

// TestReportSourceNSFW_Backfill: migration 052 records the current label of
// every source channel that still exists and leaves NULL (unknown, withheld
// by the evidence gate) where the channel was already deleted.
func TestReportSourceNSFW_Backfill(t *testing.T) {
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsBefore(t, "052_")); err != nil {
		t.Fatalf("MigrateFS(<052): %v", err)
	}
	reporter, err := database.CreateUser(context.Background(), "src-reporter", "x", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	f := &sourceNSFWFixture{t: t, database: database, reporter: reporter}
	labelled, plain, gone := f.channel(true), f.channel(false), f.channel(true)
	rLabelled, rPlain, rGone, rUser := f.file(&labelled), f.file(&plain), f.file(&gone), f.file(nil)
	if err := database.DeleteChannel(context.Background(), gone); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	if err := db.MigrateFS(database, migrations.FS); err != nil {
		t.Fatalf("MigrateFS(all): %v", err)
	}
	f.expect(rLabelled, yes)
	f.expect(rPlain, no)
	f.expect(rGone, nil)
	f.expect(rUser, nil)
}

// TestReportSourceNSFW_TriggersAreSticky: the flag is set from the label at
// filing, set by any later labelling, and never cleared by unlabelling.
func TestReportSourceNSFW_TriggersAreSticky(t *testing.T) {
	database := openMigratedMemory(t)
	reporter, err := database.CreateUser(context.Background(), "src-reporter", "x", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	f := &sourceNSFWFixture{t: t, database: database, reporter: reporter}
	labelled, plain := f.channel(true), f.channel(false)
	rLabelled, rPlain := f.file(&labelled), f.file(&plain)
	f.expect(rLabelled, yes)
	f.expect(rPlain, no)

	f.label(plain, true)
	f.expect(rPlain, yes)
	f.label(plain, false)
	f.label(labelled, false)
	f.expect(rPlain, yes)
	f.expect(rLabelled, yes)

	missing := int64(1 << 40)
	f.expect(f.file(&missing), nil)
	f.expect(f.file(nil), nil)
}
