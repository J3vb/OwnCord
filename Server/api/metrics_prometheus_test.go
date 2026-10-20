package api_test

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// promWindowFixture is a fake sampler answering both windows with different
// figures, so a series reading the wrong window cannot match its JSON twin.
func promWindowFixture(d time.Duration) (metrics.WindowSnapshot, bool) {
	k := float64(d / time.Minute) // 1 for "1m", 15 for "15m"
	scale := uint64(k)
	return metrics.WindowSnapshot{
		Seconds: d.Seconds(),
		AsOf:    time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC),
		Histograms: map[string]metrics.Summary{
			"ws_broadcast_ms":        {Count: 52 * scale, P50: 1, P95: 5, P99: 20, Max: 18.4 * k},
			"ws_dispatch_lag_ms":     {Count: 4 * scale, Max: 9 * k},
			"chat_send_ack_ms":       {Count: 8 * scale, Max: 11 * k},
			"voice_join_ms.precheck": {Count: scale, Max: 1 * k},
			"voice_join_ms.leave":    {Count: scale, Max: 2 * k},
			"voice_join_ms.persist":  {Count: scale, Max: 3 * k},
			"voice_join_ms.token":    {Count: scale, Max: 4 * k},
			"voice_join_ms.complete": {Count: scale, Max: 5 * k},
			"voice_join_ms.total":    {Count: scale, P95: 50, Max: 6 * k},
		},
		MaxGauges: map[string]float64{"hub_seqmu_max_hold_ms": 3.1 * k},
		Counters:  map[string]uint64{"broadcast_drops": scale, "db_writer_wait_nanos": 2_500_000_000},
	}, true
}

// promSampleLine is one parsed sample.
type promSampleLine struct {
	name   string
	labels map[string]string
	value  float64
}

// promFam is one parsed family.
type promFam struct {
	name, typ, help string
	samples         []promSampleLine
}

var (
	promSampleRe = regexp.MustCompile(`^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$`)
	promLabelRe  = regexp.MustCompile(`^([a-z_]+)="([^"]*)"$`)
	promValueRe  = regexp.MustCompile(`^[a-z0-9_]+$`)
)

// parseProm is the default-build grammar check (promtool is not available
// here, and prometheus/common must not become a direct import): every line is a
// HELP, TYPE or sample line; a family's HELP and TYPE appear once, in that
// order, before its samples; a sample belongs to the family just opened; no
// series repeats; and each histogram is cumulative with +Inf == _count.
func parseProm(t *testing.T, text string) []*promFam {
	t.Helper()
	if text == "" || !strings.HasSuffix(text, "\n") {
		t.Fatalf("exposition must end with a newline, got %q", text)
	}
	var fams []*promFam
	seenFam := map[string]bool{}
	seenSeries := map[string]bool{}
	var cur *promFam
	pendingTypeFor := ""
	for i, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		fail := func(format string, args ...any) {
			t.Helper()
			t.Fatalf("line %d %q: "+format, append([]any{i + 1, line}, args...)...)
		}
		switch {
		case strings.HasPrefix(line, "# HELP "):
			if pendingTypeFor != "" {
				fail("HELP while the TYPE of %q is still pending", pendingTypeFor)
			}
			name, help, _ := strings.Cut(strings.TrimPrefix(line, "# HELP "), " ")
			if seenFam[name] {
				fail("family %q declared twice", name)
			}
			seenFam[name] = true
			if strings.Contains(help, "\n") || regexp.MustCompile(`\\[^\\n]`).MatchString(help) {
				fail("HELP has an unescaped backslash")
			}
			cur = &promFam{name: name, help: help}
			fams = append(fams, cur)
			pendingTypeFor = name
		case strings.HasPrefix(line, "# TYPE "):
			name, typ, _ := strings.Cut(strings.TrimPrefix(line, "# TYPE "), " ")
			if name != pendingTypeFor || cur == nil {
				fail("TYPE for %q does not follow its HELP", name)
			}
			if typ != "counter" && typ != "gauge" && typ != "histogram" {
				fail("unknown type %q", typ)
			}
			cur.typ = typ
			pendingTypeFor = ""
		case strings.HasPrefix(line, "#"):
			fail("comment that is neither HELP nor TYPE")
		default:
			if cur == nil || pendingTypeFor != "" {
				fail("sample before its family's HELP and TYPE")
			}
			m := promSampleRe.FindStringSubmatch(line)
			if m == nil {
				fail("not a sample line")
			}
			s := promSampleLine{name: m[1], labels: map[string]string{}}
			if m[2] != "" {
				for kv := range strings.SplitSeq(m[2], ",") {
					lm := promLabelRe.FindStringSubmatch(kv)
					if lm == nil {
						fail("bad label %q", kv)
					}
					// Label values are compile-time constants matching
					// [a-z0-9_]+, which the writer relies on to skip escaping;
					// only a histogram bound may carry digits and a dot.
					if lm[1] != "le" && !promValueRe.MatchString(lm[2]) {
						fail("label %s value %q is outside [a-z0-9_]+", lm[1], lm[2])
					}
					s.labels[lm[1]] = lm[2]
				}
			}
			v, err := strconv.ParseFloat(m[3], 64)
			if err != nil {
				fail("value: %v", err)
			}
			s.value = v
			ok := s.name == cur.name
			if cur.typ == "histogram" {
				ok = s.name == cur.name+"_bucket" || s.name == cur.name+"_sum" || s.name == cur.name+"_count"
			}
			if !ok {
				fail("sample %q does not belong to the open family %q", s.name, cur.name)
			}
			key := s.name + "|" + canonLabels(s.labels)
			if seenSeries[key] {
				fail("duplicate series")
			}
			seenSeries[key] = true
			cur.samples = append(cur.samples, s)
		}
	}
	if pendingTypeFor != "" {
		t.Fatalf("family %q has no TYPE line", pendingTypeFor)
	}
	for _, f := range fams {
		if f.typ == "histogram" {
			checkPromHistogram(t, f)
		}
	}
	return fams
}

