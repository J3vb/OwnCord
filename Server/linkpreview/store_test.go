package linkpreview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type fixture struct {
	t     *testing.T
	db    *db.DB
	store *Store
	dir   string
	clock *clock
}

// clock is a settable time source.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	dir := filepath.Join(t.TempDir(), DirName)
	store, err := NewStore(database, dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	clk := &clock{t: time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)}
	store.now = clk.now
	return &fixture{t: t, db: database, store: store, dir: dir, clock: clk}
}

func (f *fixture) put(ctx context.Context, content string) string {
	f.t.Helper()
	h, err := f.store.PutImage(ctx, []byte(content), "image/webp", 10, 10)
	if err != nil {
		f.t.Fatalf("PutImage(%q): %v", content, err)
	}
	return h
}

func (f *fixture) fileExists(hash string) bool {
	_, err := os.Stat(filepath.Join(f.dir, hash[:2], hash))
	return err == nil
}

func (f *fixture) imageRows() int {
	f.t.Helper()
	var n int
	if err := f.db.QueryRowContext(f.t.Context(), `SELECT COUNT(*) FROM link_preview_images`).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// card stores a preview that names image (nil for none) under the hash of url.
func (f *fixture) card(ctx context.Context, url string, image *string) string {
	f.t.Helper()
	h, norm, err := URLHash(url)
	if err != nil {
		f.t.Fatal(err)
	}
	title := "t"
	stamp := FormatTime(f.clock.now())
	err = f.store.PutPreview(ctx, db.LinkPreview{UrlHash: h, Url: norm, Title: &title, ImageHash: image, FetchedAt: stamp, LastUsedAt: stamp})
	if err != nil {
		f.t.Fatalf("PutPreview: %v", err)
	}
	return h
}

func TestPutImageDedupes(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.put(ctx, "same bytes")
	b := f.put(ctx, "same bytes")
	if a != b {
		t.Fatalf("same bytes gave two hashes: %s %s", a, b)
	}
	if !ValidHash(a) || a[:2] != filepath.Base(filepath.Dir(filepath.Join(f.dir, a[:2], a))) {
		t.Errorf("hash %q is not valid hex or not sharded", a)
	}
	if n := f.imageRows(); n != 1 {
		t.Errorf("image rows = %d, want 1", n)
	}
	entries, err := os.ReadDir(filepath.Join(f.dir, a[:2]))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != a {
		t.Errorf("shard holds %v, want only %s (no temp file left)", entries, a)
	}
	img, err := f.store.Image(ctx, a)
	if err != nil || img.Size != int64(len("same bytes")) || img.MimeType != "image/webp" || img.Width != 10 {
		t.Errorf("Image = %+v, %v", img, err)
	}
	if got := f.put(ctx, "other bytes"); got == a {
		t.Error("different bytes share a hash")
	}
	if n := f.imageRows(); n != 2 {
		t.Errorf("image rows = %d, want 2", n)
	}
}

func TestPutImageRefusesBadInput(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	tests := []struct {
		name string
		data []byte
		mime string
		w, h int
	}{
		{"empty", nil, "image/webp", 1, 1},
		{"too big", make([]byte, MaxImageBytes+1), "image/webp", 1, 1},
		{"no mime", []byte("x"), "", 1, 1},
		{"zero width", []byte("x"), "image/webp", 0, 1},
		{"negative height", []byte("x"), "image/webp", 1, -1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.store.PutImage(ctx, tc.data, tc.mime, tc.w, tc.h); !errors.Is(err, ErrInvalidImage) {
				t.Errorf("err = %v, want ErrInvalidImage", err)
			}
		})
	}
	if n := f.imageRows(); n != 0 {
		t.Errorf("image rows = %d after refused input", n)
	}
}

func TestOpenImage(t *testing.T) {
	f := newFixture(t)
	h := f.put(t.Context(), "thumb")
	file, err := f.store.OpenImage(h)
	if err != nil {
		t.Fatalf("OpenImage: %v", err)
	}
	defer file.Close() //nolint:errcheck
	if b, _ := io.ReadAll(file); string(b) != "thumb" {
		t.Errorf("read %q", b)
	}

	upper := strings.ToUpper(h)
	bad := []string{"", "abc", "../../etc/passwd", h[:63], h + "0", upper, strings.Repeat("g", 64), h[:2] + "/" + h[3:], strings.Repeat("a", 63) + "/"}
	for _, in := range bad {
		if _, err := f.store.OpenImage(in); !errors.Is(err, ErrInvalidHash) {
			t.Errorf("OpenImage(%q) err = %v, want ErrInvalidHash", in, err)
		}
	}
	missing := strings.Repeat("a", 64)
	if _, err := f.store.OpenImage(missing); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("OpenImage(missing) err = %v, want fs.ErrNotExist", err)
	}
}

