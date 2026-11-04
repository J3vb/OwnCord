package admin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/lkstats"
	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/sysstats"
	"github.com/J3vb/OwnCord/Server/ws"
)

type systemStats struct {
	IntervalSeconds int     `json:"interval_seconds"`
	WindowSeconds   int     `json:"window_seconds"`
	UptimeSeconds   *int64  `json:"uptime_seconds"`
	OnlineUsers     int     `json:"online_users"`
	CPUCores        int     `json:"cpu_cores"`
	MemoryTotal     *uint64 `json:"memory_total"`
	Current         *struct {
		ProcessCPU    *float64 `json:"process_cpu"`
		ProcessMemory *uint64  `json:"process_memory"`
	} `json:"current"`
	Series []json.RawMessage `json:"series"`
	Disk   struct {
		Free    *uint64 `json:"free"`
		Total   *uint64 `json:"total"`
		MinFree uint64  `json:"min_free"`
		Low     *bool   `json:"low"`
		Uploads *int64  `json:"uploads"`
	} `json:"disk"`
}

func decodeSystemStats(t *testing.T, body []byte) systemStats {
	t.Helper()
	var s systemStats
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatalf("decode: %v; body %s", err, body)
	}
	return s
}

// GET /system/stats serves the sampler's newest reading and history, the
// data volume and uptime, to View Diagnostics holders only.
func TestAdminAPI_SystemStats(t *testing.T) {
	database := openAdminTestDB(t)
	sampler := sysstats.NewSampler()
	ctx, cancel := context.WithCancel(t.Context())
	done := sampler.Run(ctx)
	t.Cleanup(func() { cancel(); <-done })

	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{clientCount: 3}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{
		System: admin.SystemSources{
			Sampler:     sampler,
			DiskSpace:   func() (uint64, uint64, error) { return 5 << 30, 100 << 30, nil },
			DiskMinFree: 10 << 30,
			UploadBytes: func(context.Context) (int64, error) { return 42 << 20, nil },
			Started:     time.Now().Add(-90 * time.Minute),
		},
	})
	ownerToken := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/system/stats", ownerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	s := decodeSystemStats(t, w.Body.Bytes())
	if s.IntervalSeconds != 5 || s.WindowSeconds != 3600 || s.OnlineUsers != 3 || s.CPUCores < 1 {
		t.Errorf("header = %+v", s)
	}
	if s.UptimeSeconds == nil || *s.UptimeSeconds < 90*60 {
		t.Errorf("uptime = %v, want at least 90 minutes", s.UptimeSeconds)
	}
	if s.Current == nil || s.Current.ProcessMemory == nil || len(s.Series) != 1 {
		t.Fatalf("current = %+v, series %d; want the first sample", s.Current, len(s.Series))
	}
	// One sample cannot give a CPU figure: it is null, never 0.
	if s.Current.ProcessCPU != nil {
		t.Errorf("first sample CPU = %v, want null", *s.Current.ProcessCPU)
	}
	d := s.Disk
	if d.Free == nil || *d.Free != 5<<30 || d.Total == nil || *d.Total != 100<<30 || d.MinFree != 10<<30 {
		t.Errorf("disk = %+v", d)
	}
	if d.Low == nil || !*d.Low {
		t.Errorf("disk low = %v, want true (5 GB free under a 10 GB floor)", d.Low)
	}
	if d.Uploads == nil || *d.Uploads != 42<<20 {
		t.Errorf("uploads = %v, want 42 MiB", d.Uploads)
	}

	if w := doRequest(t, handler, http.MethodGet, "/system/stats?window=24h", ownerToken, nil); w.Code != http.StatusOK {
		t.Errorf("window=24h status = %d, want 200", w.Code)
	} else if got := decodeSystemStats(t, w.Body.Bytes()).WindowSeconds; got != 86400 {
		t.Errorf("window=24h window_seconds = %d", got)
	}
	if w := doRequest(t, handler, http.MethodGet, "/system/stats?window=7d", ownerToken, nil); w.Code != http.StatusBadRequest {
		t.Errorf("window=7d status = %d, want 400", w.Code)
	}

	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	if w := doRequest(t, handler, http.MethodGet, "/system/stats", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator status = %d, want 403", w.Code)
	}
}

