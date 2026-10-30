package admin_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/sysstats"
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