func canonLabels(l map[string]string) string {
	keys := make([]string, 0, len(l))
	for k := range l {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k + "=" + l[k] + ",")
	}
	return b.String()
}

// checkPromHistogram checks every label set of histogram f: buckets in
// increasing le order and non-decreasing, ending at +Inf, with +Inf == _count
// and a _sum.
func checkPromHistogram(t *testing.T, f *promFam) {
	t.Helper()
	type series struct {
		prevLe, prev, inf, count float64
		buckets                  int
		sawInf, sawSum, sawCount bool
	}
	by := map[string]*series{}
	for _, s := range f.samples {
		other := map[string]string{}
		for k, v := range s.labels {
			if k != "le" {
				other[k] = v
			}
		}
		k := canonLabels(other)
		sr := by[k]
		if sr == nil {
			sr = &series{}
			by[k] = sr
		}
		switch s.name {
		case f.name + "_bucket":
			le, err := strconv.ParseFloat(s.labels["le"], 64)
			if err != nil {
				t.Fatalf("%s: le %q: %v", f.name, s.labels["le"], err)
			}
			if sr.sawInf {
				t.Errorf("%s{%s}: bucket after +Inf", f.name, k)
			}
			if sr.buckets > 0 && le <= sr.prevLe {
				t.Errorf("%s{%s}: le %v not increasing", f.name, k, le)
			}
			if s.value < sr.prev {
				t.Errorf("%s{%s}: bucket le=%v decreases (%v < %v)", f.name, k, le, s.value, sr.prev)
			}
			sr.prevLe, sr.prev = le, s.value
			sr.buckets++
			if s.labels["le"] == "+Inf" {
				sr.sawInf, sr.inf = true, s.value
			}
		case f.name + "_sum":
			sr.sawSum = true
		case f.name + "_count":
			sr.sawCount, sr.count = true, s.value
		}
	}
	for k, sr := range by {
		if !sr.sawInf || !sr.sawSum || !sr.sawCount {
			t.Errorf("%s{%s}: missing +Inf, _sum or _count", f.name, k)
		} else if sr.inf != sr.count {
			t.Errorf("%s{%s}: +Inf = %v but _count = %v", f.name, k, sr.inf, sr.count)
		}
	}
}

