package api_test

import (
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/invariants"
	"github.com/go-chi/chi/v5"
)

// TestAbsenceContract_NoCentralOrCrossServerReportDelivery is BPR-070's
// promise ("cross-server or central delivery is impossible"), proved as an
// absence proof in B4-2's style, not asserted. Three boundaries, mirroring
// the sibling absence-contract tests in this package:
//
//  1. no route under /api/v1/reports or /api/v1/moderation names a relay,
//     a central store, an upstream, a forward, federation or a remote;
//  2. no moderation.* config key is a string (a URL key is how a relay
//     would arrive — only ints/bools exist under this section);
//  3. Server/invariants/egress_sites.go's allowlist has no row for any
//     service/moderation*.go, service/report*.go or api/report*.go file,
//     so any dialer added there fails TestEgressAllowIsLive by construction.
var reportAbsentPattern = regexp.MustCompile(`(?i)relay|central|upstream|forward|federat|remote`)

func TestAbsenceContract_NoCentralOrCrossServerReportDelivery(t *testing.T) {
	handler := fullRouter(t)
	routes, ok := handler.(chi.Routes)
	if !ok {
		t.Fatalf("NewRouter returned %T, want a chi.Routes so the mounted tree can be walked", handler)
	}

	var reportRoutes int
	var hits []string
	walk := func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/v1/reports") && !strings.HasPrefix(route, "/api/v1/moderation") {
			return nil
		}
		reportRoutes++
		if reportAbsentPattern.MatchString(route) {
			hits = append(hits, method+" "+route)
		}
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	// Vacuity guard: the walk must have actually seen the report/moderation
	// routes B5-8 mounts (POST /reports, GET /reports/mine, and the five
	// moderation/queue routes), not an empty or wrapped mux.
	if reportRoutes < 7 {
		t.Fatalf("walked only %d report/moderation routes; expected at least 7 (B5-8's full surface)", reportRoutes)
	}
	if len(hits) > 0 {
		t.Fatalf("report/moderation routes matching %q must not exist (no relay, no central store, no federation):\n  %s",
			reportAbsentPattern, strings.Join(hits, "\n  "))
	}

	// No moderation.* config key is a string -- only ints/bools, so there is
	// no URL-shaped key a relay destination could arrive through.
	modType := reflect.TypeFor[config.ModerationConfig]()
	if modType.NumField() == 0 {
		t.Fatal("config.ModerationConfig has no fields; the vacuity guard would pass on nothing")
	}
	for f := range modType.Fields() {
		switch f.Type.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Bool:
		default:
			t.Errorf("config.ModerationConfig.%s has kind %s, want int or bool — a string-shaped key is how a relay destination would arrive",
				f.Name, f.Type.Kind())
		}
	}

	// No egress row for any moderation/report production file.
	forbidden := []string{"service/moderation", "service/report", "api/report"}
	var egressHits []string
	for file := range invariants.EgressAllow {
		for _, prefix := range forbidden {
			if strings.HasPrefix(file, prefix) {
				egressHits = append(egressHits, file)
			}
		}
	}
	if len(egressHits) > 0 {
		t.Fatalf("Server/invariants/egress_sites.go's EgressAllow lists moderation/report files, which must never dial out:\n  %s",
			strings.Join(egressHits, "\n  "))
	}
	if len(invariants.EgressAllow) == 0 {
		t.Fatal("invariants.EgressAllow is empty; the negative check above would pass on nothing")
	}
}
