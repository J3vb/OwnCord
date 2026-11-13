package unfurl

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/linkpreview"
)

func TestEnqueue_DisabledQueuesNothing(t *testing.T) {
	f := newFixture(t, Options{Enabled: false})
	f.u.Enqueue(f.message(pageURL))
	if n := f.u.EnqueueBackfill([]linkpreview.Job{f.message(pageURL)}); n != 0 {
		t.Errorf("backfill accepted %d jobs while disabled", n)
	}
	if len(f.u.live) != 0 || len(f.u.low) != 0 || f.u.Dropped() != 0 {
		t.Errorf("queued %d/%d, dropped %d; want nothing", len(f.u.live), len(f.u.low), f.u.Dropped())
	}
}

func TestEnqueue_SkipsMessagesWithoutLinksUnlessEdited(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.u.Enqueue(linkpreview.Job{MessageID: 1, AuthorID: 1, Content: "no links"})
	if len(f.u.live) != 0 {
		t.Fatal("a message without links was queued")
	}
	f.u.Enqueue(linkpreview.Job{MessageID: 1, AuthorID: 1, Content: "no links", Edited: true})
	if len(f.u.live) != 1 {
		t.Error("an edit without links must be queued so its old cards clear")
	}
}

// A full queue never blocks the send: the job is dropped and counted.
func TestEnqueue_FullQueueDropsAndCounts(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, QueueSize: 2, BackfillSize: 1, LinksPerMinute: 1000})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 5 {
			f.u.Enqueue(linkpreview.Job{MessageID: int64(i + 1), AuthorID: 1, Content: pageURL})
		}
		f.u.EnqueueBackfill([]linkpreview.Job{{MessageID: 10, Content: pageURL}, {MessageID: 11, Content: pageURL}})
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Enqueue blocked on a full queue")
	}
	if len(f.u.live) != 2 || len(f.u.low) != 1 {
		t.Errorf("queued %d/%d, want 2/1", len(f.u.live), len(f.u.low))
	}
	if f.u.Dropped() != 4 {
		t.Errorf("dropped = %d, want 3 live + 1 backfill", f.u.Dropped())
	}
}

func TestEnqueue_PerAuthorLinkCap(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, LinksPerMinute: 3})
	two := "https://a.example/ https://b.example/"
	f.u.Enqueue(linkpreview.Job{MessageID: 1, AuthorID: 7, Content: two})
	f.u.Enqueue(linkpreview.Job{MessageID: 2, AuthorID: 7, Content: two}) // 4 links in the minute: refused
	f.u.Enqueue(linkpreview.Job{MessageID: 3, AuthorID: 8, Content: two}) // another author has their own
	if len(f.u.live) != 2 || f.u.RateLimited() != 1 {
		t.Fatalf("queued %d, limited %d; want 2 and 1", len(f.u.live), f.u.RateLimited())
	}
	f.clock.advance(61 * time.Second)
	f.u.Enqueue(linkpreview.Job{MessageID: 4, AuthorID: 7, Content: two})
	if len(f.u.live) != 3 {
		t.Errorf("queued %d after the window, want 3", len(f.u.live))
	}
}

func TestWorkers_RunLiveBeforeBackfillAndStopOnCancel(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, Workers: 1})
	f.src.pages[pageURL] = Page{Title: ptr("T")}
	old := f.message(pageURL)
	fresh := f.message("fresh " + pageURL)
	f.u.EnqueueBackfill([]linkpreview.Job{old})
	f.u.Enqueue(fresh)

	ctx, cancel := context.WithCancel(t.Context())
	wait := f.u.Start(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for len(f.ann.all()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	seen := f.ann.all()
	if len(seen) != 2 || seen[0].MessageID != fresh.MessageID || seen[1].MessageID != old.MessageID {
		t.Fatalf("order = %+v, want the live message first", seen)
	}
	cancel()
	stopCtx, stop := context.WithTimeout(t.Context(), 5*time.Second)
	defer stop()
	if !wait(stopCtx) {
		t.Error("workers did not stop after cancel")
	}
}

// Shutdown with a worker inside a fetch: the fetch sees the cancelled context and the pool joins.
func TestWorkers_CancelStopsBusyWorkers(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, Workers: 2})
	f.src.gate = make(chan struct{})
	f.src.entered = make(chan string, 4)
	for i := range 2 {
		f.u.Enqueue(f.message(fmt.Sprintf("https://site%d.example/", i)))
	}
	ctx, cancel := context.WithCancel(t.Context())
	wait := f.u.Start(ctx)
	<-f.src.entered
	<-f.src.entered
	cancel()
	stopCtx, stop := context.WithTimeout(t.Context(), 5*time.Second)
	defer stop()
	if !wait(stopCtx) {
		t.Error("busy workers did not stop after cancel")
	}
}

func TestShown_FlushMarksCardsAndImagesUsed(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, ThumbCapBytes: 1 << 20})
	f.src.pages[pageURL] = Page{Title: ptr("T"), ImageURL: "https://example.com/i.png"}
	f.src.images["https://example.com/i.png"] = pngBytes(t, 50, 50)
	f.u.process(t.Context(), f.message(pageURL))
	hash := mustHash(t, pageURL)
	before, err := f.store.Preview(t.Context(), hash)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond) // the store stamps whole seconds

	f.u.NoteShown([]string{hash, hash}, []string{*before.ImageHash})
	f.u.flushShown(t.Context())
	after, err := f.store.Preview(t.Context(), hash)
	if err != nil || after.LastUsedAt <= before.LastUsedAt {
		t.Errorf("last_used_at %q -> %q, want it moved", before.LastUsedAt, after.LastUsedAt)
	}
	f.u.flushShown(t.Context()) // nothing pending: no write, no panic
}

func TestUserLimit_EvictsExpiredWindows(t *testing.T) {
	clock := &testClock{t: time.Now()}
	l := newUserLimit(1, time.Minute, clock.now)
	for i := range maxBuckets {
		l.allow(int64(i), 1)
	}
	clock.advance(2 * time.Minute)
	if !l.allow(99999, 1) {
		t.Fatal("a fresh author was refused")
	}
	l.mu.Lock()
	n := len(l.buckets)
	l.mu.Unlock()
	if n != 1 {
		t.Errorf("buckets = %d after sweep, want 1", n)
	}
}

func TestYoutubeID(t *testing.T) {
	cases := map[string]string{
		"https://youtu.be/dQw4w9WgXcQ":                           "dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=abc_DEF-123&t=5":        "abc_DEF-123",
		"https://m.youtube.com/shorts/abc123":                    "abc123",
		"https://www.youtube.com/embed/abc123/extra":             "abc123",
		"https://www.youtube.com/live/abc123":                    "abc123",
		"https://youtube.com/watch":                              "",
		"https://example.com/watch?v=abc":                        "",
		"https://youtu.be/":                                      "",
		"https://youtu.be/has/slash":                             "",
		"https://www.youtube.com/watch?v=waytoolongidwaytoolong": "",
	}
	for in, want := range cases {
		if got := youtubeID(in); got != want {
			t.Errorf("youtubeID(%q) = %q, want %q", in, got, want)
		}
	}
}
