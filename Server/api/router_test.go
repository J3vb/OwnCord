package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/owncord/server/api"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// setupRouter creates a test router with an in-memory database.
func setupRouter(t *testing.T) http.Handler {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open error: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate error: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{
		Server: config.ServerConfig{
			Name: "Test Server",
			Port: 8443,
		},
	}

	return api.NewRouter(cfg, database, "test")
}

func TestHealthEndpointReturns200(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("GET /health status = %d, want 200", rec.Code)
	}
}

func TestHealthEndpointReturnsJSON(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	contentType := rec.Header().Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", contentType)
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("response body is not valid JSON: %v", err)
	}
}

func TestHealthEndpointStatusOK(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	if body["status"] != "ok" {
		t.Errorf("status = %v, want 'ok'", body["status"])
	}
}

func TestHealthEndpointHasVersion(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	if body["version"] == nil || body["version"] == "" {
		t.Error("health response missing 'version' field")
	}
}

func TestAPIV1InfoEndpoint(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("GET /api/v1/info status = %d, want 200", rec.Code)
	}
}

func TestAPIV1InfoReturnsServerName(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	if body["name"] != "Test Server" {
		t.Errorf("name = %v, want 'Test Server'", body["name"])
	}
}

func TestAPIV1InfoReturnsVersion(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("JSON decode error: %v", err)
	}

	if body["version"] == nil {
		t.Error("info response missing 'version' field")
	}
}

func TestUnknownRouteReturns404(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nonexistent", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /api/v1/nonexistent status = %d, want 404", rec.Code)
	}
}

func TestRequestIDMiddleware(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	// Request ID header should be set by middleware.
	requestID := rec.Header().Get("X-Request-Id")
	if requestID == "" {
		t.Error("X-Request-Id header not set by middleware")
	}
}

func TestHealthMethodNotAllowed(t *testing.T) {
	router := setupRouter(t)

	req := httptest.NewRequest(http.MethodPost, "/health", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /health status = %d, want 405", rec.Code)
	}
}
