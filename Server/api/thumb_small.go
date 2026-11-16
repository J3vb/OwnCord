package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"slices"
	"strconv"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/imgthumb"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// animatedHeader marks a small-size thumbnail whose original is an animated GIF, so a client that
// shows the still knows a full original is worth fetching on hover.
const animatedHeader = "X-Image-Animated"

// smallThumbMaxSource bounds the original read into memory for a small thumbnail; a larger one is
// served as the original.
const smallThumbMaxSource = 32 << 20

// smallThumbMIME are the originals a small thumbnail is made from. Unlike the default size, a GIF is
// included: the thumbnail is its first frame.
var smallThumbMIME = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

// parseThumbSize reads the optional size query: 0 when absent, else one of storage.ThumbSizes. Any other
// value is answered 400 here.
func parseThumbSize(w http.ResponseWriter, r *http.Request) (size int, ok bool) {
	q := r.URL.Query()
	if !q.Has("size") {
		return 0, true
	}
	n, err := strconv.Atoi(q.Get("size"))
	if err != nil || !slices.Contains(storage.ThumbSizes, n) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "size must be one of "+joinInts(storage.ThumbSizes))
		return 0, false
	}
	return n, true
}

func joinInts(ns []int) string {
	var b bytes.Buffer
	for i, n := range ns {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(strconv.Itoa(n))
	}
	return b.String()
}

func openThumbSize(store FileStore, storedAs string, size int) (storage.File, error) {
	if size == 0 {
		return store.OpenThumb(storedAs)
	}
	return store.OpenThumbSize(storedAs, size)
}

func saveThumbSize(store FileStore, storedAs string, size int, data []byte) error {
	if size == 0 {
		return store.SaveThumb(storedAs, data)
	}
	return store.SaveThumbSize(storedAs, size, data)
}

// smallThumbContentType is the media type of a small thumbnail: Fit writes a PNG when the image has
// transparency and a JPEG otherwise, whatever the original was.
func smallThumbContentType(head []byte) string {
	if bytes.HasPrefix(head, []byte("\x89PNG")) {
		return "image/png"
	}
	return "image/jpeg"
}

// smallThumbResult is what one generation hands every request waiting on it.
type smallThumbResult struct{ thumb []byte }

// generateSmallThumb makes and keeps the size thumbnail of storedAs, once however many requests ask at
// the same moment: they share one generation (under a slot) and read the kept file afterwards. The
// thumbnail is returned only for the caller that has no kept file to read, nil when none was made. ok
// is false only when the request ended while waiting.
func generateSmallThumb(r *http.Request, uploads *service.UploadService, store FileStore, slots *thumbSlots, storedAs, mimeType string, size int) (thumb []byte, ok bool) {
	return runSmallThumb(r.Context(), uploads, store, slots, storedAs, mimeType, size, func() ([]byte, bool) {
		f, err := store.Open(storedAs)
		if err != nil {
			return nil, false
		}
		defer f.Close() //nolint:errcheck
		data, err := io.ReadAll(io.LimitReader(f, smallThumbMaxSource+1))
		return data, err == nil && len(data) <= smallThumbMaxSource
	})
}

// runSmallThumb is the one generation path of both the lazy request and the upload: they share the
// slots and the flight key, so concurrent work stays within the CPU-sized limit and one size of one
// file is made once. load returns the original's bytes, false when they cannot be used.
func runSmallThumb(ctx context.Context, uploads *service.UploadService, store FileStore, slots *thumbSlots, storedAs, mimeType string, size int, load func() ([]byte, bool)) (thumb []byte, ok bool) {
	key := storedAs + "@" + strconv.Itoa(size)
	ch := slots.flights.DoChan(key, func() (any, error) {
		// The generation is shared, so the leader's own cancellation must not fail the requests waiting
		// on it. It stays bounded: the wait for a slot ends at thumbSlotWait, and the original read is
		// capped at smallThumbMaxSource.
		gen := context.WithoutCancel(ctx)
		return smallThumbResult{thumb: makeSmallThumb(gen, uploads, store, slots, storedAs, mimeType, size, load)}, nil
	})
	select {
	case <-ctx.Done():
		return nil, false
	case res := <-ch:
		out, _ := res.Val.(smallThumbResult)
		return out.thumb, true
	}
}

// makeSmallThumb is one generation: take a slot, find nothing kept meanwhile, fit the original, keep it,
// and record beside it whether a GIF original is animated.
func makeSmallThumb(ctx context.Context, uploads *service.UploadService, store FileStore, slots *thumbSlots, storedAs, mimeType string, size int, load func() ([]byte, bool)) []byte {
	release, got := slots.acquire(ctx, 1)
	if !got {
		return nil
	}
	defer release()
	if t, found := keptThumbSize(store, storedAs, size); found {
		if t != nil {
			_ = t.Close()
		}
		return nil
	}
	var thumb []byte
	if data, usable := load(); usable {
		if sc, fitted := imgthumb.Fit(data, size); fitted {
			thumb = sc.Data
		}
		if thumb != nil && mimeType == "image/gif" {
			// Best effort: without the record the first reply scans the original and writes it.
			_ = store.SetThumbAnimation(storedAs, size, imgthumb.GIFAnimated(bytes.NewReader(data)))
		}
	}
	keepThumbnailSize(ctx, uploads, store, storedAs, size, thumb)
	return thumb
}

// prewarmSmallThumbs makes every small size of a freshly stored image from its bytes in hand, so the
// first list render finds them kept. It takes the same slots as a lazy request and is best effort: a
// failure leaves the lazy path to retry.
func prewarmSmallThumbs(ctx context.Context, uploads *service.UploadService, store FileStore, storedAs, mimeType string, raw []byte) {
	if !smallThumbMIME[mimeType] {
		return
	}
	slots := sharedThumbSlots()
	for _, size := range storage.ThumbSizes {
		runSmallThumb(ctx, uploads, store, slots, storedAs, mimeType, size, func() ([]byte, bool) { return raw, true })
	}
}
