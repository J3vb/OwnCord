package lkstats

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

type script struct {
	results []fetchResult
	i       int
}

func (s *script) fetch(context.Context) fetchResult {
	r := s.results[s.i]
	s.i++
	return r
}

func okM(cpu, in, out float64) fetchResult {
	return fetchResult{status: StatusOK, m: Metrics{
		CPUSeconds: cpu, HasCPU: true, RSSBytes: 1 << 20, HasRSS: true,
		Rooms: 1, HasRooms: true, Participants: 2, HasParticipants: true,
		TracksPublished: 3, HasTracksPublished: true, TracksSubscribed: 4, HasTracksSubscribed: true,
		BytesIn: in, HasBytesIn: true, BytesOut: out, HasBytesOut: true,
	}}
}

func newTest(results ...fetchResult) (*Sampler, *fakeClock, *script, *bytes.Buffer) {
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	sc := &script{results: results}
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return newSampler(sc.fetch, clk.now, log, 100), clk, sc, &buf
}

func step(s *Sampler, clk *fakeClock) {
	clk.t = clk.t.Add(Interval)
	s.sample(context.Background())
}

func TestSampler_RatesAndFirstSample(t *testing.T) {
	s, clk, _, _ := newTest(okM(10, 0, 0), okM(15, 1_000_000, 2_000_000))
	s.sample(context.Background())
	first := s.Snapshot(time.Hour, 10).Latest
	if first.CPU != nil || first.BytesInPerSec != nil {
		t.Errorf("first sample has nothing to measure from: %+v", first)
	}
	if first.Rooms == nil || *first.Rooms != 1 || *first.Memory != 1<<20 {
		t.Errorf("gauges are available on the first sample: %+v", first)
	}
	step(s, clk)
	p := s.Snapshot(time.Hour, 10).Latest
	if p.CPU == nil || *p.CPU != 50 {
		t.Errorf("cpu = %v, want 50 (5 s over 10 s of one core)", p.CPU)
	}
	if p.BytesInPerSec == nil || *p.BytesInPerSec != 100000 || *p.BytesOutPerSec != 200000 {
		t.Errorf("bytes/s = %v %v", p.BytesInPerSec, p.BytesOutPerSec)
	}
}

func TestSampler_CounterResetSkipped(t *testing.T) {
	s, clk, _, _ := newTest(okM(1000, 9e9, 9e9), okM(2, 100, 100), okM(3, 600, 1100))
	s.sample(context.Background())
	step(s, clk)
	p := s.Snapshot(time.Hour, 10).Latest
	if p.CPU != nil || p.BytesInPerSec != nil || p.BytesOutPerSec != nil {
		t.Errorf("a restart (counters went down) must give no rate, got %+v", p)
	}
	if p.Rooms == nil {
		t.Error("gauges still show after a restart")
	}
	step(s, clk)
	p = s.Snapshot(time.Hour, 10).Latest
	if p.CPU == nil || *p.CPU != 10 || *p.BytesInPerSec != 50 {
		t.Errorf("rates resume from the new baseline: %+v", p)
	}
	for _, pt := range s.Snapshot(time.Hour, 10).Points {
		if pt.CPU != nil && (*pt.CPU < 0 || *pt.CPU > 100) {
			t.Errorf("spike in series: %v", *pt.CPU)
		}
	}
}

func TestSampler_UnreachableGapAndSince(t *testing.T) {
	down := fetchResult{status: StatusUnreachable, reason: "timed out"}
	s, clk, _, buf := newTest(okM(10, 0, 0), down, down, okM(20, 0, 0), okM(25, 0, 0))
	s.sample(context.Background())
	step(s, clk)
	downAt := clk.t
	step(s, clk)
	snap := s.Snapshot(time.Hour, 10)
	if snap.Status != StatusUnreachable || !snap.Since.Equal(downAt) {
		t.Errorf("status %q since %v, want unreachable since %v", snap.Status, snap.Since, downAt)
	}
	if snap.Latest.CPU != nil || snap.Latest.Memory != nil || snap.Latest.Rooms != nil {
		t.Errorf("a failed read stores a gap: %+v", snap.Latest)
	}
	step(s, clk)
	if p := s.Snapshot(time.Hour, 10).Latest; p.CPU != nil {
		t.Errorf("first read after a gap has no rate: %+v", p)
	}
	step(s, clk)
	snap = s.Snapshot(time.Hour, 10)
	if snap.Status != StatusOK || snap.Latest.CPU == nil || *snap.Latest.CPU != 50 {
		t.Errorf("recovered: %+v", snap)
	}
	if n := strings.Count(buf.String(), "not reachable"); n != 1 {
		t.Errorf("unreachable logged %d times, want once:\n%s", n, buf.String())
	}
	if !strings.Contains(buf.String(), "reachable again") {
		t.Errorf("recovery should be logged:\n%s", buf.String())
	}
}