// Without a sampler or disk source every figure is null, never a reassuring
// zero, and a failed disk read stays null too.
func TestAdminAPI_SystemStats_NothingWired(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{
		System: admin.SystemSources{
			DiskSpace:   func() (uint64, uint64, error) { return 0, 0, errors.New("no disk") },
			UploadBytes: func(context.Context) (int64, error) { return 0, errors.New("no db") },
		},
	})
	ownerToken := createAdminUser(t, database)
	w := doRequest(t, handler, http.MethodGet, "/system/stats", ownerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	s := decodeSystemStats(t, w.Body.Bytes())
	if s.Current != nil || len(s.Series) != 0 || s.MemoryTotal != nil || s.UptimeSeconds != nil {
		t.Errorf("stats = %+v, want no CPU, memory or uptime", s)
	}
	if s.Disk.Free != nil || s.Disk.Total != nil || s.Disk.Low != nil || s.Disk.Uploads != nil {
		t.Errorf("disk = %+v, want every figure null", s.Disk)
	}
	if s.Series == nil {
		t.Error("series is null, want an empty array")
	}
}

// GET /system/slow-requests lists route patterns slowest first, at most ten,
// to View Diagnostics holders only; with no tracker the list is empty.
func TestAdminAPI_SlowRequests(t *testing.T) {
	database := openAdminTestDB(t)
	slow := metrics.NewSlowRoutes(time.Now)
	for i := range 12 {
		slow.Observe(http.MethodGet, fmt.Sprintf("/api/v1/r%02d", i), time.Duration(i+1)*time.Millisecond)
	}
	slow.Observe(http.MethodPost, "/api/v1/channels/{id}/messages", 1500*time.Millisecond)

	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{
		System: admin.SystemSources{SlowRoutes: slow},
	})
	ownerToken := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/system/slow-requests", ownerToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var got struct {
		WindowSeconds int `json:"window_seconds"`
		Routes        []struct {
			Method string  `json:"method"`
			Route  string  `json:"route"`
			Count  uint64  `json:"count"`
			P50    float64 `json:"p50_ms"`
			P95    float64 `json:"p95_ms"`
			Max    float64 `json:"max_ms"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.WindowSeconds != 3600 || len(got.Routes) != 10 {
		t.Fatalf("window %d, %d routes; want 3600 and 10", got.WindowSeconds, len(got.Routes))
	}
	top := got.Routes[0]
	if top.Method != http.MethodPost || top.Route != "/api/v1/channels/{id}/messages" || top.Count != 1 || top.Max != 1500 {
		t.Errorf("top = %+v, want the 1.5 s message post", top)
	}

	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	if w := doRequest(t, handler, http.MethodGet, "/system/slow-requests", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator status = %d, want 403", w.Code)
	}

	bare := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{})
	w = doRequest(t, bare, http.MethodGet, "/system/slow-requests", ownerToken, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"routes":[]`) {
		t.Errorf("no tracker: status %d body %s, want 200 with an empty list", w.Code, w.Body.String())
	}
}

type managedHub struct {
	*mockHub
	managed bool
}

func (h managedHub) LiveKitManaged() bool                          { return h.managed }
func (h managedHub) LiveKitProcessStatus() ws.LiveKitProcessStatus { return ws.LiveKitProcessStatus{} }

type systemLiveKit struct {
	Configured      bool   `json:"configured"`
	Managed         *bool  `json:"managed"`
	Status          string `json:"status"`
	Since           *int64 `json:"since"`
	IntervalSeconds int    `json:"interval_seconds"`
	WindowSeconds   int    `json:"window_seconds"`
	Current         *struct {
		Memory       *uint64 `json:"memory"`
		Rooms        *int    `json:"rooms"`
		Participants *int    `json:"participants"`
	} `json:"current"`
	Series []json.RawMessage `json:"series"`
}

