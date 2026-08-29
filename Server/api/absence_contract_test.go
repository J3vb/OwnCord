package api_test

import (
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/go-chi/chi/v5"
)

// fullRouter builds the production router with every optional route family
// switched on (uploads, voice, GIF proxy) so the walk below sees the whole
// tree, not the bare-config subset setupRouter mounts.
func fullRouter(t *testing.T) http.Handler {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open error: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate error: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	dir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Name: "Test Server", Port: 8443, DataDir: dir},
		Upload: config.UploadConfig{MaxSizeMB: 1, StorageDir: filepath.Join(dir, "uploads")},
		Voice: config.VoiceConfig{
			LiveKitAPIKey:    "absence-test-key",
			LiveKitAPISecret: "absence-test-secret-at-least-32-chars-long",
			LiveKitURL:       "ws://127.0.0.1:7880",
		},
		GIF: config.GIFConfig{APIKey: "absence-test"},
	}

	handler, _, cleanup := api.NewRouter(cfg, database, "test", nil, nil)
	t.Cleanup(cleanup)
	return handler
}

// absentRoutePattern names the route families OwnCord promises not to have:
// no federation between servers, no server directory or discovery, no
// public listing. docs/trust-model.md states the promise; this test is the
// proof. A route matching it is a design change that needs that document
// updated first, not a silent addition.
var absentRoutePattern = regexp.MustCompile(`(?i)federat|directory|discover|listing`)

// TestAbsenceContract_NoFederationDirectoryOrListingRoutes walks every route
// the production router mounts (admin and plugin subrouters included) and
// fails on the first one whose path names federation, a directory, discovery
// or a listing. BPR-040/082/083.
func TestAbsenceContract_NoFederationDirectoryOrListingRoutes(t *testing.T) {
	handler := fullRouter(t)
	routes, ok := handler.(chi.Routes)
	if !ok {
		t.Fatalf("NewRouter returned %T, want a chi.Routes so the mounted tree can be walked", handler)
	}

	var total, adminRoutes int
	var hits []string
	walk := func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		total++
		if strings.HasPrefix(route, "/admin/") {
			adminRoutes++
		}
		if absentRoutePattern.MatchString(route) {
			hits = append(hits, method+" "+route)
		}
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}

	// Guard against a vacuous pass: the walk must have seen the real tree,
	// including the mounted admin subrouter, not an empty or wrapped mux.
	if total < 100 {
		t.Fatalf("walked only %d routes; expected the full production router (>= 100)", total)
	}
	if adminRoutes == 0 {
		t.Fatal("walk saw no /admin/ routes; the mounted admin subrouter was not traversed")
	}

	if len(hits) > 0 {
		t.Fatalf("routes matching %q must not exist (see docs/trust-model.md, \"What OwnCord does not have\"):\n  %s",
			absentRoutePattern, strings.Join(hits, "\n  "))
	}
}
