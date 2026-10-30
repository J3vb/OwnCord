package db_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type mediaFixture struct {
	database   *db.DB
	alice, bob int64
	ch, other  int64
}

func newMediaFixture(t *testing.T) mediaFixture {
	t.Helper()
	database := openMigratedMemory(t)
	return mediaFixture{
		database: database,
		alice:    seedUser(t, database, "alice"),
		bob:      seedUser(t, database, "bob"),
		ch:       seedChannel(t, database, "general"),
		other:    seedChannel(t, database, "random"),
	}
}

// post sends a message by user in ch at ts with one attachment per file
// (name, mime), and returns the message id.
func (f mediaFixture) post(t *testing.T, ch, user int64, ts string, files ...[2]string) int64 {
	t.Helper()
	ctx := context.Background()
	msgID, err := f.database.CreateMessage(ctx, ch, user, "files", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE messages SET timestamp = ? WHERE id = ?`, ts, msgID); err != nil {
		t.Fatalf("set timestamp: %v", err)
	}
	ids := make([]string, 0, len(files))
	for i, file := range files {
		id := fmt.Sprintf("att-%d-%d", msgID, i)
		if err := f.database.CreateAttachment(ctx, id, user, file[0], id, file[1], 10, nil, nil); err != nil {
			t.Fatalf("CreateAttachment: %v", err)
		}
		ids = append(ids, id)
	}
	if len(ids) > 0 {
		if _, err := f.database.LinkAttachmentsToMessage(ctx, msgID, user, ids); err != nil {
			t.Fatalf("LinkAttachmentsToMessage: %v", err)
		}
	}
	return msgID
}

func (f mediaFixture) list(t *testing.T, q db.ChannelMediaQuery) []db.ChannelMediaItem {
	t.Helper()
	if q.ChannelID == 0 {
		q.ChannelID = f.ch
	}
	if q.ViewerID == 0 {
		q.ViewerID = f.alice
	}
	if q.Kind == "" {
		q.Kind = db.MediaKindMedia
	}
	if q.Limit == 0 {
		q.Limit = 50
	}
	items, err := f.database.ListChannelMedia(context.Background(), q)
	if err != nil {
		t.Fatalf("ListChannelMedia: %v", err)
	}
	return items
}

func names(items []db.ChannelMediaItem) []string {
	out := make([]string, len(items))
	for i := range items {
		out[i] = items[i].Attachment.Filename
	}
	return out
}

func assertNames(t *testing.T, got []db.ChannelMediaItem, want ...string) {
	t.Helper()
	if fmt.Sprint(names(got)) != fmt.Sprint(want) {
		t.Errorf("names = %v, want %v", names(got), want)
	}
}

var (
	png  = func(n string) [2]string { return [2]string{n, "image/png"} }
	mp4  = func(n string) [2]string { return [2]string{n, "video/mp4"} }
	pdf  = func(n string) [2]string { return [2]string{n, "application/pdf"} }
	opus = func(n string) [2]string { return [2]string{n, "audio/ogg"} }
)

func TestListChannelMedia_KindsOrderAndScope(t *testing.T) {
	f := newMediaFixture(t)
	f.post(t, f.ch, f.alice, "2026-01-05 10:00:00", png("a.png"), pdf("a.pdf"))
	f.post(t, f.ch, f.bob, "2026-02-05 10:00:00", mp4("b.mp4"), opus("b.ogg"))
	f.post(t, f.other, f.bob, "2026-02-06 10:00:00", png("elsewhere.png"))
	f.post(t, f.ch, f.bob, "2026-02-07 10:00:00")

	assertNames(t, f.list(t, db.ChannelMediaQuery{}), "b.mp4", "a.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{Oldest: true}), "a.png", "b.mp4")
	assertNames(t, f.list(t, db.ChannelMediaQuery{Kind: db.MediaKindFiles}), "b.ogg", "a.pdf")

	items := f.list(t, db.ChannelMediaQuery{})
	if it := items[0]; it.User.ID != f.bob || it.User.Username != "bob" || it.Timestamp != "2026-02-05 10:00:00" ||
		it.Attachment.URL != "/api/v1/files/"+it.Attachment.ID || it.Attachment.Mime != "video/mp4" {
		t.Errorf("first item = %+v", it)
	}
}

func TestListChannelMedia_DeletedBlockedAndUnlinkedAreHidden(t *testing.T) {
	f := newMediaFixture(t)
	ctx := context.Background()
	gone := f.post(t, f.ch, f.alice, "2026-01-01 10:00:00", png("deleted.png"))
	f.post(t, f.ch, f.bob, "2026-01-02 10:00:00", png("bob.png"))
	f.post(t, f.ch, f.alice, "2026-01-03 10:00:00", png("alice.png"))
	if err := f.database.CreateAttachment(ctx, "staged", f.alice, "staged.png", "staged", "image/png", 1, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, gone); err != nil {
		t.Fatalf("delete: %v", err)
	}
	assertNames(t, f.list(t, db.ChannelMediaQuery{}), "alice.png", "bob.png")

	if err := f.database.BlockUser(ctx, f.alice, f.bob); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	assertNames(t, f.list(t, db.ChannelMediaQuery{}), "alice.png")
	// The block is one-way: bob still sees alice's media.
	assertNames(t, f.list(t, db.ChannelMediaQuery{ViewerID: f.bob}), "alice.png", "bob.png")
}

func TestListChannelMedia_NameAndUploaderFilters(t *testing.T) {
	f := newMediaFixture(t)
	f.post(t, f.ch, f.alice, "2026-01-01 10:00:00", png("Holiday_Beach.PNG"), png("100%.png"))
	f.post(t, f.ch, f.bob, "2026-01-02 10:00:00", png("holidayXbeach.png"))

	assertNames(t, f.list(t, db.ChannelMediaQuery{Name: "beach"}), "holidayXbeach.png", "Holiday_Beach.PNG")
	// "_" and "%" match literally, not as LIKE wildcards.
	assertNames(t, f.list(t, db.ChannelMediaQuery{Name: "y_b"}), "Holiday_Beach.PNG")
	assertNames(t, f.list(t, db.ChannelMediaQuery{Name: "0%"}), "100%.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{UploaderID: f.bob}), "holidayXbeach.png")
}

// A page boundary inside one message's attachments, and an upload arriving
// between pages, neither repeats nor skips an item.
func TestListChannelMedia_CursorIsStableAcrossNewUploads(t *testing.T) {
	f := newMediaFixture(t)
	f.post(t, f.ch, f.alice, "2026-01-01 10:00:00", png("1.png"))
	f.post(t, f.ch, f.alice, "2026-01-02 10:00:00", png("2a.png"), png("2b.png"), png("2c.png"))
	f.post(t, f.ch, f.alice, "2026-01-03 10:00:00", png("3.png"))

	first := f.list(t, db.ChannelMediaQuery{Limit: 2})
	assertNames(t, first, "3.png", "2a.png")
	f.post(t, f.ch, f.bob, "2026-01-04 10:00:00", png("new.png"))
	last := first[len(first)-1]
	rest := f.list(t, db.ChannelMediaQuery{Cursor: db.MediaCursor{MessageID: last.MessageID, AttachmentID: last.Attachment.ID}})
	assertNames(t, rest, "2b.png", "2c.png", "1.png")

	up := f.list(t, db.ChannelMediaQuery{Oldest: true, Limit: 2})
	assertNames(t, up, "1.png", "2a.png")
	last = up[len(up)-1]
	assertNames(t, f.list(t, db.ChannelMediaQuery{Oldest: true, Cursor: db.MediaCursor{MessageID: last.MessageID, AttachmentID: last.Attachment.ID}}),
		"2b.png", "2c.png", "3.png", "new.png")
}

func TestListChannelMedia_FromStartsTheWalk(t *testing.T) {
	f := newMediaFixture(t)
	f.post(t, f.ch, f.alice, "2026-01-31 23:59:59", png("jan.png"))
	f.post(t, f.ch, f.alice, "2026-02-01 00:00:00", png("feb.png"))
	f.post(t, f.ch, f.alice, "2026-03-01 00:00:00", png("mar.png"))
	feb := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	mar := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)

	assertNames(t, f.list(t, db.ChannelMediaQuery{From: mar}), "feb.png", "jan.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{From: feb, Oldest: true}), "feb.png", "mar.png")
}

func TestChannelMediaBuckets_QuarterHours(t *testing.T) {
	f := newMediaFixture(t)
	f.post(t, f.ch, f.alice, "2026-01-31 23:44:59", png("a.png"), png("b.png"))
	f.post(t, f.ch, f.alice, "2026-01-31 23:45:00", png("c.png"), pdf("d.pdf"))
	buckets, err := f.database.ChannelMediaBuckets(context.Background(), db.ChannelMediaQuery{
		ChannelID: f.ch, ViewerID: f.alice, Kind: db.MediaKindMedia,
	})
	if err != nil {
		t.Fatalf("ChannelMediaBuckets: %v", err)
	}
	want := []db.MediaBucket{
		{Start: time.Date(2026, 1, 31, 23, 30, 0, 0, time.UTC), Count: 2},
		{Start: time.Date(2026, 1, 31, 23, 45, 0, 0, time.UTC), Count: 1},
	}
	if fmt.Sprint(buckets) != fmt.Sprint(want) {
		t.Errorf("buckets = %v, want %v", buckets, want)
	}
}

func TestListChannelMedia_UnknownKindIsAnError(t *testing.T) {
	f := newMediaFixture(t)
	if _, err := f.database.ListChannelMedia(context.Background(), db.ChannelMediaQuery{ChannelID: f.ch, Kind: "links", Limit: 1}); err == nil {
		t.Fatal("unknown kind: want an error")
	}
}