func TestSweepHonoursCapAndAge(t *testing.T) {
	ctx := t.Context()
	f := newFixture(t)
	// Four images of 10 bytes each, stored a day apart, oldest first, each named by a card.
	hashes := make([]string, 0, 4)
	for i := range 4 {
		h := f.put(ctx, fmt.Sprintf("image-%04d", i))
		f.card(ctx, fmt.Sprintf("https://example.com/%d", i), &h)
		hashes = append(hashes, h)
		f.clock.advance(24 * time.Hour)
	}

	// Cap 25 bytes keeps two images (20 bytes): the two oldest go.
	res, err := f.store.Sweep(ctx, 25, 365*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if res.Images != 2 || res.ImageBytes != 20 {
		t.Errorf("result = %+v, want 2 images 20 bytes", res)
	}
	for i, h := range hashes {
		if want := i >= 2; f.fileExists(h) != want {
			t.Errorf("image %d file present = %v, want %v", i, f.fileExists(h), want)
		}
	}
	if n := f.imageRows(); n != 2 {
		t.Errorf("image rows = %d, want 2", n)
	}
	// The card that lost its image keeps its text and loses the image link.
	p, err := f.store.Preview(ctx, mustHash(t, "https://example.com/0"))
	if err != nil || p.ImageHash != nil || p.Title == nil {
		t.Errorf("card after eviction = %+v, %v", p, err)
	}

	// Age: image 2 was last used 48h ago and image 3 24h ago, so unused for 36h drops only image 2.
	res, err = f.store.Sweep(ctx, 1<<30, 36*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if res.Images != 1 || f.fileExists(hashes[2]) || !f.fileExists(hashes[3]) {
		t.Errorf("age sweep result = %+v, image2 present %v, image3 present %v", res, f.fileExists(hashes[2]), f.fileExists(hashes[3]))
	}

	// Touching keeps an image alive.
	f.clock.advance(100 * 24 * time.Hour)
	if err := f.store.Touch(ctx, mustHash(t, "https://example.com/3"), &hashes[3]); err != nil {
		t.Fatal(err)
	}
	if res, err = f.store.Sweep(ctx, 1<<30, time.Hour); err != nil || res.Images != 0 || !f.fileExists(hashes[3]) {
		t.Errorf("sweep after touch = %+v, %v", res, err)
	}

	// Cap 0 keeps nothing.
	if res, err = f.store.Sweep(ctx, 0, 365*24*time.Hour); err != nil || res.Images != 1 || f.fileExists(hashes[3]) {
		t.Errorf("sweep at cap 0 = %+v, %v", res, err)
	}
	if res, err = f.store.Sweep(ctx, -5, time.Hour); err != nil || res.Images != 0 {
		t.Errorf("sweep at negative cap = %+v, %v", res, err)
	}
}

func mustHash(t *testing.T, url string) string {
	t.Helper()
	h, _, err := URLHash(url)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestSweepDropsUnreferencedAfterGrace(t *testing.T) {
	ctx := t.Context()
	f := newFixture(t)
	orphan := f.put(ctx, "no card names me")
	named := f.put(ctx, "a card names me")
	f.card(ctx, "https://example.com/named", &named)

	if res, err := f.store.Sweep(ctx, 1<<30, 365*24*time.Hour); err != nil || res.Images != 0 {
		t.Fatalf("sweep inside the grace = %+v, %v", res, err)
	}
	f.clock.advance(unreferencedGrace + time.Minute)
	res, err := f.store.Sweep(ctx, 1<<30, 365*24*time.Hour)
	if err != nil || res.Images != 1 {
		t.Fatalf("sweep after the grace = %+v, %v", res, err)
	}
	if f.fileExists(orphan) || !f.fileExists(named) {
		t.Errorf("orphan present %v, named present %v", f.fileExists(orphan), f.fileExists(named))
	}
}

func TestSweepRemovesStraysAndStaleTemps(t *testing.T) {
	ctx := t.Context()
	f := newFixture(t)
	kept := f.put(ctx, "kept")
	f.card(ctx, "https://example.com/k", &kept)

	stray := strings.Repeat("ab", 32) // a file with no row
	shard := filepath.Join(f.dir, "ab")
	mustWrite(t, filepath.Join(shard, stray), "stray")
	// A crash mid-write: a temp file left behind, one stale and one fresh.
	staleTemp := filepath.Join(shard, tempPrefix+"stale")
	freshTemp := filepath.Join(shard, tempPrefix+"fresh")
	mustWrite(t, staleTemp, "half")
	mustWrite(t, freshTemp, "half")
	old := f.clock.now().Add(-time.Hour)
	if err := os.Chtimes(staleTemp, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(freshTemp, f.clock.now(), f.clock.now()); err != nil {
		t.Fatal(err)
	}
	// Files the store did not write are left alone.
	foreign := filepath.Join(shard, "README")
	mustWrite(t, foreign, "x")
	wrongShard := filepath.Join(shard, strings.Repeat("cd", 32))
	mustWrite(t, wrongShard, "x")

	res, err := f.store.Sweep(ctx, 1<<30, 365*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if res.Strays != 1 || res.Temps != 1 || res.Images != 0 {
		t.Errorf("result = %+v, want 1 stray 1 temp", res)
	}
	for path, want := range map[string]bool{
		filepath.Join(shard, stray): false, staleTemp: false, freshTemp: true, foreign: true, wrongShard: true,
	} {
		_, err := os.Stat(path)
		if present := err == nil; present != want {
			t.Errorf("%s present = %v, want %v", filepath.Base(path), present, want)
		}
	}
	if !f.fileExists(kept) {
		t.Error("a file with a row was removed")
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A failed row insert leaves the file with no row, and the next sweep removes it.
func TestFileWithoutRowIsReclaimed(t *testing.T) {
	ctx := t.Context()
	f := newFixture(t)
	h := f.put(ctx, "doomed")
	if _, err := f.db.DeleteLinkPreviewImage(ctx, h); err != nil {
		t.Fatal(err)
	}
	if !f.fileExists(h) {
		t.Fatal("setup: file should remain after the row is deleted")
	}
	if res, err := f.store.Sweep(ctx, 1<<30, time.Hour); err != nil || res.Strays != 1 || f.fileExists(h) {
		t.Errorf("sweep = %+v, %v, file present %v", res, err, f.fileExists(h))
	}
}

// PutImage racing Sweep under -race: every thumbnail PutImage reports stored is still on
// disk with its row, because the sweep cannot run between the rename and the insert.
func TestPutImageAndSweepRace(t *testing.T) {
	ctx := t.Context()
	f := newFixture(t)
	// Temp-file ages come from the filesystem, so this test needs the real clock.
	f.store.now = time.Now
	const writers, perWriter = 4, 25

	stop := make(chan struct{})
	var sweeps sync.WaitGroup
	sweeps.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			// A cap and age that evict nothing legitimately: any loss is a race.
			time.Sleep(time.Millisecond)
			if _, err := f.store.Sweep(ctx, 1<<40, 365*24*time.Hour); err != nil {
				t.Errorf("Sweep: %v", err)
				return
			}
		}
	})

	var wg sync.WaitGroup
	got := make(chan string, writers*perWriter)
	for w := range writers {
		wg.Go(func() {
			for i := range perWriter {
				// Half the payloads repeat across writers to exercise the same-hash path.
				h, err := f.store.PutImage(ctx, []byte(fmt.Sprintf("payload-%d", (w*perWriter+i)%(writers*perWriter/2))), "image/webp", 4, 4)
				if err != nil {
					t.Errorf("PutImage: %v", err)
					return
				}
				got <- h
			}
		})
	}
	wg.Wait()
	close(stop)
	sweeps.Wait()
	close(got)

	for h := range got {
		file, err := f.store.OpenImage(h)
		if err != nil {
			t.Fatalf("thumbnail %s lost: %v", h, err)
		}
		_ = file.Close()
		if _, err := f.store.Image(ctx, h); err != nil {
			t.Fatalf("row for %s lost: %v", h, err)
		}
	}
	if left, err := leftoverTemps(f.dir); err != nil || len(left) != 0 {
		t.Errorf("temp files left: %v, %v", left, err)
	}
}

func leftoverTemps(dir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasPrefix(d.Name(), tempPrefix) {
			out = append(out, p)
		}
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("walk: %w", err)
	}
	return out, nil
}

func TestPutImageBytesOnDisk(t *testing.T) {
	f := newFixture(t)
	data := bytes.Repeat([]byte{0xAB, 0xCD}, 1000)
	h := f.put(t.Context(), string(data))
	got, err := os.ReadFile(filepath.Join(f.dir, h[:2], h))
	if err != nil || !bytes.Equal(got, data) {
		t.Errorf("file content differs: %v", err)
	}
}

func dbPreview(hash, url string, failure *string, stamp string) db.LinkPreview {
	return db.LinkPreview{UrlHash: hash, Url: url, Failure: failure, FetchedAt: stamp, LastUsedAt: stamp}
}
