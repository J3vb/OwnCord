package unfurl

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/linkpreview"
)

const pageURL = "https://example.com/a"

func TestProcess_StoresCardWithThumbnailAndAnnounces(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, ThumbCapBytes: 1 << 20})
	f.src.pages[pageURL] = Page{Title: new("Title"), Description: new("Desc"), SiteName: new("Example"), ImageURL: "https://example.com/i.png"}
	f.src.images["https://example.com/i.png"] = pngBytes(t, 1280, 720)
	job := f.message("look " + pageURL)

	f.u.process(t.Context(), job)

	seen := f.ann.all()
	if len(seen) != 1 || len(seen[0].Cards) != 1 {
		t.Fatalf("announced %+v, want one card", seen)
	}
	c := seen[0].Cards[0]
	if c.URL != pageURL || *c.Title != "Title" || *c.Description != "Desc" || *c.SiteName != "Example" {
		t.Errorf("card = %+v", c)
	}
	if c.Image == nil || c.Image.Width != 640 || c.Image.Height != 360 {
		t.Fatalf("image = %+v, want 640x360", c.Image)
	}
	if seen[0].MessageID != job.MessageID || seen[0].ChannelID != f.channelID || seen[0].AuthorID != f.userID {
		t.Errorf("ready = %+v", seen[0])
	}
	if _, err := f.store.Image(t.Context(), c.Image.Hash); err != nil {
		t.Errorf("thumbnail row: %v", err)
	}
}

func TestProcess_CapZeroKeepsTextNotImage(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, ThumbCapBytes: 0})
	f.src.pages[pageURL] = Page{Title: new("Title"), ImageURL: "https://example.com/i.png"}
	f.src.images["https://example.com/i.png"] = pngBytes(t, 100, 100)
	f.u.process(t.Context(), f.message(pageURL))

	seen := f.ann.all()
	if len(seen) != 1 || seen[0].Cards[0].Image != nil || *seen[0].Cards[0].Title != "Title" {
		t.Fatalf("announced %+v", seen)
	}
	if f.src.count("https://example.com/i.png") != 0 {
		t.Error("an image was fetched though no thumbnails are kept")
	}
}

// Edge case 2: two messages with one link at once make one fetch, and both get the card.
func TestProcess_TwoJobsSameURLOneFetch(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.pages[pageURL] = Page{Title: new("Shared")}
	f.src.gate = make(chan struct{})
	f.src.entered = make(chan string, 4)
	a, b := f.message(pageURL), f.message("again "+pageURL)

	done := make(chan struct{}, 2)
	for _, j := range []linkpreview.Job{a, b} {
		go func() { f.u.process(t.Context(), j); done <- struct{}{} }()
	}
	<-f.src.entered // one fetch is in flight and blocked
	time.Sleep(50 * time.Millisecond)
	close(f.src.gate)
	for range 2 {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("jobs did not finish")
		}
	}
	if n := f.src.count(pageURL); n != 1 {
		t.Errorf("page fetched %d times, want 1", n)
	}
	if f.cards(a.MessageID) != 1 || f.cards(b.MessageID) != 1 {
		t.Error("both messages should hold the card")
	}
	if len(f.ann.all()) != 2 {
		t.Errorf("announcements = %d, want 2", len(f.ann.all()))
	}
}

// Edge case 1: the message is edited while its fetch runs; the stale result is dropped.
func TestProcess_EditedDuringFetchDropsResult(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.pages[pageURL] = Page{Title: new("Old")}
	f.src.gate = make(chan struct{})
	f.src.entered = make(chan string, 1)
	job := f.message(pageURL)

	done := make(chan struct{})
	go func() { f.u.process(t.Context(), job); close(done) }()
	<-f.src.entered
	f.edit(job.MessageID, "no link now")
	close(f.src.gate)
	<-done

	if got := len(f.ann.all()); got != 0 {
		t.Errorf("announced %d times for a stale result", got)
	}
	if f.cards(job.MessageID) != 0 {
		t.Error("a stale result was stored against the edited message")
	}
}

func TestProcess_DeletedDuringFetchDropsResult(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.pages[pageURL] = Page{Title: new("Gone")}
	f.src.gate = make(chan struct{})
	f.src.entered = make(chan string, 1)
	job := f.message(pageURL)

	done := make(chan struct{})
	go func() { f.u.process(t.Context(), job); close(done) }()
	<-f.src.entered
	if err := f.db.DeleteMessage(t.Context(), job.MessageID, f.userID, false); err != nil {
		t.Fatal(err)
	}
	close(f.src.gate)
	<-done

	if len(f.ann.all()) != 0 || f.cards(job.MessageID) != 0 {
		t.Errorf("a deleted message got a result: %+v", f.ann.all())
	}
}

