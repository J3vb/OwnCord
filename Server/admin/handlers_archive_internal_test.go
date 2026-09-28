package admin

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// slowSource yields chunks of size bytes, one every gap, n times.
type slowSource struct {
	size, n int
	gap     time.Duration
}

func (s *slowSource) Read(b []byte) (int, error) {
	if s.n == 0 {
		return 0, io.EOF
	}
	time.Sleep(s.gap)
	s.n--
	return copy(b, make([]byte, min(s.size, len(b)))), nil
}

// serveProgressing streams a slow source through archiveProgressWriter over a
// connection whose deadlines start as one fixed window, and returns how many
// bytes the client received out of want.
func serveProgressing(t *testing.T, fixedWindow, lifetime time.Duration) (got, want int) {
	t.Helper()
	const chunk, chunks = 1024, 40
	gap := fixedWindow / 8
	want = chunk * chunks
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		p := archiveProgressWriter{
			w:     w,
			ctl:   http.NewResponseController(w),
			idle:  fixedWindow,
			until: time.Now().Add(lifetime),
		}
		p.setDeadlines(time.Now().Add(fixedWindow))
		w.Header().Set("Content-Length", strconv.Itoa(want))
		_, _ = io.Copy(p, &slowSource{size: chunk, n: chunks, gap: gap})
	}))
	srv.Config.WriteTimeout = fixedWindow
	srv.Start()
	t.Cleanup(srv.Close)

	res, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close() //nolint:errcheck
	body, _ := io.ReadAll(res.Body)
	return len(body), want
}

// A slow but steadily progressing download runs far past a single fixed
// window (40 chunks at window/8 apart is five windows) and still completes.
func TestArchiveProgressWriter_ProgressingDownloadOutlivesFixedWindow(t *testing.T) {
	got, want := serveProgressing(t, 400*time.Millisecond, time.Minute)
	if got != want {
		t.Fatalf("received %d of %d bytes; a progressing download was cut off", got, want)
	}
}

// However it progresses, the download ends at the lifetime cap.
func TestArchiveProgressWriter_LifetimeCapsDownload(t *testing.T) {
	got, want := serveProgressing(t, 400*time.Millisecond, 600*time.Millisecond)
	if got >= want {
		t.Fatalf("received all %d bytes; the lifetime cap did not end the download", got)
	}
}
