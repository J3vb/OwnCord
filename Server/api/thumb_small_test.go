package api_test

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/go-chi/chi/v5"
)

func doSizedThumb(t *testing.T, router http.Handler, fileID, token, query string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/"+fileID+"/thumb"+query, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return serveLocal(router, req)
}

func requireSize(t *testing.T, rr *httptest.ResponseRecorder, w, h int) {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(rr.Body.Bytes()))
	if err != nil || cfg.Width != w || cfg.Height != h {
		t.Fatalf("image = %dx%d (%v), want %dx%d", cfg.Width, cfg.Height, err, w, h)
	}
}

func TestServeThumb_SmallSizesFitTheirBoxAndAreKeptSeparately(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbsmall", 4)
	id := uploadForThumb(t, router, token, "a.png", encodePNG(t, solidImage(1000, 500)))

	for _, c := range []struct {
		size int
		q    string
		w, h int
	}{{128, "?size=128", 128, 64}, {256, "?size=256", 256, 128}, {0, "", 800, 400}} {
		for range 2 { // generated, then served from the kept file
			rr := doSizedThumb(t, router, id, token, c.q, nil)
			requireSize(t, rr, c.w, c.h)
			if rr.Header().Get("X-Image-Animated") != "" {
				t.Errorf("size %d: a PNG was marked animated", c.size)
			}
			wantType := "image/jpeg" // a small size is a JPEG when opaque; the default size keeps the original's type
			if c.size == 0 {
				wantType = "image/png"
			}
			if rr.Header().Get("Content-Type") != wantType {
				t.Errorf("size %d: content type %q, want %s", c.size, rr.Header().Get("Content-Type"), wantType)
			}
			if rr.Header().Get("Cache-Control") != "private, no-cache" {
				t.Errorf("size %d: cache control %q", c.size, rr.Header().Get("Cache-Control"))
			}
		}
		open := store.OpenThumbSize
		if c.size == 0 {
			open = func(id string, _ int) (storage.File, error) { return store.OpenThumb(id) }
		}
		f, err := open(id, c.size)
		if err != nil {
			t.Fatalf("size %d not kept: %v", c.size, err)
		}
		_ = f.Close()
	}
	entries, err := store.List()
	if err != nil || len(entries) != 1 {
		t.Fatalf("List = %v, %v; want only the original", entries, err)
	}
}

func TestServeThumb_RejectsOtherSizes(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbbadsize", 4)
	id := uploadForThumb(t, router, token, "a.png", encodePNG(t, solidImage(1000, 1000)))
	for _, q := range []string{"?size=64", "?size=800", "?size=abc", "?size=", "?size=0", "?size=-128", "?size=128.0"} {
		if rr := doSizedThumb(t, router, id, token, q, nil); rr.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", q, rr.Code)
		}
	}
	if rr := doSizedThumb(t, router, id, "", "?size=128", nil); rr.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated: %d, want 401", rr.Code)
	}
}

func TestServeThumb_SmallSizeOfAnAnimatedGIFIsAMarkedStill(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, []string{"https://app.example"})
	token := uploadCreateToken(t, database, "thumbgif", 4)
	anim := uploadForThumb(t, router, token, "anim.gif", makeAnimatedGIFBytes(t, 400, 400, 0))
	still := uploadForThumb(t, router, token, "still.gif", gifOneFrame(t, 400, 400))

	for range 2 {
		rr := doSizedThumb(t, router, anim, token, "?size=128", map[string]string{"Origin": "https://app.example"})
		requireSize(t, rr, 128, 128)
		if rr.Header().Get("X-Image-Animated") != "1" {
			t.Error("an animated GIF's still was not marked")
		}
		if got := rr.Header().Get("Access-Control-Expose-Headers"); got != "Content-Type, Content-Length, X-Image-Animated" {
			t.Errorf("Expose-Headers = %q", got)
		}
		rr = doSizedThumb(t, router, still, token, "?size=128", nil)
		requireSize(t, rr, 128, 128)
		if rr.Header().Get("X-Image-Animated") != "" {
			t.Error("a one-frame GIF was marked animated")
		}
	}
	// The default size still passes a GIF through.
	rr := doSizedThumb(t, router, anim, token, "", nil)
	if rr.Header().Get("Content-Type") != "image/gif" || rr.Header().Get("X-Image-Animated") != "" {
		t.Errorf("default size: %q, animated %q", rr.Header().Get("Content-Type"), rr.Header().Get("X-Image-Animated"))
	}
}

func TestServeThumb_SmallSizeOfAnUnshrinkableImageIsTheOriginal(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbtxt2", 4)
	broken := append([]byte("\xff\xd8\xff\xe0"), bytes.Repeat([]byte{0x41}, 64)...)
	id := uploadForThumb(t, router, token, "broken.jpg", broken)
	for range 2 {
		rr := doSizedThumb(t, router, id, token, "?size=128", nil)
		if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), broken) {
			t.Fatalf("%d, %d bytes; want the original", rr.Code, rr.Body.Len())
		}
	}
	f, err := store.OpenThumbSize(id, 128)
	if err != nil {
		t.Fatalf("empty marker not kept: %v", err)
	}
	info, _ := f.Stat()
	_ = f.Close()
	if info.Size() != 0 {
		t.Errorf("marker has %d bytes", info.Size())
	}
}

// countingStore counts the small thumbnails written and can run a hook just before one is.
type countingStore struct {
	*storage.Storage
	saves  atomic.Int32
	before func()
}

func (c *countingStore) SaveThumbSize(uuid string, size int, data []byte) error {
	c.saves.Add(1)
	if c.before != nil {
		c.before()
	}
	return c.Storage.SaveThumbSize(uuid, size, data)
}

