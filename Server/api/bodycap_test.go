package api

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The global body cap must not shadow routes that enforce their own larger
// envelope: MaxBytesReader wrappers only delegate reads, so the innermost
// (global) 1 MiB limit errors first and the route's documented cap becomes
// unreachable — the 16 MiB plugin upload 400s at ~1 MiB, and an at-limit
// avatar can never fit its multipart framing.
func TestBodyCapExemptions_RouteEnvelopesReachable(t *testing.T) {
	drain := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	h := MaxBodySizeUnless(defaultMaxBodySize, bodyCapExemptPrefixes...)(drain)

	body := bytes.Repeat([]byte("a"), 2<<20) // 2 MiB — over the global cap
	cases := []struct {
		path string
		want int
	}{
		{"/api/v1/uploads", http.StatusOK},
		{"/api/v1/admin/plugins/install", http.StatusOK},
		{"/api/v1/users/me/avatar", http.StatusOK},
		// Everything else keeps the global cap.
		{"/api/v1/channels/1/messages", http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodPost, tc.path, bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != tc.want {
			t.Errorf("%s with 2 MiB body: status = %d, want %d", tc.path, rr.Code, tc.want)
		}
	}
}