func getSystemLiveKit(t *testing.T, handler http.Handler, token, query string) (int, systemLiveKit) {
	t.Helper()
	w := doRequest(t, handler, http.MethodGet, "/system/livekit"+query, token, nil)
	var s systemLiveKit
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
			t.Fatalf("decode: %v; body %s", err, w.Body.String())
		}
	}
	return w.Code, s
}

// GET /system/livekit answers configured:false (with whether OwnCord runs its
// own LiveKit) when no stats page is set, and the sampler's status and history
// when one is.
func TestAdminAPI_SystemLiveKit(t *testing.T) {
	database := openAdminTestDB(t)
	ownerToken := createAdminUser(t, database)

	t.Run("not configured", func(t *testing.T) {
		for _, managed := range []bool{false, true} {
			handler := admin.NewAdminAPI(database, "1.0.0", managedHub{&mockHub{}, managed}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{})
			code, s := getSystemLiveKit(t, handler, ownerToken, "")
			if code != http.StatusOK || s.Configured || s.Managed == nil || *s.Managed != managed || s.Current != nil {
				t.Errorf("managed=%v: code %d body %+v", managed, code, s)
			}
		}
		handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{})
		if _, s := getSystemLiveKit(t, handler, ownerToken, ""); s.Configured || s.Managed == nil || *s.Managed {
			t.Errorf("a hub without LiveKit is not managed: %+v", s)
		}
	})

	run := func(t *testing.T, url string) http.Handler {
		t.Helper()
		sampler := lkstats.New(url, slog.New(slog.DiscardHandler))
		ctx, cancel := context.WithCancel(t.Context())
		done := sampler.Run(ctx)
		t.Cleanup(func() { cancel(); <-done })
		return admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{
			System: admin.SystemSources{LiveKit: sampler},
		})
	}
	waitStatus := func(t *testing.T, h http.Handler, want string) systemLiveKit {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			_, s := getSystemLiveKit(t, h, ownerToken, "")
			if s.Status == want {
				return s
			}
			if time.Now().After(deadline) {
				t.Fatalf("status = %q, want %q", s.Status, want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	t.Run("ok", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, "process_cpu_seconds_total 5\nprocess_resident_memory_bytes 1000\nlivekit_room_total 2\nlivekit_participant_total 6\n")
		}))
		defer srv.Close()
		h := run(t, srv.URL)
		s := waitStatus(t, h, "ok")
		if !s.Configured || s.Managed != nil || s.IntervalSeconds != 10 || s.WindowSeconds != 3600 || s.Since == nil {
			t.Errorf("header = %+v", s)
		}
		if s.Current == nil || *s.Current.Rooms != 2 || *s.Current.Participants != 6 || *s.Current.Memory != 1000 || len(s.Series) != 1 {
			t.Errorf("current = %+v, series %d", s.Current, len(s.Series))
		}
		if _, s := getSystemLiveKit(t, h, ownerToken, "?window=24h"); s.WindowSeconds != 86400 {
			t.Errorf("window_seconds = %d", s.WindowSeconds)
		}
		if code, _ := getSystemLiveKit(t, h, ownerToken, "?window=7d"); code != http.StatusBadRequest {
			t.Errorf("window=7d status = %d, want 400", code)
		}
		_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "lkmod")
		if code, _ := getSystemLiveKit(t, h, modToken, ""); code != http.StatusForbidden {
			t.Errorf("moderator status = %d, want 403", code)
		}
	})

	t.Run("page without metrics", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "<html>hi</html>") }))
		defer srv.Close()
		s := waitStatus(t, run(t, srv.URL), "not_set_up")
		if s.Current == nil || s.Current.Rooms != nil {
			t.Errorf("not set up has an empty current: %+v", s.Current)
		}
	})

	t.Run("unreachable", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		waitStatus(t, run(t, url), "unreachable")
	})
}
