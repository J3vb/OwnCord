package unfurl

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/linkpreview"
)

// fakeSource answers fetches from tables and counts them. A non-nil gate is waited on inside
// Page, after the call is counted, so a test can change the world while a fetch is in flight.
type fakeSource struct {
	mu      sync.Mutex
	pages   map[string]Page
	errs    map[string]error
	images  map[string][]byte
	calls   map[string]int
	gate    chan struct{}
	entered chan string
}

func newFakeSource() *fakeSource {
	return &fakeSource{
		pages: map[string]Page{}, errs: map[string]error{},
		images: map[string][]byte{}, calls: map[string]int{},
	}
}

func (s *fakeSource) count(url string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[url]
}

func (s *fakeSource) Page(ctx context.Context, rawURL string) (Page, error) {
	s.mu.Lock()
	s.calls[rawURL]++
	gate, entered := s.gate, s.entered
	page, err := s.pages[rawURL], s.errs[rawURL]
	s.mu.Unlock()
	if entered != nil {
		entered <- rawURL
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return Page{}, ctx.Err()
		}
	}
	if err != nil {
		return Page{}, err
	}
	return page, nil
}

func (s *fakeSource) Image(_ context.Context, rawURL string) ([]byte, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls[rawURL]++
	data, ok := s.images[rawURL]
	if !ok {
		return nil, "", &externalcontent.Error{Failure: externalcontent.Unavailable}
	}
	return data, "image/png", nil
}

// fakeAnnouncer records what was announced.
type fakeAnnouncer struct {
	mu   sync.Mutex
	seen []Ready
}

func (a *fakeAnnouncer) LinkPreviewsReady(_ context.Context, r Ready) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seen = append(a.seen, r)
}

func (a *fakeAnnouncer) all() []Ready {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Ready(nil), a.seen...)
}

// testClock is a settable clock.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type fixture struct {
	t         *testing.T
	db        *db.DB
	store     *linkpreview.Store
	src       *fakeSource
	ann       *fakeAnnouncer
	clock     *testClock
	u         *Unfurler
	channelID int64
	userID    int64
}

func newFixture(t *testing.T, opt Options) *fixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	store, err := linkpreview.NewStore(database, filepath.Join(t.TempDir(), linkpreview.DirName))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	ctx := t.Context()
	uid, err := database.CreateUser(ctx, "alice", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	cid, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{
		t: t, db: database, store: store, src: newFakeSource(), ann: &fakeAnnouncer{},
		clock: &testClock{t: time.Now()}, channelID: cid, userID: uid,
	}
	opt.Now = f.clock.now
	f.u = New(store, f.src, f.ann, opt)
	return f
}

// message stores a message and returns the job a send would queue for it.
func (f *fixture) message(content string) linkpreview.Job {
	f.t.Helper()
	id, err := f.db.CreateMessage(f.t.Context(), f.channelID, f.userID, content, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	return linkpreview.Job{
		MessageID: id, ChannelID: f.channelID, AuthorID: f.userID, Content: content, Version: f.version(id),
	}
}

func (f *fixture) version(id int64) string {
	f.t.Helper()
	var v string
	err := f.db.QueryRowContext(f.t.Context(), `SELECT COALESCE(edited_at, timestamp) FROM messages WHERE id = ?`, id).Scan(&v)
	if err != nil {
		f.t.Fatal(err)
	}
	return v
}

// edit rewrites a message and returns the job an edit would queue.
func (f *fixture) edit(id int64, content string) linkpreview.Job {
	f.t.Helper()
	// edited_at has one-second resolution; the guard also compares the text.
	msg, err := f.db.EditMessage(f.t.Context(), id, f.userID, content)
	if err != nil || msg == nil {
		f.t.Fatalf("EditMessage: %v", err)
	}
	return linkpreview.Job{
		MessageID: id, ChannelID: f.channelID, AuthorID: f.userID, Content: content, Version: f.version(id), Edited: true,
	}
}

func (f *fixture) cards(id int64) int {
	f.t.Helper()
	rows, err := f.store.MessagePreviews(f.t.Context(), id)
	if err != nil {
		f.t.Fatal(err)
	}
	return len(rows)
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		for y := range h {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func ptr(s string) *string { return &s }
