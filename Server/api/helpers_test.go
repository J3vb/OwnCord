package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// requireStatus stops the test when the response status differs from want.
func requireStatus(t *testing.T, rr *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rr.Code != want {
		t.Fatalf("status = %d, want %d; body: %s", rr.Code, want, rr.Body.String())
	}
}

// expectStatus records a status mismatch and lets the test keep checking.
func expectStatus(t *testing.T, rr *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rr.Code != want {
		t.Errorf("status = %d, want %d; body: %s", rr.Code, want, rr.Body.String())
	}
}

// decodeJSON unmarshals a JSON body into a T.
func decodeJSON[T any](t *testing.T, body []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return v
}

// newAPIRequest builds a loopback request carrying the bearer token, if any.
func newAPIRequest(method, path, token string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, path, body)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	return req
}

// doAPI serves one request from the loopback address and returns the
// recorded response. A non-empty token goes in as a bearer credential.
func doAPI(t *testing.T, router http.Handler, method, path, token string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	return serveRequest(router, newAPIRequest(method, path, token, body))
}

// doAPIJSON is doAPI with body marshalled as the JSON request payload.
func doAPIJSON(t *testing.T, router http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&payload).Encode(body); err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
	}
	req := newAPIRequest(method, path, token, &payload)
	req.Header.Set("Content-Type", "application/json")
	return serveRequest(router, req)
}

// decodeBody unmarshals the recorded JSON body into a T.
func decodeBody[T any](t *testing.T, rr *httptest.ResponseRecorder) T {
	t.Helper()
	return decodeJSON[T](t, rr.Body.Bytes())
}

// openMemoryDB opens an empty in-memory database closed with the test.
func openMemoryDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

// openMigratedDB opens an in-memory database with the full migration set.
func openMigratedDB(t *testing.T) *db.DB {
	t.Helper()
	database := openMemoryDB(t)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// openSchemaDB opens an in-memory database carrying only the given schema.
func openSchemaDB(t *testing.T, schema []byte) *db.DB {
	t.Helper()
	database := openMemoryDB(t)
	migrFS := fstest.MapFS{"001_schema.sql": {Data: schema}}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// createUserToken creates a user with a placeholder password hash plus a
// long-lived session, and returns the plaintext bearer token
// (tokenPrefix + username).
func createUserToken(t *testing.T, database *db.DB, tokenPrefix, username string, roleID int) string {
	t.Helper()
	if _, err := database.CreateUser(context.Background(), username, "$2a$12$fake", roleID); err != nil {
		t.Fatalf("CreateUser %q: %v", username, err)
	}
	token := tokenPrefix + username
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at)
		 SELECT id, ?, 'test', '127.0.0.1', '2099-01-01T00:00:00Z' FROM users WHERE username = ?`,
		auth.HashToken(token), username)
	if err != nil {
		t.Fatalf("insert session for %q: %v", username, err)
	}
	return token
}

// newAuthEnv returns a database with the auth schema, its rate limiter and a
// router mounting the auth routes over both.
func newAuthEnv(t *testing.T) (*db.DB, *auth.RateLimiter, http.Handler) {
	t.Helper()
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	return database, limiter, buildAuthRouter(database, limiter)
}

// postLogin posts a username/password pair to the login route.
func postLogin(t *testing.T, router http.Handler, username, password string) *httptest.ResponseRecorder {
	t.Helper()
	return postJSON(t, router, "/api/v1/auth/login", map[string]string{"username": username, "password": password})
}

// serveLocal serves req as if it came from the loopback address and returns
// the recorded response.
func serveLocal(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	req.RemoteAddr = "127.0.0.1:9999"
	return serveRequest(h, req)
}

// serveRequest serves req and returns the recorded response.
func serveRequest(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// seedLoginSession creates a user and a login session for it, returning the
// user id, the bearer token and the token's stored hash.
func seedLoginSession(t *testing.T, database *db.DB, username string, roleID int) (uid int64, token, hash string) {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "hash", roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	token, err = auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	hash = auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), uid, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return uid, token, hash
}

// serveBearerGET sends GET / with the bearer token through h.
func serveBearerGET(h http.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return serveRequest(h, req)
}

// mustCreateChannel creates a channel of the given type with no category,
// topic or position, failing the test on error.
func mustCreateChannel(t *testing.T, database *db.DB, name, chanType string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, chanType, "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(%s): %v", name, err)
	}
	return id
}

// mustCreateUser creates a user with the given password hash and role.
func mustCreateUser(t *testing.T, database *db.DB, username, passwordHash string, roleID int) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, passwordHash, roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	return id
}

// mustCreateMessage posts a top-level message and returns its id.
func mustCreateMessage(t *testing.T, database *db.DB, channelID, userID int64, content string) int64 {
	t.Helper()
	id, err := database.CreateMessage(context.Background(), channelID, userID, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage in channel %d: %v", channelID, err)
	}
	return id
}

// seedUserSession creates a user with the standard test password and a login
// session, returning the user id and bearer token.
func seedUserSession(t *testing.T, database *db.DB, username string, roleID int) (int64, string) {
	t.Helper()
	uid := seedUser(t, database, username, "correctPass1", roleID)
	return uid, seedSession(t, database, uid)
}

// startRouter boots the application runtime over database and mounts the
// production router on it; the router is torn down with the test.
func startRouter(t *testing.T, cfg *config.Config, database *db.DB) (http.Handler, api.Runtime) {
	t.Helper()
	in := testRuntimeInputs(cfg)
	in.LinkPreviews = app.OpenLinkPreviews(slog.Default(), cfg, database)
	rt, err := app.StartRuntime(cfg, database, nil, in)
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)
	return handler, rt
}

// doAPIRawJSON serves a request whose JSON-typed body is sent verbatim, for
// payloads that are deliberately malformed.
func doAPIRawJSON(t *testing.T, router http.Handler, method, path, token, raw string) *httptest.ResponseRecorder {
	t.Helper()
	req := newAPIRequest(method, path, token, strings.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	return serveRequest(router, req)
}

// captureDebugLogs routes the default slog logger to w, at debug level, until
// the test ends.
func captureDebugLogs(t *testing.T, w io.Writer) {
	t.Helper()
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
}