// promFind returns the value of the sample name with exactly the given labels
// (key, value, key, value...).
func promFind(fams []*promFam, name string, kv ...string) (float64, bool) {
	want := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		want[kv[i]] = kv[i+1]
	}
	for _, f := range fams {
		for _, s := range f.samples {
			if s.name == name && reflect.DeepEqual(s.labels, want) {
				return s.value, true
			}
		}
	}
	return 0, false
}

func promFamily(fams []*promFam, name string) *promFam {
	for _, f := range fams {
		if f.name == name {
			return f
		}
	}
	return nil
}

// fullPromSources is the shared fullMetricsSources plus all six voice phases, both windows and a count for
// every latency histogram, so every family has a source.
func fullPromSources() api.MetricsSources {
	src := fullMetricsSources()
	src.VoiceJoinMs = func() ws.VoiceJoinPhases {
		s := func(max float64) metrics.Summary { return metrics.Summary{Count: 2, P50: 1, P95: 2, P99: 3, Max: max} }
		return ws.VoiceJoinPhases{Precheck: s(1), Leave: s(2), Persist: s(3), Token: s(4), Complete: s(5), Total: s(6)}
	}
	src.Windows = promWindowFixture
	src.LatencyCounts = fullLatencyCounts
	return src
}

// fullLatencyCounts has one histogram per name the hub reports, each holding
// exactly as many observations as the JSON summary of the same name, so the
// _count series can be compared with the JSON count.
func fullLatencyCounts() ws.LatencyCounts {
	counts := ws.LatencyCounts{}
	for name, n := range map[string]int{
		"ws_broadcast_ms": 10, "ws_dispatch_lag_ms": 4, "chat_send_ack_ms": 8,
		"voice_join_ms.precheck": 2, "voice_join_ms.leave": 2, "voice_join_ms.persist": 2,
		"voice_join_ms.token": 2, "voice_join_ms.complete": 2, "voice_join_ms.total": 2,
	} {
		var h metrics.Histogram
		for range n - 1 {
			h.Observe(3)
		}
		h.Observe(7000)
		counts[name] = h.Counts()
	}
	return counts
}

