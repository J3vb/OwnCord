package db_test

import (
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// A channel whose few pictures sit among other channels' and its own files pages the same in both
// directions, across a cursor and a start point.
func TestListChannelMedia_SparseChannelAmongBusyOnes(t *testing.T) {
	f := newMediaFixture(t)
	for i := range 20 {
		f.post(t, f.other, f.bob, "2026-01-01 10:00:00", png("other"+string(rune('a'+i))+".png"))
	}
	f.post(t, f.ch, f.alice, "2026-01-02 10:00:00", png("one.png"), pdf("doc.pdf"))
	for range 10 {
		f.post(t, f.other, f.bob, "2026-01-03 10:00:00", png("other.png"))
	}
	f.post(t, f.ch, f.alice, "2026-01-04 10:00:00", pdf("doc2.pdf"))
	f.post(t, f.ch, f.alice, "2026-02-05 10:00:00", mp4("two.mp4"), png("three.png"))
	empty := seedChannel(t, f.database, "empty")

	assertNames(t, f.list(t, db.ChannelMediaQuery{}), "two.mp4", "three.png", "one.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{Oldest: true}), "one.png", "two.mp4", "three.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{ChannelID: empty}))
	assertNames(t, f.list(t, db.ChannelMediaQuery{Kind: db.MediaKindFiles}), "doc2.pdf", "doc.pdf")

	first := f.list(t, db.ChannelMediaQuery{Limit: 1})
	assertNames(t, first, "two.mp4")
	cur := db.MediaCursor{MessageID: first[0].MessageID, AttachmentID: first[0].Attachment.ID}
	assertNames(t, f.list(t, db.ChannelMediaQuery{Cursor: cur}), "three.png", "one.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{Cursor: cur, Oldest: true}), "three.png")
	assertNames(t, f.list(t, db.ChannelMediaQuery{From: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)}), "one.png")
}
