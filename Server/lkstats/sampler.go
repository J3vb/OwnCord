package lkstats

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	// Interval is how often the sampler reads.
	Interval = 10 * time.Second
	// Horizon is how far back the ring reaches.
	Horizon = 24 * time.Hour
	// Timeout bounds one read.
	Timeout = 2 * time.Second

	ringSize = int(Horizon / Interval)
)

// Status is how the last read went.
type Status string

const (
	// StatusOK means the page was read and looks like LiveKit's.
	StatusOK Status = "ok"
	// StatusUnreachable means the read failed: network error, timeout or a
	// reply other than 200.
	StatusUnreachable Status = "unreachable"
	// StatusNotSetUp means the page answered 200 but carries no LiveKit
	// series, as when livekit.yaml has no prometheus port or the URL is wrong.
	StatusNotSetUp Status = "not_set_up"
)

// Point is one sample as the admin API serves it. A nil field is a figure the
// read could not give; a failed read is a point with every field nil.
type Point struct {
	T                int64    `json:"t"` // unix seconds
	CPU              *float64 `json:"cpu"`
	Memory           *uint64  `json:"memory"`
	Rooms            *int     `json:"rooms"`
	Participants     *int     `json:"participants"`
	TracksPublished  *int     `json:"tracks_published"`
	TracksSubscribed *int     `json:"tracks_subscribed"`
	BytesInPerSec    *float64 `json:"bytes_in_per_sec"`
	BytesOutPerSec   *float64 `json:"bytes_out_per_sec"`
}

// Snapshot is the newest sample, the status and the series over a window.
type Snapshot struct {
	Status Status
	// Since is when Status last changed; zero before the first read.
	Since  time.Time
	Latest Point
	OK     bool
	// Points is the window, oldest first, averaged down to at most the
	// requested number of points.
	Points []Point
}

// sample is one ring slot. NaN marks a missing figure.
type sample struct {
	at                     int64
	cpu, mem               float32
	rooms, parts, pub, sub float32
	bytesIn, bytesOut      float32
}

// fetchResult is one read: the figures and how it went.
type fetchResult struct {
	m      Metrics
	status Status
	reason string
}

// Sampler reads LiveKit's stats page every Interval into a fixed ring. One
// goroutine (Run) writes; Snapshot reads under the same lock.
type Sampler struct {
	fetch func(ctx context.Context) fetchResult
	now   func() time.Time
	log   *slog.Logger

	mu      syncutil.Mutex
	ring    []sample
	next    int
	size    int
	prev    Metrics
	prevAt  time.Time
	hasPrev bool
	status  Status
	since   time.Time
}

// New returns a sampler over the given metrics URL. It reads nothing until
// Run. log may be nil.
func New(url string, log *slog.Logger) *Sampler {
	if log == nil {
		log = slog.Default()
	}
	c := newClient()
	return newSampler(func(ctx context.Context) fetchResult { return fetchPage(ctx, c, url, Timeout) }, time.Now, log, ringSize)
}

func newSampler(fetch func(context.Context) fetchResult, now func() time.Time, log *slog.Logger, size int) *Sampler {
	return &Sampler{fetch: fetch, now: now, log: log, ring: make([]sample, size)}
}

// newClient builds the HTTP client for the page. The address is the
// operator's own LiveKit, typically a private Docker address, so safefetch
// (which refuses private ranges) does not apply. Redirects are not followed,
// so the page cannot send the read elsewhere, and the environment's proxy
// settings are ignored, because a proxy would not reach the Docker network.
func newClient() *http.Client {
	return &http.Client{
		Timeout: Timeout,
		Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: Timeout}).DialContext,
			MaxIdleConns:        1,
			IdleConnTimeout:     30 * time.Second,
			TLSHandshakeTimeout: Timeout,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func fetchPage(ctx context.Context, c *http.Client, url string, timeout time.Duration) fetchResult {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fetchResult{status: StatusUnreachable, reason: "bad address"}
	}
	resp, err := c.Do(req)
	if err != nil {
		return fetchResult{status: StatusUnreachable, reason: failReason(err)}
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fetchResult{status: StatusUnreachable, reason: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
	m, err := Parse(resp.Body)
	if err != nil {
		return fetchResult{status: StatusUnreachable, reason: failReason(err)}
	}
	if !m.LooksLikeLiveKit() {
		return fetchResult{status: StatusNotSetUp, reason: "no LiveKit metrics on the page"}
	}
	return fetchResult{m: m, status: StatusOK}
}

// failReason names a failed read without the error text, which carries the
// URL and so any credentials in it.
func failReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timed out"
	}
	return "connection failed"
}

// Run takes a sample now and then every Interval until ctx is done. The
// returned channel closes when the goroutine has exited.
func (s *Sampler) Run(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.sample(ctx)
		t := time.NewTicker(Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.sample(ctx)
			}
		}
	}()
	return done
}

