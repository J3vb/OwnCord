package db_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedAttached sends a message and links one attachment of the given mime type.
func seedAttached(t *testing.T, database *db.DB, ch, user int64, content, mime string) int64 {
	t.Helper()
	ctx := context.Background()
	msg := seedUnlinked(t, database, user, mime)
	id, err := database.CreateMessage(ctx, ch, user, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	linked, err := database.LinkAttachmentsToMessage(ctx, id, user, []string{msg})
	if err != nil || len(linked) != 1 {
		t.Fatalf("link attachment: %v %v", linked, err)
	}
	return id
}

var attachSeq int

// seedUnlinked uploads an attachment that no message owns yet.
func seedUnlinked(t *testing.T, database *db.DB, user int64, mime string) string {
	t.Helper()
	attachSeq++
	id := fmt.Sprintf("att-%d", attachSeq)
	if err := database.CreateAttachment(context.Background(), id, user, "f", id, mime, 10, nil, nil); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	return id
}

func searchIDs(t *testing.T, database *db.DB, q db.SearchQuery) []int64 {
	t.Helper()
	rs, err := database.SearchMessagesFiltered(context.Background(), q, db.SearchPage{Limit: 50})
	if err != nil {
		t.Fatalf("SearchMessagesFiltered: %v", err)
	}
	ids := resultIDs(rs)
	slices.Sort(ids)
	return ids
}

func TestSearchFiltered_HasMime(t *testing.T) {
	database := openMigratedMemory(t)
	u := seedUser(t, database, "hm")
	ch := seedChannel(t, database, "hasmime")
	img := seedAttached(t, database, ch, u, "a", "image/png")
	vid := seedAttached(t, database, ch, u, "b", "video/mp4")
	snd := seedAttached(t, database, ch, u, "c", "audio/mpeg")
	doc := seedAttached(t, database, ch, u, "d", "application/pdf")
	plain, _ := database.CreateMessage(context.Background(), ch, u, "e", nil)

	tests := []struct {
		has  string
		want []int64
	}{
		{"image", []int64{img}},
		{"video", []int64{vid}},
		{"sound", []int64{snd}},
		{"file", []int64{img, vid, snd, doc}},
	}
	for _, tc := range tests {
		got := searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, Has: []string{tc.has}})
		if !slices.Equal(got, tc.want) {
			t.Errorf("has:%s = %v, want %v", tc.has, got, tc.want)
		}
	}
	if slices.Contains(searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, Has: []string{"file"}}), plain) {
		t.Error("has:file matched a message without attachments")
	}
}

func TestSearchFiltered_HasLinkApprox(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "hl")
	ch := seedChannel(t, database, "haslink")
	a, _ := database.CreateMessage(ctx, ch, u, "see http://example.com now", nil)
	b, _ := database.CreateMessage(ctx, ch, u, "see HTTPS://example.com now", nil)
	_, _ = database.CreateMessage(ctx, ch, u, "see example.com now", nil)
	_, _ = database.CreateMessage(ctx, ch, u, "ftp://example.com", nil)
	got := searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, Has: []string{"link"}})
	if want := []int64{a, b}; !slices.Equal(got, want) {
		t.Errorf("has:link = %v, want %v", got, want)
	}
}

// Edge case 1: an attachment not yet linked, or on a deleted message, never
// satisfies has:.
func TestSearchFiltered_HasExcludesUnlinkedAttachments(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "hu")
	ch := seedChannel(t, database, "hasunlinked")
	_ = seedUnlinked(t, database, u, "image/png") // uploaded, never sent
	plain, _ := database.CreateMessage(ctx, ch, u, "no attachment", nil)
	gone := seedAttached(t, database, ch, u, "deleted one", "image/png")
	kept := seedAttached(t, database, ch, u, "kept one", "image/png")
	if err := database.DeleteMessage(ctx, gone, u, true); err != nil {
		t.Fatal(err)
	}
	for _, has := range []string{"file", "image"} {
		got := searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, Has: []string{has}})
		if want := []int64{kept}; !slices.Equal(got, want) {
			t.Errorf("has:%s = %v, want %v (plain=%d gone=%d)", has, got, want, plain, gone)
		}
	}
}

func TestSearchFiltered_HasValuesAnd(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "ha")
	ch := seedChannel(t, database, "hasand")
	both := seedAttached(t, database, ch, u, "look https://x.example", "image/png")
	_ = seedAttached(t, database, ch, u, "image only", "image/png")
	_, _ = database.CreateMessage(ctx, ch, u, "link only https://x.example", nil)
	got := searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, Has: []string{"link", "image"}})
	if want := []int64{both}; !slices.Equal(got, want) {
		t.Errorf("has:link has:image = %v, want %v", got, want)
	}
}