func TestProcess_ReusesFreshCardRefetchesStale(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.pages[pageURL] = Page{Title: new("T")}
	f.u.process(t.Context(), f.message(pageURL))
	f.clock.advance(6 * 24 * time.Hour)
	f.u.process(t.Context(), f.message(pageURL))
	if n := f.src.count(pageURL); n != 1 {
		t.Fatalf("fetches within 7 days = %d, want 1", n)
	}
	f.clock.advance(2 * 24 * time.Hour)
	f.u.process(t.Context(), f.message(pageURL))
	if n := f.src.count(pageURL); n != 2 {
		t.Errorf("fetches after 7 days = %d, want 2", n)
	}
}

func TestProcess_FailureRememberedAnHourAndNotShown(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.errs[pageURL] = &externalcontent.Error{Failure: externalcontent.Oversized}
	job := f.message(pageURL)
	f.u.process(t.Context(), job)

	p, err := f.store.Preview(t.Context(), mustHash(t, pageURL))
	if err != nil || p.Failure == nil || *p.Failure != "oversized" {
		t.Fatalf("stored = %+v, %v; want an oversized failure row", p, err)
	}
	if len(f.ann.all()) != 0 {
		t.Error("a failed link was announced")
	}
	if f.cards(job.MessageID) != 1 {
		t.Error("the failure row should be linked so the message counts as unfurled")
	}
	f.u.process(t.Context(), f.message(pageURL))
	if n := f.src.count(pageURL); n != 1 {
		t.Errorf("fetches inside the hour = %d, want 1", n)
	}
	f.clock.advance(61 * time.Minute)
	f.src.errs[pageURL] = nil
	f.src.pages[pageURL] = Page{Title: new("Back")}
	f.u.process(t.Context(), f.message(pageURL))
	if n := f.src.count(pageURL); n != 2 || len(f.ann.all()) != 1 {
		t.Errorf("after the hour: fetches = %d, announcements = %d; want 2 and 1", n, len(f.ann.all()))
	}
}

func TestProcess_FetchCutShortByShutdownStoresNothing(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.gate = make(chan struct{}) // never opened: the fetch ends when its context does
	f.src.entered = make(chan string, 1)
	job := f.message(pageURL)
	ctx, cancel := context.WithCancel(t.Context())

	done := make(chan struct{})
	go func() { f.u.process(ctx, job); close(done) }()
	<-f.src.entered
	cancel()
	<-done

	if _, err := f.store.Preview(t.Context(), mustHash(t, pageURL)); err == nil {
		t.Error("a fetch cut short left a failure row for an hour")
	}
	if f.cards(job.MessageID) != 0 || len(f.ann.all()) != 0 {
		t.Error("a message with an unfetched link was marked unfurled")
	}
}

func TestProcess_LinkThatIsAnImageBecomesImageOnlyCard(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, ThumbCapBytes: 1 << 20})
	const imgURL = "https://example.com/pic.png"
	f.src.errs[imgURL] = &externalcontent.Error{Failure: externalcontent.WrongType}
	f.src.images[imgURL] = pngBytes(t, 200, 100)
	f.u.process(t.Context(), f.message(imgURL))

	seen := f.ann.all()
	if len(seen) != 1 || seen[0].Cards[0].Image == nil || seen[0].Cards[0].Title != nil {
		t.Fatalf("announced %+v, want one image-only card", seen)
	}
}

func TestProcess_YouTubeCardUsesOEmbedTitleAndStill(t *testing.T) {
	f := newFixture(t, Options{Enabled: true, ThumbCapBytes: 1 << 20})
	const oembed = "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=json"
	f.src.pages[oembed] = Page{Title: new("A video")}
	f.src.images["https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg"] = pngBytes(t, 320, 180)
	f.u.process(t.Context(), f.message("https://youtu.be/dQw4w9WgXcQ"))

	seen := f.ann.all()
	if len(seen) != 1 {
		t.Fatalf("announced %+v", seen)
	}
	c := seen[0].Cards[0]
	if *c.Title != "A video" || *c.SiteName != "YouTube" || c.Image == nil || c.URL != "https://youtu.be/dQw4w9WgXcQ" {
		t.Errorf("card = %+v", c)
	}
}

func TestProcess_EditRemovingLinksClearsAndAnnouncesEmpty(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	f.src.pages[pageURL] = Page{Title: new("T")}
	job := f.message(pageURL)
	f.u.process(t.Context(), job)
	if f.cards(job.MessageID) != 1 {
		t.Fatal("setup: no card")
	}
	f.u.process(t.Context(), f.edit(job.MessageID, "never mind"))

	seen := f.ann.all()
	if len(seen) != 2 || len(seen[1].Cards) != 0 {
		t.Fatalf("announced %+v, want a second, empty announcement", seen)
	}
	if f.cards(job.MessageID) != 0 {
		t.Error("cards survived an edit that removed the link")
	}
}

func TestProcess_EditWithoutLinksOrCardsDoesNothing(t *testing.T) {
	f := newFixture(t, Options{Enabled: true})
	job := f.message("plain")
	f.u.process(t.Context(), f.edit(job.MessageID, "still plain"))
	if len(f.ann.all()) != 0 {
		t.Error("announced a message that never had cards")
	}
}

func mustHash(t *testing.T, raw string) string {
	t.Helper()
	h, _, err := linkpreview.URLHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	return h
}