// sample reads the page outside the lock and records it.
func (s *Sampler) sample(ctx context.Context) {
	r := s.fetch(ctx)
	if ctx.Err() != nil {
		return
	}
	at := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.noteStatus(r, at)
	sm := missing(at.Unix())
	if r.status == StatusOK {
		m := r.m
		sm.mem = optional(m.RSSBytes, m.HasRSS)
		sm.rooms = optional(m.Rooms, m.HasRooms)
		sm.parts = optional(m.Participants, m.HasParticipants)
		sm.pub = optional(m.TracksPublished, m.HasTracksPublished)
		sm.sub = optional(m.TracksSubscribed, m.HasTracksSubscribed)
		if s.hasPrev {
			// A counter that went down means LiveKit restarted; that figure
			// is skipped for this sample rather than shown as a spike.
			elapsed := at.Sub(s.prevAt).Seconds()
			sm.cpu = rate(s.prev.CPUSeconds, m.CPUSeconds, s.prev.HasCPU && m.HasCPU, elapsed, 100)
			sm.bytesIn = rate(s.prev.BytesIn, m.BytesIn, s.prev.HasBytesIn && m.HasBytesIn, elapsed, 1)
			sm.bytesOut = rate(s.prev.BytesOut, m.BytesOut, s.prev.HasBytesOut && m.HasBytesOut, elapsed, 1)
		}
		s.prev, s.prevAt, s.hasPrev = m, at, true
	} else {
		s.hasPrev = false
	}

	s.ring[s.next] = sm
	s.next = (s.next + 1) % len(s.ring)
	if s.size < len(s.ring) {
		s.size++
	}
}

// noteStatus records a status change and logs it once. The first read is
// silent when it is fine. Called with the lock held.
func (s *Sampler) noteStatus(r fetchResult, at time.Time) {
	if r.status == s.status {
		return
	}
	first := s.status == ""
	s.status, s.since = r.status, at
	switch r.status {
	case StatusUnreachable:
		s.log.Warn("lkstats: LiveKit stats page not reachable", "reason", r.reason)
	case StatusNotSetUp:
		s.log.Warn("lkstats: LiveKit stats page has no LiveKit metrics", "hint", "check the prometheus port in livekit.yaml and voice.livekit_metrics_url")
	case StatusOK:
		if !first {
			s.log.Info("lkstats: LiveKit stats page reachable again")
		}
	}
}

func missing(at int64) sample {
	nan := float32(math.NaN())
	return sample{at: at, cpu: nan, mem: nan, rooms: nan, parts: nan, pub: nan, sub: nan, bytesIn: nan, bytesOut: nan}
}

func optional(v float64, ok bool) float32 {
	if !ok {
		return float32(math.NaN())
	}
	return float32(v)
}

// rate is (cur-prev)/elapsed*scale, or NaN when a figure is missing, the
// counter went down or no time has passed.
func rate(prev, cur float64, ok bool, elapsed, scale float64) float32 {
	if !ok || cur < prev || elapsed <= 0 {
		return float32(math.NaN())
	}
	return float32((cur - prev) / elapsed * scale)
}

// Snapshot returns the status, the newest sample and the samples of the last
// window, averaged in equal runs down to at most maxPoints.
func (s *Sampler) Snapshot(window time.Duration, maxPoints int) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := Snapshot{Status: s.status, Since: s.since, Points: []Point{}}
	if s.size == 0 {
		return snap
	}
	snap.Latest, snap.OK = s.ring[(s.next-1+len(s.ring))%len(s.ring)].point(), true

	from := s.now().Add(-window).Unix()
	start := (s.next - s.size + len(s.ring)) % len(s.ring)
	var in []sample
	for i := range s.size {
		sm := s.ring[(start+i)%len(s.ring)]
		if sm.at > from {
			in = append(in, sm)
		}
	}
	snap.Points = downsample(in, maxPoints)
	return snap
}

// downsample averages consecutive runs of samples so at most maxPoints remain.
// A run is stamped with its last sample's time; a figure missing from every
// sample of a run stays missing.
func downsample(in []sample, maxPoints int) []Point {
	if maxPoints < 1 {
		maxPoints = 1
	}
	step := max((len(in)+maxPoints-1)/maxPoints, 1)
	out := make([]Point, 0, (len(in)+step-1)/step)
	for i := 0; i < len(in); i += step {
		run := in[i:min(i+step, len(in))]
		avg := sample{at: run[len(run)-1].at}
		avg.cpu = mean(run, func(s sample) float32 { return s.cpu })
		avg.mem = mean(run, func(s sample) float32 { return s.mem })
		avg.rooms = mean(run, func(s sample) float32 { return s.rooms })
		avg.parts = mean(run, func(s sample) float32 { return s.parts })
		avg.pub = mean(run, func(s sample) float32 { return s.pub })
		avg.sub = mean(run, func(s sample) float32 { return s.sub })
		avg.bytesIn = mean(run, func(s sample) float32 { return s.bytesIn })
		avg.bytesOut = mean(run, func(s sample) float32 { return s.bytesOut })
		out = append(out, avg.point())
	}
	return out
}

func mean(run []sample, field func(sample) float32) float32 {
	var sum float64
	var n int
	for _, s := range run {
		if v := field(s); !math.IsNaN(float64(v)) {
			sum += float64(v)
			n++
		}
	}
	if n == 0 {
		return float32(math.NaN())
	}
	return float32(sum / float64(n))
}

func (s sample) point() Point {
	return Point{
		T:                s.at,
		CPU:              round1(s.cpu),
		Memory:           whole(s.mem),
		Rooms:            count(s.rooms),
		Participants:     count(s.parts),
		TracksPublished:  count(s.pub),
		TracksSubscribed: count(s.sub),
		BytesInPerSec:    round1(s.bytesIn),
		BytesOutPerSec:   round1(s.bytesOut),
	}
}

// round1 rounds to one decimal; NaN is missing.
func round1(v float32) *float64 {
	if math.IsNaN(float64(v)) {
		return nil
	}
	r := math.Round(float64(v)*10) / 10
	return &r
}

func whole(v float32) *uint64 {
	if math.IsNaN(float64(v)) || v < 0 {
		return nil
	}
	b := uint64(v)
	return &b
}

func count(v float32) *int {
	if math.IsNaN(float64(v)) || v < 0 {
		return nil
	}
	n := int(math.Round(float64(v)))
	return &n
}
