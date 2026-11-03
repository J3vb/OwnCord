package admin_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

// connectionsHub reports a socket count beside the mock hub's user count.
type connectionsHub struct{ *mockHub }

func (connectionsHub) ClientCount() int { return 5 }

type systemHealth struct {
	CapturedAt time.Time      `json:"captured_at"`
	Snapshot   map[string]any `json:"snapshot"`
	Hub        struct {
		Connections    *int `json:"connections"`
		MaxConnections int  `json:"max_connections"`
	} `json:"hub"`
	Database struct {
		Status string                `json:"status"`
		Stats  *admin.SystemDatabase `json:"stats"`
	} `json:"database"`
	Process struct {
		UptimeSeconds *int64         `json:"uptime_seconds"`
		Build         map[string]any `json:"build"`
	} `json:"process"`
	LiveKit struct {
		Managed bool `json:"managed"`
	} `json:"livekit"`
	Signals []json.RawMessage `json:"signals"`
}

func getSystemHealth(t *testing.T, src admin.SystemSources, hub admin.HubBroadcaster) (systemHealth, string) {
	t.Helper()
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "9.9.9", hub, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{System: src})
	w := doRequest(t, handler, http.MethodGet, "/system/health", createAdminUser(t, database), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var got systemHealth
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v; body %s", err, w.Body.String())
	}
	return got, w.Body.String()
}

// The page gets the bundle's health snapshot plus the database, connection
// and process figures, and nothing that names a person.
func TestAdminAPI_SystemHealth(t *testing.T) {
	stats := admin.SystemDatabase{FileBytes: 4096, WALBytes: 512, SchemaVersion: "089_example.sql", ReadersMax: 8}
	got, body := getSystemHealth(t, admin.SystemSources{
		Database:         func(context.Context) (admin.SystemDatabase, error) { return stats, nil },
		MaxWSConnections: 200,
		Started:          time.Now().Add(-90 * time.Second),
	}, connectionsHub{&mockHub{clientCount: 3}})

	if got.Snapshot["scope"] == nil || got.Snapshot["connected_users"] != float64(3) {
		t.Errorf("snapshot = %v, want the bundle's health.json with 3 connected users", got.Snapshot)
	}
	if got.Hub.Connections == nil || *got.Hub.Connections != 5 || got.Hub.MaxConnections != 200 {
		t.Errorf("hub = %+v, want 5 of 200 connections", got.Hub)
	}
	if got.Database.Status != "ok" || got.Database.Stats == nil || *got.Database.Stats != stats {
		t.Errorf("database = %+v, want ok with the source's figures", got.Database)
	}
	if got.Process.UptimeSeconds == nil || *got.Process.UptimeSeconds < 90 {
		t.Errorf("uptime = %v, want at least 90 s", got.Process.UptimeSeconds)
	}
	if got.Process.Build["version"] != "9.9.9" || got.Process.Build["go"] == nil {
		t.Errorf("build = %v, want version 9.9.9 and the Go version", got.Process.Build)
	}
	if got.Signals == nil {
		t.Error("signals = null, want a list")
	}
	if strings.Contains(body, "adminuser") {
		t.Error("the answer names a user; the page is aggregate figures only")
	}
}

// A database that does not answer within the deadline shows its card as
// timed out while the rest of the page still fills in.
func TestAdminAPI_SystemHealth_DatabaseTimeout(t *testing.T) {
	start := time.Now()
	got, _ := getSystemHealth(t, admin.SystemSources{
		Database: func(ctx context.Context) (admin.SystemDatabase, error) {
			<-ctx.Done()
			return admin.SystemDatabase{}, ctx.Err()
		},
	}, &mockHub{clientCount: 2})
	if got.Database.Status != "timeout" || got.Database.Stats != nil {
		t.Errorf("database = %+v, want timeout with no figures", got.Database)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("request took %v; the database read must be bounded", elapsed)
	}
	if got.Snapshot["connected_users"] != float64(2) {
		t.Errorf("snapshot = %v, want the hub figures despite the database", got.Snapshot)
	}
}

func TestAdminAPI_SystemHealth_DatabaseStates(t *testing.T) {
	got, _ := getSystemHealth(t, admin.SystemSources{
		Database: func(context.Context) (admin.SystemDatabase, error) {
			return admin.SystemDatabase{}, errors.New("disk I/O error")
		},
	}, &mockHub{})
	if got.Database.Status != "unreadable" || got.Database.Stats != nil {
		t.Errorf("failed read: database = %+v, want unreadable", got.Database)
	}
	got, body := getSystemHealth(t, admin.SystemSources{}, &mockHub{})
	if got.Database.Status != "not_measured" {
		t.Errorf("no source: database = %+v, want not_measured", got.Database)
	}
	if strings.Contains(body, "disk I/O") {
		t.Error("an error text reached the answer")
	}
	if got.Hub.Connections != nil || got.Process.UptimeSeconds != nil {
		t.Errorf("unreported figures = %+v / %+v, want null", got.Hub, got.Process)
	}
}

// View Diagnostics only, like the support bundle that carries the same
// snapshot.
func TestAdminAPI_SystemHealth_Gate(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{})
	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "moduser")
	if w := doRequest(t, handler, http.MethodGet, "/system/health", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator status = %d, want 403", w.Code)
	}
}
