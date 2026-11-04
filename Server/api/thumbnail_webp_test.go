package api_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
)

func readWebP(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "webp", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return raw
}

// A lossy WebP photo, the format phone share sheets produce, gets a JPEG
// thumbnail inside the box instead of passing its original through, and the
// upload records its size.
func TestServeThumb_WebPFitsTheBox(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbwebp", 4)
	content := readWebP(t, "lossy-1600x1200.webp")

	up := doUpload(t, router, token, "file", "photo.webp", content)
	var resp struct {
		ID     string `json:"id"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	if up.Code != http.StatusCreated || json.NewDecoder(up.Body).Decode(&resp) != nil {
		t.Fatalf("upload: %d", up.Code)
	}
	if resp.Width != 1600 || resp.Height != 1200 {
		t.Errorf("upload size = %dx%d, want 1600x1200", resp.Width, resp.Height)
	}

	for i := range 2 { // generated, then served from the kept thumbnail
		rr := doServeThumb(t, router, resp.ID, token)
		if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "image/jpeg" {
			t.Fatalf("request %d: %d %q", i, rr.Code, rr.Header().Get("Content-Type"))
		}
		thumb, format, err := image.Decode(rr.Body)
		if err != nil || format != "jpeg" {
			t.Fatalf("request %d: thumbnail is not a JPEG: %v (%s)", i, err, format)
		}
		if b := thumb.Bounds(); b.Dx() != 800 || b.Dy() != 600 {
			t.Fatalf("request %d: thumbnail = %dx%d, want 800x600", i, b.Dx(), b.Dy())
		}
		if r, _, b, _ := thumb.At(400, 100).RGBA(); b < 0x8000 || r > 0x8000 {
			t.Errorf("request %d: the top half is not blue", i)
		}
	}
	if f, err := store.OpenThumb(resp.ID); err != nil {
		t.Errorf("thumbnail not kept: %v", err)
	} else {
		_ = f.Close()
	}
}

// A WebP with transparent pixels keeps them: its thumbnail is a PNG, from
// the first request and from the kept file.
func TestServeThumb_TransparentWebPIsAPNG(t *testing.T) {
	database := newUploadTestDB(t)
	router := buildUploadRouter(database, newUploadTestStorage(t), nil)
	token := uploadCreateToken(t, database, "thumbwebpalpha", 4)
	for _, tc := range []struct {
		file         string
		wantW, wantH int
		clear        image.Point
	}{
		{"lossless-alpha-1200x900.webp", 800, 600, image.Pt(100, 300)},
		{"lossy-alpha-1000x1000.webp", 800, 800, image.Pt(400, 100)},
	} {
		id := uploadForThumb(t, router, token, tc.file, readWebP(t, tc.file))
		for i := range 2 {
			rr := doServeThumb(t, router, id, token)
			if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "image/png" {
				t.Fatalf("%s request %d: %d %q", tc.file, i, rr.Code, rr.Header().Get("Content-Type"))
			}
			thumb, format, err := image.Decode(rr.Body)
			if err != nil || format != "png" {
				t.Fatalf("%s request %d: not a PNG: %v (%s)", tc.file, i, err, format)
			}
			if b := thumb.Bounds(); b.Dx() != tc.wantW || b.Dy() != tc.wantH {
				t.Errorf("%s: thumbnail = %dx%d, want %dx%d", tc.file, b.Dx(), b.Dy(), tc.wantW, tc.wantH)
			}
			if _, _, _, a := thumb.At(tc.clear.X, tc.clear.Y).RGBA(); a != 0 {
				t.Errorf("%s: a transparent pixel came out with alpha %d", tc.file, a)
			}
		}
	}
}

// The decoder here reads stills only: an animated WebP keeps its frames by
// passing through, and nothing is kept for it.
func TestServeThumb_AnimatedWebPPassesThrough(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbwebpanim", 4)
	content := readWebP(t, "animated-1000x1000.webp")
	id := uploadForThumb(t, router, token, "anim.webp", content)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) || rr.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("animated WebP: %d %q, %d bytes; want the original", rr.Code, rr.Header().Get("Content-Type"), rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was kept for an animated WebP: %v", err)
	}
}

// webpBomb is an extended WebP header declaring a 16384x16384 canvas over a
// tiny lossy frame: DecodeConfig reports the canvas, and a decode would
// allocate for it.
func webpBomb(t *testing.T) []byte {
	t.Helper()
	frame := readWebP(t, "lossy-1600x1200.webp")[12:] // the VP8 chunk
	body := append([]byte("WEBPVP8X"),
		10, 0, 0, 0, // chunk length 10
		0, 0, 0, 0, // no flags
		0xFF, 0x3F, 0x00, // width 16384 - 1
		0xFF, 0x3F, 0x00, // height 16384 - 1
	)
	body = append(body, frame...)
	out := append([]byte("RIFF"), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(body)))
	return append(out, body...)
}

func TestServeThumb_WebPBombIsNotDecoded(t *testing.T) {
	bomb := webpBomb(t)
	if cfg, format, err := image.DecodeConfig(bytes.NewReader(bomb)); err != nil || format != "webp" || cfg.Width != 16384 || cfg.Height != 16384 {
		t.Fatalf("bomb header = %dx%d %s (%v), want a 16384x16384 webp", cfg.Width, cfg.Height, format, err)
	}
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbwebpbomb", 4)
	id := uploadForThumb(t, router, token, "bomb.webp", bomb)

	rr := doServeThumb(t, router, id, token)
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), bomb) {
		t.Errorf("bomb: %d, %d bytes; want the original passed through", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a thumbnail was made of the bomb: %v", err)
	}
}

// With every slot busy past the wait, a thumbnail request is served the
// original and keeps nothing, so the next request still makes the thumbnail.
func TestServeThumb_BusySlotsServeTheOriginalWithoutKeeping(t *testing.T) {
	hold, restore := api.UseThumbSlotsForTest(1, 20*time.Millisecond)
	t.Cleanup(restore)
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbusy", 4)
	content := encodeJPEG(t, solidImage(1200, 2400))
	id := uploadForThumb(t, router, token, "photo.jpg", content)

	release := hold()
	rr := doServeThumb(t, router, id, token)
	release()
	if rr.Code != http.StatusOK || !bytes.Equal(rr.Body.Bytes(), content) {
		t.Fatalf("busy: %d, %d bytes; want the original", rr.Code, rr.Body.Len())
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a busy request kept a thumbnail marker: %v", err)
	}

	rr = doServeThumb(t, router, id, token)
	cfg, format, err := image.DecodeConfig(rr.Body)
	if rr.Code != http.StatusOK || err != nil || format != "jpeg" || cfg.Width != 400 || cfg.Height != 800 {
		t.Errorf("after the slots freed: %d, %dx%d %s (%v), want a 400x800 JPEG", rr.Code, cfg.Width, cfg.Height, format, err)
	}
}

// A converted preview has no original to fall back on: busy slots answer 503
// with a Retry-After and keep nothing, and the preview is made once a slot frees.
func TestServeThumb_BusySlotsAnswerAConvertedPreview503(t *testing.T) {
	hold, restore := api.UseThumbSlotsForTest(1, 20*time.Millisecond)
	t.Cleanup(restore)
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "thumbbusytiff", 4)
	id := uploadForThumb(t, router, token, "scan.tif", testTIFF(t, 50, 30))

	release := hold()
	rr := doServeThumb(t, router, id, token)
	release()
	if rr.Code != http.StatusServiceUnavailable || rr.Header().Get("Retry-After") == "" {
		t.Fatalf("busy: %d, Retry-After %q; want 503 with a Retry-After", rr.Code, rr.Header().Get("Retry-After"))
	}
	if _, err := store.OpenThumb(id); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a busy request kept a preview marker: %v", err)
	}
	assertPreviewJPEG(t, doServeThumb(t, router, id, token), 50, 30)
}