// scrapeProm runs the handler once and returns the response and parsed text.
func scrapeProm(t *testing.T, src api.MetricsSources) (*httptest.ResponseRecorder, []*promFam) {
	t.Helper()
	rr := httptest.NewRecorder()
	api.HandlePrometheusMetricsForTest(src).ServeHTTP(rr,
		httptest.NewRequest(http.MethodGet, "/api/v1/metrics/prometheus", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
	}
	return rr, parseProm(t, rr.Body.String())
}

// wantFamilies is every family the exposition can emit.
var wantFamilies = map[string]string{
	"owncord_uptime_seconds": "gauge", "owncord_goroutines": "gauge",
	"owncord_heap_alloc_bytes": "gauge", "owncord_heap_sys_bytes": "gauge",
	"owncord_gc_cycles_total": "counter", "owncord_connected_users": "gauge",
	"owncord_voice_sessions": "gauge", "owncord_broadcast_drops_total": "counter",
	"owncord_topic_sheds_total": "counter", "owncord_delivery_loss_marks_total": "counter",
	"owncord_ws_conn_rejects_total": "counter", "owncord_ws_broadcast_seconds": "histogram",
	"owncord_ws_dispatch_lag_seconds": "histogram", "owncord_chat_send_ack_seconds": "histogram",
	"owncord_voice_join_seconds": "histogram", "owncord_latency_max_seconds": "gauge",
	"owncord_hub_broadcast_queue_depth": "gauge", "owncord_reconnect_tier_total": "counter",
	"owncord_backpressure_total": "counter", "owncord_db_wait_total": "counter",
	"owncord_db_wait_seconds_total": "counter", "owncord_perm_cache_lookups_total": "counter",
	"owncord_push_total": "counter", "owncord_event_persister_total": "counter",
	"owncord_livekit_healthy": "gauge", "owncord_disk_free_bytes": "gauge",
	"owncord_disk_min_free_bytes": "gauge", "owncord_disk_low": "gauge",
	"owncord_upload_storage_used_bytes": "gauge", "owncord_db_wal_bytes": "gauge",
}

// TestPromText_GrammarAndUniqueFamilies scrapes a fully wired handler and
// checks the grammar (see parseProm), that every family appears once with the
// right type, and that the Content-Type is the 0.0.4 text type.
func TestPromText_GrammarAndUniqueFamilies(t *testing.T) {
	rr, fams := scrapeProm(t, fullPromSources())
	if got, want := rr.Header().Get("Content-Type"), "text/plain; version=0.0.4; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	seen := map[string]bool{}
	for _, f := range fams {
		if seen[f.name] {
			t.Errorf("family %q appears twice", f.name)
		}
		seen[f.name] = true
		if want, ok := wantFamilies[f.name]; !ok {
			t.Errorf("unexpected family %q", f.name)
		} else if f.typ != want {
			t.Errorf("family %q type = %s, want %s", f.name, f.typ, want)
		}
		if f.help == "" {
			t.Errorf("family %q has no HELP", f.name)
		}
		if len(f.samples) == 0 {
			t.Errorf("family %q has no samples", f.name)
		}
	}
	for name := range wantFamilies {
		if !seen[name] {
			t.Errorf("family %q missing from a fully wired scrape", name)
		}
	}
}

// TestPrometheusMetrics_AbsentSourcesOmitFamilies is edge case 2: with no
// LiveKit probe, no event persister, no disk reading, no upload total, no
// histogram counts and no windows, the families that depend on them are left
// out cleanly and the rest is still valid.
func TestPrometheusMetrics_AbsentSourcesOmitFamilies(t *testing.T) {
	_, fams := scrapeProm(t, api.MetricsSources{
		ConnectedUsers: func() int { return 1 },
		PersisterStats: func() (uint64, uint64, uint64, uint64, bool) { return 0, 0, 0, 0, false },
	})
	for _, name := range []string{
		"owncord_livekit_healthy", "owncord_event_persister_total", "owncord_disk_free_bytes",
		"owncord_disk_low", "owncord_upload_storage_used_bytes", "owncord_db_wal_bytes", "owncord_ws_broadcast_seconds",
		"owncord_ws_dispatch_lag_seconds", "owncord_chat_send_ack_seconds", "owncord_voice_join_seconds",
	} {
		if promFamily(fams, name) != nil {
			t.Errorf("family %q present with no source", name)
		}
	}
	if v, ok := promFind(fams, "owncord_connected_users"); !ok || v != 1 {
		t.Errorf("owncord_connected_users = %v, %v; want 1", v, ok)
	}
	// Without windows or latency summaries only the always-present worst hold
	// remains, and only for the lifetime.
	mx := promFamily(fams, "owncord_latency_max_seconds")
	if mx == nil || len(mx.samples) != 1 || mx.samples[0].labels["window"] != "lifetime" || mx.samples[0].labels["metric"] != "hub_seqmu_hold" {
		t.Errorf("owncord_latency_max_seconds = %+v, want only hub_seqmu_hold/lifetime", mx)
	}
}

// TestPrometheusMetrics_WindowNotReadyIsAbsent: a window the sampler cannot
// answer yet has no max series, so nothing reports a reassuring zero.
func TestPrometheusMetrics_WindowNotReadyIsAbsent(t *testing.T) {
	src := fullPromSources()
	src.Windows = func(d time.Duration) (metrics.WindowSnapshot, bool) {
		if d > time.Minute {
			return metrics.WindowSnapshot{}, false
		}
		return promWindowFixture(d)
	}
	_, fams := scrapeProm(t, src)
	if _, ok := promFind(fams, "owncord_latency_max_seconds", "metric", "ws_broadcast", "window", "1m"); !ok {
		t.Error("1m max missing though the 1m window is ready")
	}
	if _, ok := promFind(fams, "owncord_latency_max_seconds", "metric", "ws_broadcast", "window", "15m"); ok {
		t.Error("15m max present though the 15m window is not ready")
	}
	if _, ok := promFind(fams, "owncord_latency_max_seconds", "metric", "ws_broadcast", "window", "lifetime"); !ok {
		t.Error("lifetime max missing")
	}
}

// promVolatile are the runtime figures that move between the two reads (one
// for the JSON, one for the scrape), so they are compared within a tolerance
// instead of exactly. The tolerance is still far tighter than a unit mix-up.
var promVolatile = map[string]struct{ rel, abs float64 }{
	"uptime_seconds": {0, 5},
	"goroutines":     {1, 50},
	"heap_alloc_mb":  {0.5, 0},
	"heap_sys_mb":    {0.5, 0},
	"num_gc":         {0, 5},
}

// jsonValue resolves a promFieldMap path in the decoded JSON, with win standing
// for "*". Booleans become 0 or 1.
func jsonValue(t *testing.T, resp map[string]any, path, win string) (float64, bool) {
	t.Helper()
	var cur any = resp
	for seg := range strings.SplitSeq(path, ".") {
		if seg == "*" {
			seg = win
		}
		m, ok := cur.(map[string]any)
		if !ok {
			return 0, false
		}
		if cur, ok = m[seg]; !ok {
			return 0, false
		}
	}
	switch v := cur.(type) {
	case float64:
		return v, true
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	}
	t.Fatalf("JSON path %s is %T, not a number or bool", path, cur)
	return 0, false
}

// TestPrometheusMetrics_MatchesJSON feeds one set of sources to both encoders
// and, for every mapped JSON field (both windows included), compares the JSON
// value converted to base units with its Prometheus series. A series reading
// the wrong source, the wrong window or the wrong unit fails here.
func TestPrometheusMetrics_MatchesJSON(t *testing.T) {
	src := fullPromSources()
	js := getMetrics(t, src)
	_, fams := scrapeProm(t, src)

	checked := 0
	for path, sel := range promFieldMap() {
		wins := []string{""}
		if strings.Contains(path, "*") {
			wins = []string{"1m", "15m"}
		}
		for _, win := range wins {
			want, ok := jsonValue(t, js, path, win)
			if !ok {
				t.Errorf("%s: no JSON value in a fully wired response", path)
				continue
			}
			leaf := path[strings.LastIndex(path, ".")+1:]
			switch {
			case leaf == "max" || strings.HasSuffix(leaf, "_ms"):
				want /= 1000
			case strings.HasSuffix(leaf, "_mb"):
				want *= 1024 * 1024
			}
			kv := make([]string, len(sel.kv))
			for i, v := range sel.kv {
				kv[i] = v
				if v == "@" {
					kv[i] = win
				}
			}
			got, ok := promFind(fams, sel.name, kv...)
			if !ok {
				t.Errorf("%s: series %s%v missing", path, sel.name, kv)
				continue
			}
			tol := promVolatile[path]
			if diff := math.Abs(got - want); diff > tol.abs+tol.rel*math.Abs(want)+1e-9*math.Abs(want) {
				t.Errorf("%s (window %q): %s%v = %v, JSON converted = %v", path, win, sel.name, kv, got, want)
			}
			checked++
		}
	}
	if checked < 70 {
		t.Errorf("compared only %d series; the mapping walk is not reaching them", checked)
	}

	// _sum has no JSON twin: it comes from the raw counts.
	raw := src.LatencyCounts()["voice_join_ms.persist"]
	if got, _ := promFind(fams, "owncord_voice_join_seconds_sum", "phase", "persist"); got != float64(raw.SumMicros)/1e6 {
		t.Errorf("voice persist _sum = %v, want %v", got, float64(raw.SumMicros)/1e6)
	}
}

// TestPrometheusMetrics_ScrapeRacingObservations is edge case 1: observations
// landing while scrapes run never break +Inf == _count (parseProm checks it on
// every scrape).
func TestPrometheusMetrics_ScrapeRacingObservations(t *testing.T) {
	var h metrics.Histogram
	src := api.MetricsSources{LatencyCounts: func() ws.LatencyCounts {
		return ws.LatencyCounts{"ws_broadcast_ms": h.Counts()}
	}}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func(ctx context.Context, ms float64) {
			defer wg.Done()
			for ctx.Err() == nil {
				h.Observe(ms)
			}
		}(ctx, float64(i*i)*7)
	}
	for range 200 {
		scrapeProm(t, src)
	}
	cancel()
	wg.Wait()
}

