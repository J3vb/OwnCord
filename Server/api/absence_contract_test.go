package api_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/go-chi/chi/v5"
)

// absentPattern names the feature families OwnCord promises not to have:
// no federation between servers, no server directory or discovery, no
// public listing. docs/trust-model.md states the promise; the tests in this
// file are the proof at the three boundaries a new feature has to cross —
// an HTTP route, a WebSocket message type, a configuration key. They pin
// vocabulary, not semantics: a feature smuggled under a neutral name passes,
// which is why trust-model.md also carries the outbound-host table B6's
// network capture checks. A hit here is a design change that needs that
// document updated first, not a silent addition.
var absentPattern = regexp.MustCompile(`(?i)federat|directory|discover|listing`)

// fullRouter builds the production router with every optional route family
// switched on (uploads, voice, GIF proxy) so the walk below sees the whole
// tree, not the bare-config subset setupRouter mounts.
func fullRouter(t *testing.T) http.Handler {
	t.Helper()
	handler, _ := fullRouterWithDB(t)
	return handler
}

// fullRouterWithDB is fullRouter handing back the database too, for tests
// that need to mint users, sessions and tokens behind the routes they probe
// (auth_posture_test.go, dead_session_test.go).
func fullRouterWithDB(t *testing.T) (http.Handler, *db.DB) {
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

	rt, rtErr := app.StartRuntime(cfg, database, nil)
	if rtErr != nil {
		t.Fatalf("app.StartRuntime: %v", rtErr)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)
	return handler, database
}

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
		if absentPattern.MatchString(route) {
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
			absentPattern, strings.Join(hits, "\n  "))
	}
}

// TestAbsenceContract_NoFederationDirectoryOrListingWireTypes reads the
// protocol schema (the source of truth ws/message_types.go is generated from)
// and fails on any WebSocket message type in either direction whose wire name
// matches the pattern. A federation or directory feature carried entirely by
// new frames would otherwise pass the route test above.
func TestAbsenceContract_NoFederationDirectoryOrListingWireTypes(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol", "schema.json"))
	if err != nil {
		t.Fatalf("read protocol/schema.json: %v", err)
	}
	var schema struct {
		ClientToServer []struct {
			Wire string `json:"wire"`
		} `json:"client_to_server"`
		ServerToClient []struct {
			Wire string `json:"wire"`
		} `json:"server_to_client"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse protocol/schema.json: %v", err)
	}

	var total int
	var hits []string
	for _, dir := range [][]struct {
		Wire string `json:"wire"`
	}{schema.ClientToServer, schema.ServerToClient} {
		for _, m := range dir {
			total++
			if absentPattern.MatchString(m.Wire) {
				hits = append(hits, m.Wire)
			}
		}
	}
	if total < 40 {
		t.Fatalf("read only %d wire types from the schema; expected the full protocol (>= 40)", total)
	}
	if len(hits) > 0 {
		t.Fatalf("WebSocket message types matching %q must not exist (see docs/trust-model.md, \"What OwnCord does not have\"):\n  %s",
			absentPattern, strings.Join(hits, "\n  "))
	}
}

// TestAbsenceContract_NoFederationDirectoryOrListingConfigKeys walks the
// koanf tags of config.Config and fails on any dotted key matching the
// pattern. A feature that needs a peer list, a directory URL or a discovery
// toggle has to surface here, so this is the third boundary.
func TestAbsenceContract_NoFederationDirectoryOrListingConfigKeys(t *testing.T) {
	// On-disk paths that happen to contain a pattern word. Each entry names
	// a filesystem location, never a network one; adding to this list needs
	// the same justification as a route hit.
	allowed := map[string]string{
		"plugins.directory": "the on-disk plugin directory (Server/config/config.go PluginsConfig.Directory)",
	}

	keys := koanfKeys(reflect.TypeFor[config.Config](), "")
	if len(keys) < 30 {
		t.Fatalf("collected only %d config keys; expected the full config surface (>= 30)", len(keys))
	}
	var hits []string
	for _, k := range keys {
		if !absentPattern.MatchString(k) {
			continue
		}
		if _, ok := allowed[k]; ok {
			continue
		}
		hits = append(hits, k)
	}
	if len(hits) > 0 {
		t.Fatalf("config keys matching %q must not exist (see docs/trust-model.md, \"What OwnCord does not have\"):\n  %s",
			absentPattern, strings.Join(hits, "\n  "))
	}
	for k := range allowed {
		if !slices.Contains(keys, k) {
			t.Errorf("allowlisted config key %q no longer exists; drop it from the allowlist", k)
		}
	}
}

// koanfKeys returns every dotted koanf key reachable from t, recursing into
// nested structs the same way koanf unmarshals them.
func koanfKeys(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var keys []string
	for f := range t.Fields() {
		tag, ok := f.Tag.Lookup("koanf")
		if !ok || tag == "" || tag == "-" {
			continue
		}
		key := tag
		if prefix != "" {
			key = prefix + "." + tag
		}
		ft := f.Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			keys = append(keys, koanfKeys(ft, key)...)
			continue
		}
		keys = append(keys, key)
	}
	return keys
}
