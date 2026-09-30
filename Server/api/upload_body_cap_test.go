package api_test

import (
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/storage"
)

// P1-09 / D2: the upload request's body cap follows upload.max_size_mb, so a
// server configured above 100 MB accepts such files instead of cutting them
// at a fixed 100 MiB request cap.

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// streamedUpload posts a size-byte file as a chunked multipart body, generated
// on the fly so a 120 MB test file is never held in memory.
func streamedUpload(t *testing.T, router http.Handler, token string, size int64) *httptest.ResponseRecorder {
	t.Helper()
	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)
	go func() {
		part, err := writer.CreateFormFile("file", "big.bin")
		if err == nil {
			_, err = io.CopyN(part, zeroReader{}, size)
		}
		if err == nil {
			err = writer.Close()
		}
		pw.CloseWithError(err)
	}()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", pr)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	_ = pr.CloseWithError(io.ErrClosedPipe) // unblock the writer if the handler stopped reading
	return rr
}

func cappedHarness(t *testing.T, maxSizeMB int) *quotaHarness {
	t.Helper()
	dir := t.TempDir()
	store, err := storage.New(dir, maxSizeMB)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	h := newQuotaHarness(t, store)
	h.dir = dir
	h.limitsCapped(t, 0, 0, nil, int64(maxSizeMB)<<20)
	return h
}

func TestUpload_AboveHundredMiBAcceptedWhenConfigured(t *testing.T) {
	if testing.Short() {
		t.Skip("writes a 120 MB file")
	}
	h := cappedHarness(t, 150)
	rr := streamedUpload(t, h.router, h.token, 120<<20)
	if rr.Code != http.StatusCreated {
		t.Fatalf("120 MB upload under max_size_mb 150: status %d, body %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_OverSmallCapKeepsTheSizeRejection(t *testing.T) {
	h := cappedHarness(t, 10)
	rr := streamedUpload(t, h.router, h.token, 11<<20)
	assertErrorCode(t, rr, http.StatusBadRequest, "BAD_REQUEST")
	if !strings.Contains(rr.Body.String(), "file exceeds maximum size of 10 MB") {
		t.Fatalf("body = %s, want the per-file size rejection", rr.Body.String())
	}
	if h.filesOnDisk(t) != 0 {
		t.Fatal("a refused upload left a file on disk")
	}
}

func TestUploadBodyCap(t *testing.T) {
	const hundredMiB = int64(100 << 20)
	for _, tc := range []struct {
		name    string
		fileCap int64
		want    int64
	}{
		// upload.max_size_mb: 0 is no per-file cap; the 100 MiB request cap binds.
		{"no per-file cap", 0, hundredMiB},
		// A smaller per-file cap keeps the 100 MiB request cap, so an oversize
		// file still reaches storage.Save and its own size rejection.
		{"small cap", 10 << 20, hundredMiB},
		{"above 100 MiB", 150 << 20, 150<<20 + api.UploadMultipartMarginForTest},
		{"overflow saturates", math.MaxInt64 - 1, math.MaxInt64},
	} {
		if got := api.UploadBodyCapForTest(tc.fileCap); got != tc.want {
			t.Errorf("%s: uploadBodyCap(%d) = %d, want %d", tc.name, tc.fileCap, got, tc.want)
		}
	}
}