func TestPrometheusMetrics_AdminIPRestrict(t *testing.T) {
	build := func(cidrs []string) http.Handler {
		r := chi.NewRouter()
		r.With(api.AdminIPRestrict("server.metrics_allowed_cidrs", cidrs, nil)).
			Get("/api/v1/metrics/prometheus", api.HandlePrometheusMetricsForTest(fullPromSources()))
		return r
	}
	for _, tc := range []struct {
		name  string
		cidrs []string
		addr  string
		want  int
	}{
		{"blocks outside the perimeter", []string{"10.0.0.0/8"}, "192.168.1.1:9999", http.StatusForbidden},
		{"allows inside the perimeter", []string{"127.0.0.0/8"}, "127.0.0.1:9999", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics/prometheus", nil)
			req.RemoteAddr = tc.addr
			rr := httptest.NewRecorder()
			build(tc.cidrs).ServeHTTP(rr, req)
			if rr.Code != tc.want {
				t.Errorf("status = %d, want %d; body: %s", rr.Code, tc.want, rr.Body.String())
			}
		})
	}
}

// TestPrometheusMetrics_LiveRouter requests the endpoint from the production
// router, in whichever build runs, with a real hub: the route is mounted, the
// perimeter admits loopback, and every histogram family has its hub source.
func TestPrometheusMetrics_LiveRouter(t *testing.T) {
	handler := fullRouter(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics/prometheus", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "text/plain; version=0.0.4; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	fams := parseProm(t, rr.Body.String())
	for _, name := range []string{
		"owncord_uptime_seconds", "owncord_ws_broadcast_seconds", "owncord_ws_dispatch_lag_seconds",
		"owncord_chat_send_ack_seconds", "owncord_voice_join_seconds", "owncord_latency_max_seconds",
		"owncord_reconnect_tier_total", "owncord_db_wait_total", "owncord_perm_cache_lookups_total",
		"owncord_disk_min_free_bytes",
	} {
		if promFamily(fams, name) == nil {
			t.Errorf("family %q missing from the live router", name)
		}
	}
}

// metricsPathSel is a Prometheus selector for one sample.
type metricsPathSel struct {
	name string
	kv   []string
}

func sel(name string, kv ...string) metricsPathSel { return metricsPathSel{name, kv} }

// promFieldMap maps every ServerMetrics JSON leaf to the sample that carries
// it. The "@" in a path stands for either window key.
func promFieldMap() map[string]metricsPathSel {
	m := map[string]metricsPathSel{
		"uptime_seconds": sel("owncord_uptime_seconds"), "goroutines": sel("owncord_goroutines"),
		"heap_alloc_mb": sel("owncord_heap_alloc_bytes"), "heap_sys_mb": sel("owncord_heap_sys_bytes"),
		"num_gc": sel("owncord_gc_cycles_total"), "connected_users": sel("owncord_connected_users"),
		"voice_sessions": sel("owncord_voice_sessions"), "broadcast_drops": sel("owncord_broadcast_drops_total"),
		"topic_sheds_total": sel("owncord_topic_sheds_total"), "livekit_healthy": sel("owncord_livekit_healthy"),
		"hub_broadcast_queue_depth":       sel("owncord_hub_broadcast_queue_depth"),
		"hub_seqmu_max_hold_ms":           sel("owncord_latency_max_seconds", "metric", "hub_seqmu_hold", "window", "lifetime"),
		"windows.*.hub_seqmu_max_hold_ms": sel("owncord_latency_max_seconds", "metric", "hub_seqmu_hold", "window", "@"),
		"reconnect_tier_buffer":           sel("owncord_reconnect_tier_total", "tier", "buffer"),
		"reconnect_tier_db":               sel("owncord_reconnect_tier_total", "tier", "db"),
		"reconnect_tier_full":             sel("owncord_reconnect_tier_total", "tier", "full"),
		"backpressure_queue_disconnects":  sel("owncord_backpressure_total", "kind", "queue_disconnect"),
		"backpressure_high_fallbacks":     sel("owncord_backpressure_total", "kind", "high_fallback"),
		"backpressure_low_drops":          sel("owncord_backpressure_total", "kind", "low_drop"),
		"backpressure_presence_drops":     sel("owncord_backpressure_total", "kind", "presence_drop"),
		"delivery_loss_marks":             sel("owncord_delivery_loss_marks_total"),
		"ws_conn_rejects":                 sel("owncord_ws_conn_rejects_total"),
		"disk_free_mb":                    sel("owncord_disk_free_bytes"),
		"disk_min_free_mb":                sel("owncord_disk_min_free_bytes"),
		"disk_low":                        sel("owncord_disk_low"),
		"upload_storage_used_mb":          sel("owncord_upload_storage_used_bytes"),
		"db_wal_mb":                       sel("owncord_db_wal_bytes"),
		"db_writer_wait_count":            sel("owncord_db_wait_total", "pool", "writer"),
		"db_writer_wait_seconds":          sel("owncord_db_wait_seconds_total", "pool", "writer"),
		"db_reader_wait_count":            sel("owncord_db_wait_total", "pool", "reader"),
		"db_reader_wait_seconds":          sel("owncord_db_wait_seconds_total", "pool", "reader"),
		"perm_cache_hits":                 sel("owncord_perm_cache_lookups_total", "result", "hit"),
		"perm_cache_misses":               sel("owncord_perm_cache_lookups_total", "result", "miss"),
		"push_dispatched":                 sel("owncord_push_total", "result", "dispatched"),
		"push_failed":                     sel("owncord_push_total", "result", "failed"),
		"push_pruned":                     sel("owncord_push_total", "result", "pruned"),
		"event_persister.persisted":       sel("owncord_event_persister_total", "kind", "persisted"),
		"event_persister.dropped":         sel("owncord_event_persister_total", "kind", "dropped"),
		"event_persister.flushes":         sel("owncord_event_persister_total", "kind", "flushes"),
		"event_persister.errors":          sel("owncord_event_persister_total", "kind", "errors"),
	}
	for key, hist := range map[string]struct{ family, metric string }{
		"ws_broadcast_ms":    {"owncord_ws_broadcast_seconds", "ws_broadcast"},
		"ws_dispatch_lag_ms": {"owncord_ws_dispatch_lag_seconds", "ws_dispatch_lag"},
		"chat_send_ack_ms":   {"owncord_chat_send_ack_seconds", "chat_send_ack"},
	} {
		m[key+".count"] = sel(hist.family + "_count")
		m[key+".max"] = sel("owncord_latency_max_seconds", "metric", hist.metric, "window", "lifetime")
		m["windows.*."+key+".max"] = sel("owncord_latency_max_seconds", "metric", hist.metric, "window", "@")
	}
	for _, phase := range []string{"precheck", "leave", "persist", "token", "complete", "total"} {
		key := "voice_join_ms." + phase
		m[key+".count"] = sel("owncord_voice_join_seconds_count", "phase", phase)
		m[key+".max"] = sel("owncord_latency_max_seconds", "metric", "voice_join_"+phase, "window", "lifetime")
		m["windows.*."+key+".max"] = sel("owncord_latency_max_seconds", "metric", "voice_join_"+phase, "window", "@")
	}
	return m
}

// promExclusions are the JSON leaves with no Prometheus series, by pattern,
// each with the reason. A pattern that matches no leaf fails the guard.
var promExclusions = []struct{ pattern, reason string }{
	{`^uptime$`, "a formatted duration string; uptime_seconds carries the number"},
	{`\.(p50|p95|p99)$`, "a bucket-bound quantile estimate; histogram_quantile() over the exported buckets is the Prometheus way"},
	{`^windows\.\*\.(seconds|as_of)$`, "window metadata; Prometheus windows itself with rate() and increase()"},
	{`^windows\.\*\.(ws_broadcast_ms|ws_dispatch_lag_ms|chat_send_ack_ms|voice_join_ms\.[a-z]+)\.count$`, "a windowed count; increase() over the histogram covers it"},
	{`^windows\.\*\.(broadcast_drops|topic_sheds_total|reconnect_tier_[a-z]+|backpressure_[a-z_]+|delivery_loss_marks|ws_conn_rejects|db_[a-z_]+)$`, "a windowed counter delta; rate() and increase() over the cumulative counter cover it"},
}

// jsonLeafPaths lists the JSON leaf paths of t. A map contributes "*" for its
// key, so windows."1m".x and windows."15m".x are one path.
func jsonLeafPaths(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.Struct:
		var out []string
		for f := range t.Fields() {
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "" || name == "-" {
				continue
			}
			p := name
			if prefix != "" {
				p = prefix + "." + name
			}
			out = append(out, jsonLeafPaths(f.Type, p)...)
		}
		return out
	case reflect.Map:
		return jsonLeafPaths(t.Elem(), prefix+".*")
	default:
		return []string{prefix}
	}
}