func TestSearchFiltered_HasUnknownKindRefused(t *testing.T) {
	database := openMigratedMemory(t)
	ch := seedChannel(t, database, "hasbad")
	_, err := database.SearchMessagesFiltered(context.Background(),
		db.SearchQuery{ChannelIDs: []int64{ch}, Has: []string{"embed"}}, db.SearchPage{Limit: 5})
	if !errors.Is(err, db.ErrSearchBadHas) {
		t.Errorf("err = %v, want ErrSearchBadHas", err)
	}
}

func TestSearchFiltered_Pinned(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	u := seedUser(t, database, "pn")
	ch := seedChannel(t, database, "pinned")
	pinned, _ := database.CreateMessage(ctx, ch, u, "needle one", nil)
	loose, _ := database.CreateMessage(ctx, ch, u, "needle two", nil)
	if err := database.SetMessagePinned(ctx, pinned, true); err != nil {
		t.Fatal(err)
	}
	yes, no := true, false
	for _, text := range []string{"", "needle"} {
		if got := searchIDs(t, database, db.SearchQuery{Text: text, ChannelIDs: []int64{ch}, Pinned: &yes}); !slices.Equal(got, []int64{pinned}) {
			t.Errorf("text %q pinned:true = %v, want [%d]", text, got, pinned)
		}
		if got := searchIDs(t, database, db.SearchQuery{Text: text, ChannelIDs: []int64{ch}, Pinned: &no}); !slices.Equal(got, []int64{loose}) {
			t.Errorf("text %q pinned:false = %v, want [%d]", text, got, loose)
		}
	}
}

func TestSearchFiltered_MentionsExcludesReplyPingAndEveryone(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	author, bob, cat := seedUser(t, database, "ma"), seedUser(t, database, "mb"), seedUser(t, database, "mc")
	ch := seedChannel(t, database, "mentions")

	text, err := database.CreateMessageWithMentions(ctx, ch, author, "hi bob", nil, []int64{bob}, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	both, _ := database.CreateMessageWithMentions(ctx, ch, author, "hi bob and cat", nil, []int64{bob, cat}, 0, false)
	// Only a reply ping to bob: a notification, not a mention in the text.
	ping, _ := database.CreateMessageWithMentions(ctx, ch, author, "replying", nil, nil, bob, false)
	// @everyone stores no per-user row.
	_, _ = database.CreateMessageWithMentions(ctx, ch, author, "@everyone", nil, nil, 0, true)

	got := searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, MentionIDs: []int64{bob}})
	if want := []int64{text.ID, both.ID}; !slices.Equal(got, want) {
		t.Errorf("mentions:bob = %v, want %v (reply ping row on %d must not match)", got, want, ping.ID)
	}
	got = searchIDs(t, database, db.SearchQuery{ChannelIDs: []int64{ch}, MentionIDs: []int64{bob, cat}})
	if want := []int64{both.ID}; !slices.Equal(got, want) {
		t.Errorf("mentions:bob mentions:cat = %v, want %v", got, want)
	}
}

// Edge case 2: an edit that removes the mention stops the match, and the
// reply-ping row kept across the edit never matches.
func TestSearchFiltered_MentionsFollowsEdit(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	author, bob := seedUser(t, database, "ea"), seedUser(t, database, "eb")
	ch := seedChannel(t, database, "mentionedit")

	msg, err := database.CreateMessageWithMentions(ctx, ch, author, "hello bob", nil, []int64{bob}, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	// A pure reply ping: bob is not named in the text.
	pingOnly, err := database.CreateMessageWithMentions(ctx, ch, author, "hello again", nil, nil, bob, false)
	if err != nil {
		t.Fatal(err)
	}
	// Pings bob and names him: stored as one reply_ping row, still a mention.
	pinged, err := database.CreateMessageWithMentions(ctx, ch, author, "hey @EB look", nil, []int64{bob}, bob, false)
	if err != nil {
		t.Fatal(err)
	}
	q := db.SearchQuery{ChannelIDs: []int64{ch}, MentionIDs: []int64{bob}}
	if got := searchIDs(t, database, q); !slices.Equal(got, []int64{msg.ID, pinged.ID}) {
		t.Fatalf("before edit = %v, want [%d %d] (not the ping-only %d)", got, msg.ID, pinged.ID, pingOnly.ID)
	}

	// The edit rewrites the content and drops the text mention on both.
	for _, id := range []int64{msg.ID, pinged.ID} {
		if _, err := database.EditMessage(ctx, id, author, "hello nobody"); err != nil {
			t.Fatal(err)
		}
		if _, err := database.ReplaceMessageMentions(ctx, id, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	if got := searchIDs(t, database, q); len(got) != 0 {
		t.Errorf("after edit = %v, want none (reply-ping row must not match)", got)
	}

	// Re-adding the mention in an edit matches again.
	if _, err := database.ReplaceMessageMentions(ctx, msg.ID, []int64{bob}, false); err != nil {
		t.Fatal(err)
	}
	if got := searchIDs(t, database, q); !slices.Equal(got, []int64{msg.ID}) {
		t.Errorf("after re-mention = %v, want [%d]", got, msg.ID)
	}
}