func newCountingRouter(t *testing.T) (http.Handler, *countingStore, string, string) {
	t.Helper()
	database := newUploadTestDB(t)
	store := &countingStore{Storage: newUploadTestStorage(t)}
	r := chi.NewRouter()
	api.MountUploadRoutes(r, service.NewSessionService(database), store, auth.NewRateLimiter(), nil, testUploadSvc(database))
	token := uploadCreateToken(t, database, "thumbrace", 4)
	id := uploadForThumb(t, r, token, "a.png", encodePNG(t, solidImage(1000, 1000)))
	return r, store, id, token
}

// Many requests for one avatar size at once make it once and all get the same bytes.
func TestServeThumb_ConcurrentRequestsMakeOneThumbnail(t *testing.T) {
	router, store, id, token := newCountingRouter(t)
	const n = 24
	bodies := make([][]byte, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			rr := doSizedThumb(t, router, id, token, "?size=128", nil)
			if rr.Code == http.StatusOK {
				bodies[i] = rr.Body.Bytes()
			}
		})
	}
	wg.Wait()
	if got := store.saves.Load(); got != 1 {
		t.Errorf("thumbnail made %d times, want once", got)
	}
	for i, b := range bodies {
		if len(b) == 0 || !bytes.Equal(b, bodies[0]) {
			t.Fatalf("request %d got %d bytes, differing from request 0 (%d bytes)", i, len(b), len(bodies[0]))
		}
	}
}

// An original deleted while its thumbnail is being saved leaves no thumbnail behind.
func TestServeThumb_OriginalDeletedWhileSavingLeavesNoVariant(t *testing.T) {
	router, store, id, token := newCountingRouter(t)
	store.before = func() { _ = store.Delete(id) }
	rr := doSizedThumb(t, router, id, token, "?size=256", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d", rr.Code)
	}
	requireSize(t, rr, 256, 256)
	if _, err := store.OpenThumbSize(id, 256); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a variant outlived its original: %v", err)
	}
}

func TestAvatarUpload_MakesTheSmallSizesUpFront(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildAvatarRouter(database, store)
	token := uploadCreateToken(t, database, "pfp_small", 4)
	rr := doAvatarUpload(t, router, token, "me.png", encodePNG(t, solidImage(512, 512)))
	requireStatus(t, rr, http.StatusCreated)
	id, _ := decodeBody[map[string]any](t, rr)["id"].(string)
	for _, size := range storage.ThumbSizes {
		f, err := store.OpenThumbSize(id, size)
		if err != nil {
			t.Fatalf("size %d not made at upload: %v", size, err)
		}
		cfg, _, derr := image.DecodeConfig(f)
		_ = f.Close()
		if derr != nil || cfg.Width != size {
			t.Errorf("size %d: %dx%d (%v)", size, cfg.Width, cfg.Height, derr)
		}
	}
}

func gifOneFrame(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := gif.Encode(&buf, image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White}), nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// openCountingStore counts the opens of originals.
type openCountingStore struct {
	*storage.Storage
	opens atomic.Int32
}

func (o *openCountingStore) Open(uuid string) (storage.File, error) {
	o.opens.Add(1)
	return o.Storage.Open(uuid)
}

// The animated answer is decided when the thumbnail is made and kept beside it, so a kept reply (and a
// revalidation) never reads the original GIF again.
func TestServeThumb_AnimatedAnswerIsKeptNotRescanned(t *testing.T) {
	database := newUploadTestDB(t)
	store := &openCountingStore{Storage: newUploadTestStorage(t)}
	r := chi.NewRouter()
	api.MountUploadRoutes(r, service.NewSessionService(database), store, auth.NewRateLimiter(), nil, testUploadSvc(database))
	token := uploadCreateToken(t, database, "thumbgifkept", 4)
	id := uploadForThumb(t, r, token, "anim.gif", makeAnimatedGIFBytes(t, 400, 400, 0))

	first := doSizedThumb(t, r, id, token, "?size=128", nil)
	if first.Header().Get("X-Image-Animated") != "1" {
		t.Fatal("first reply not marked animated")
	}
	if animated, known := store.ThumbAnimation(id, 128); !animated || !known {
		t.Fatalf("record = %v, %v; want animated and known", animated, known)
	}
	before := store.opens.Load()
	for range 3 {
		rr := doSizedThumb(t, r, id, token, "?size=128", nil)
		if rr.Header().Get("X-Image-Animated") != "1" {
			t.Fatal("kept reply lost the mark")
		}
	}
	if got := store.opens.Load(); got != before {
		t.Errorf("kept replies opened the original %d times", got-before)
	}
}

// A thumbnail kept before records existed is scanned once, and the answer recorded.
func TestServeThumb_ThumbnailWithoutARecordIsScannedOnce(t *testing.T) {
	database := newUploadTestDB(t)
	store := &openCountingStore{Storage: newUploadTestStorage(t)}
	r := chi.NewRouter()
	api.MountUploadRoutes(r, service.NewSessionService(database), store, auth.NewRateLimiter(), nil, testUploadSvc(database))
	token := uploadCreateToken(t, database, "thumbgifold", 4)
	id := uploadForThumb(t, r, token, "anim.gif", makeAnimatedGIFBytes(t, 400, 400, 0))
	if err := store.SaveThumbSize(id, 128, encodePNG(t, solidImage(128, 128))); err != nil {
		t.Fatal(err)
	}
	before := store.opens.Load()
	for range 3 {
		if rr := doSizedThumb(t, r, id, token, "?size=128", nil); rr.Header().Get("X-Image-Animated") != "1" {
			t.Fatal("not marked animated")
		}
	}
	if got := store.opens.Load() - before; got != 1 {
		t.Errorf("original opened %d times, want once", got)
	}
}