func TestSampler_NotSetUpLoggedOnce(t *testing.T) {
	ns := fetchResult{status: StatusNotSetUp}
	s, clk, _, buf := newTest(ns, ns, ns)
	s.sample(context.Background())
	step(s, clk)
	step(s, clk)
	snap := s.Snapshot(time.Hour, 10)
	if snap.Status != StatusNotSetUp {
		t.Fatalf("status %q", snap.Status)
	}
	if n := strings.Count(buf.String(), "no LiveKit metrics"); n != 1 {
		t.Errorf("logged %d times, want once:\n%s", n, buf.String())
	}
	if strings.Count(buf.String(), "\n") != 1 {
		t.Errorf("expected exactly one log line:\n%s", buf.String())
	}
}

func TestSampler_HealthyStartIsSilent(t *testing.T) {
	s, clk, _, buf := newTest(okM(1, 0, 0), okM(2, 0, 0))
	s.sample(context.Background())
	step(s, clk)
	if buf.Len() != 0 {
		t.Errorf("a healthy sampler logs nothing: %s", buf.String())
	}
}

func TestSampler_WindowAndDownsample(t *testing.T) {
	var rs []fetchResult
	for i := range 10 {
		rs = append(rs, okM(float64(i), 0, 0))
	}
	s, clk, _, _ := newTest(rs...)
	s.sample(context.Background())
	for range 9 {
		step(s, clk)
	}
	if n := len(s.Snapshot(time.Hour, 100).Points); n != 10 {
		t.Errorf("points = %d, want 10", n)
	}
	if n := len(s.Snapshot(time.Hour, 5).Points); n != 5 {
		t.Errorf("downsampled points = %d, want 5", n)
	}
	if n := len(s.Snapshot(35*time.Second, 100).Points); n != 4 {
		t.Errorf("35 s window points = %d, want 4", n)
	}
}

func TestSampler_EmptySnapshot(t *testing.T) {
	s, _, _, _ := newTest()
	snap := s.Snapshot(time.Hour, 10)
	if snap.OK || snap.Status != "" || snap.Points == nil {
		t.Errorf("%+v", snap)
	}
}

func TestFetchPage(t *testing.T) {
	livekit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(samplePage))
	}))
	defer livekit.Close()
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>welcome</html>"))
	}))
	defer html.Close()
	notFound := httptest.NewServer(http.NotFoundHandler())
	defer notFound.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, livekit.URL, http.StatusFound)
	}))
	defer redirect.Close()
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer slow.Close()

	c := newClient()
	cases := []struct {
		name string
		url  string
		want Status
	}{
		{"livekit", livekit.URL, StatusOK},
		{"page without metrics", html.URL, StatusNotSetUp},
		{"404", notFound.URL, StatusUnreachable},
		{"redirect not followed", redirect.URL, StatusUnreachable},
		{"timeout", slow.URL, StatusUnreachable},
		{"refused", "http://127.0.0.1:1/metrics", StatusUnreachable},
	}
	for _, tc := range cases {
		start := time.Now()
		got := fetchPage(context.Background(), c, tc.url, 200*time.Millisecond)
		if got.status != tc.want {
			t.Errorf("%s: status %q (%s), want %q", tc.name, got.status, got.reason, tc.want)
		}
		if time.Since(start) > 2*time.Second {
			t.Errorf("%s: took %v, the read must give up at its timeout", tc.name, time.Since(start))
		}
	}
	if got := fetchPage(context.Background(), c, slow.URL, 100*time.Millisecond); got.reason != "timed out" {
		t.Errorf("timeout reason = %q", got.reason)
	}
}

func TestSampler_TimeoutThenRecover(t *testing.T) {
	var hang bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hang {
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte(samplePage))
	}))
	defer srv.Close()
	c := newClient()
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	s := newSampler(func(ctx context.Context) fetchResult { return fetchPage(ctx, c, srv.URL, 100*time.Millisecond) }, clk.now, log, 50)
	s.sample(context.Background())
	hang = true
	step(s, clk)
	snap := s.Snapshot(time.Hour, 10)
	if snap.Status != StatusUnreachable || snap.Latest.CPU != nil || snap.Since.IsZero() {
		t.Errorf("a timed-out read is a gap, unreachable since now: %+v", snap)
	}
	if !strings.Contains(buf.String(), "timed out") {
		t.Errorf("reason should be logged: %s", buf.String())
	}
}

func TestRun_StopsOnCancel(t *testing.T) {
	s, _, _, _ := newTest(okM(1, 0, 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := s.Run(ctx)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit on cancel")
	}
}