// TestPrometheusMetrics_EveryJSONFieldClassified is the parity guard: it walks
// ServerMetrics, nested summaries and maps included, and fails on a JSON leaf
// that has no Prometheus series and no stated reason to lack one, on a stale
// mapping or exclusion, and on a mapped series that a fully wired scrape does
// not actually carry.
func TestPrometheusMetrics_EveryJSONFieldClassified(t *testing.T) {
	paths := jsonLeafPaths(reflect.TypeFor[api.ServerMetrics](), "")
	if len(paths) < 100 {
		t.Fatalf("walked only %d JSON leaves; the walk is not reaching the nested structs", len(paths))
	}
	have := map[string]bool{}
	for _, p := range paths {
		have[p] = true
	}

	mapped := promFieldMap()
	exclusions := make([]*regexp.Regexp, len(promExclusions))
	used := make([]bool, len(promExclusions))
	for i, e := range promExclusions {
		exclusions[i] = regexp.MustCompile(e.pattern)
		if e.reason == "" {
			t.Errorf("exclusion %q has no reason", e.pattern)
		}
	}

	_, fams := scrapeProm(t, fullPromSources())
	for _, p := range paths {
		sel, isMapped := mapped[p]
		excluded := false
		for i, re := range exclusions {
			if re.MatchString(p) {
				excluded, used[i] = true, true
			}
		}
		switch {
		case isMapped && excluded:
			t.Errorf("%s is both mapped and excluded", p)
		case !isMapped && !excluded:
			t.Errorf("JSON field %s has no Prometheus mapping and no exclusion; map it in promFieldMap or exclude it with a reason", p)
		case isMapped:
			for _, win := range []string{"1m", "15m"} {
				kv := make([]string, len(sel.kv))
				for i, v := range sel.kv {
					kv[i] = v
					if v == "@" {
						kv[i] = win
					}
				}
				if _, ok := promFind(fams, sel.name, kv...); !ok {
					t.Errorf("%s is mapped to %s%v, which a fully wired scrape does not carry", p, sel.name, kv)
				}
				if !strings.Contains(p, "windows") {
					break
				}
			}
		}
	}
	for p := range mapped {
		if !have[p] {
			t.Errorf("stale mapping: %s is not a ServerMetrics JSON field", p)
		}
	}
	for i, u := range used {
		if !u {
			t.Errorf("stale exclusion %q matches no JSON field", promExclusions[i].pattern)
		}
	}
}

// TestMetricsRoutes_LiveRouterPerimeter builds the production router with the
// metrics address list set to loopback and requests both metrics routes from
// inside and outside it. A route mounted without the address limit would answer
// 200 to the outside caller and fail here.
func TestMetricsRoutes_LiveRouterPerimeter(t *testing.T) {
	handler, _ := fullRouterWithConfig(t, func(cfg *config.Config) {
		cfg.Server.AdminAllowedCIDRs = []string{"127.0.0.0/8"}
		cfg.Server.MetricsAllowedCIDRs = nil // falls back to the list above
	})
	for _, path := range []string{"/api/v1/metrics", "/api/v1/metrics/prometheus"} {
		for _, tc := range []struct {
			addr string
			want int
		}{
			{"203.0.113.5:4000", http.StatusForbidden},
			{"127.0.0.1:4000", http.StatusOK},
		} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.RemoteAddr = tc.addr
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != tc.want {
				t.Errorf("GET %s from %s = %d, want %d", path, tc.addr, rr.Code, tc.want)
			}
		}
	}
}
