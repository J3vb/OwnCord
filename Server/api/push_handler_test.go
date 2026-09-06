package api_test

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

// pushTestKey generates a fresh P-256 key so these tests don't depend on the
// auth package's file-backed VAPID loader.
func pushTestKey(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating test VAPID key: %v", err)
	}
	return priv
}

// buildPushRouter mounts only the push routes over database, mirroring
// buildGIFRouter's shape (gif_handler_test.go): a bare chi.Router, a real
// session service and a PushService with a fresh VAPID key installed.
func buildPushRouter(t *testing.T, database *db.DB, enabled bool) (http.Handler, *service.PushService) {
	t.Helper()
	push := service.NewPushService(database)
	push.SetVAPIDKey(pushTestKey(t))
	r := chi.NewRouter()
	api.MountPushRoutes(r, service.NewSessionService(database), push, enabled)
	return r, push
}

// validP256dh / validAuth are well-formed Web Push credential bytes.
func validP256dh() string {
	b := make([]byte, 65)
	b[0] = 0x04
	return base64.RawURLEncoding.EncodeToString(b)
}

func validAuth() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 16))
}

type pushKeys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

type pushSubscribeBody struct {
	Endpoint   string   `json:"endpoint"`
	Keys       pushKeys `json:"keys"`
	DeviceName string   `json:"device_name,omitempty"`
}

func validSubscribeBody(endpoint string) pushSubscribeBody {
	return pushSubscribeBody{
		Endpoint:   endpoint,
		Keys:       pushKeys{P256dh: validP256dh(), Auth: validAuth()},
		DeviceName: "test device",
	}
}

func pushDo(t *testing.T, router http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

func TestPushSubscriptions_LifecycleCreateListRevoke(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, _ := buildPushRouter(t, database, true)
	userID := mintUser(t, database, "push-lifecycle")
	token, _ := mintSession(t, database, userID)

	rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, validSubscribeBody("https://push.example.com/sub/abc"))
	if rr.Code != http.StatusCreated {
		t.Fatalf("subscribe status = %d, body %s", rr.Code, rr.Body.String())
	}

	rr = pushDo(t, router, http.MethodGet, "/api/v1/push/subscriptions", token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(body, "endpoint_host") {
		t.Errorf("list response missing endpoint_host: %s", body)
	}
	if strings.Contains(body, "https://push.example.com/sub/abc") {
		t.Errorf("list response leaked the raw endpoint: %s", body)
	}
	if strings.Contains(body, "p256dh") || strings.Contains(body, "\"auth\"") {
		t.Errorf("list response leaked a credential field: %s", body)
	}
	var listed struct {
		Subscriptions []struct {
			ID int64 `json:"id"`
		} `json:"subscriptions"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil || len(listed.Subscriptions) != 1 {
		t.Fatalf("list decode = %+v, %v; want exactly one row", listed, err)
	}
	id := listed.Subscriptions[0].ID

	rr = pushDo(t, router, http.MethodDelete, "/api/v1/push/subscriptions/"+itoa(id), token, nil)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body %s", rr.Code, rr.Body.String())
	}

	rr = pushDo(t, router, http.MethodGet, "/api/v1/push/subscriptions", token, nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil || len(listed.Subscriptions) != 0 {
		t.Fatalf("list after delete = %+v, %v; want none", listed, err)
	}
}

func TestPushSubscriptions_VisibleOnlyToOwner(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, _ := buildPushRouter(t, database, true)

	userA := mintUser(t, database, "push-owner-a")
	tokenA, _ := mintSession(t, database, userA)
	userB := mintUser(t, database, "push-owner-b")
	tokenB, _ := mintSession(t, database, userB)

	rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", tokenA, validSubscribeBody("https://push.example.com/sub/owner-a"))
	if rr.Code != http.StatusCreated {
		t.Fatalf("subscribe status = %d, body %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode subscribe response: %v", err)
	}

	rr = pushDo(t, router, http.MethodGet, "/api/v1/push/subscriptions", tokenB, nil)
	var listed struct {
		Subscriptions []struct {
			ID int64 `json:"id"`
		} `json:"subscriptions"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil || len(listed.Subscriptions) != 0 {
		t.Fatalf("B's list = %+v, %v; want none", listed, err)
	}

	rr = pushDo(t, router, http.MethodDelete, "/api/v1/push/subscriptions/"+itoa(created.ID), tokenB, nil)
	if rr.Code != http.StatusNotFound || decodeErr(t, rr).Error != "NOT_FOUND" {
		t.Fatalf("B deleting A's subscription = %d %s, want 404 NOT_FOUND", rr.Code, rr.Body.String())
	}

	var ownerID int64
	if err := database.QueryRowContext(context.Background(), `SELECT user_id FROM push_subscriptions WHERE id = ?`, created.ID).Scan(&ownerID); err != nil {
		t.Fatalf("querying survivor row: %v", err)
	}
	if ownerID != userA {
		t.Errorf("row's user_id = %d, want %d (A's) — it must survive B's attempt", ownerID, userA)
	}
}

func TestPushSubscriptions_DisabledIs503AfterAuthAndWritesNothing(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, _ := buildPushRouter(t, database, false)
	userID := mintUser(t, database, "push-disabled")
	token, _ := mintSession(t, database, userID)

	rr := pushDo(t, router, http.MethodGet, "/api/v1/push/subscriptions", "", nil)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous request = %d, want 401 (auth must run before the disabled check)", rr.Code)
	}

	rr = pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, validSubscribeBody("https://push.example.com/sub/disabled"))
	if rr.Code != http.StatusServiceUnavailable || decodeErr(t, rr).Error != "PUSH_DISABLED" {
		t.Fatalf("authed POST while disabled = %d %s, want 503 PUSH_DISABLED", rr.Code, rr.Body.String())
	}

	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM push_subscriptions`).Scan(&n); err != nil {
		t.Fatalf("counting rows: %v", err)
	}
	if n != 0 {
		t.Fatalf("push_subscriptions rows = %d, want 0 — a disabled server must write nothing", n)
	}
}

// ─── Validation ──────────────────────────────────────────────────────────────

func TestPushSubscriptions_RejectsMalformed(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, _ := buildPushRouter(t, database, true)
	userID := mintUser(t, database, "push-malformed")
	token, _ := mintSession(t, database, userID)

	badP256dh64 := base64.RawURLEncoding.EncodeToString(make([]byte, 64))
	badP256dhWrongPrefix := func() string {
		b := make([]byte, 65)
		b[0] = 0x05
		return base64.RawURLEncoding.EncodeToString(b)
	}()
	badAuth15 := base64.RawURLEncoding.EncodeToString(make([]byte, 15))

	tests := []struct {
		name string
		body pushSubscribeBody
	}{
		{"http scheme", pushSubscribeBody{Endpoint: "http://push.example.com/sub/x", Keys: pushKeys{P256dh: validP256dh(), Auth: validAuth()}}},
		{"no host", pushSubscribeBody{Endpoint: "https:///sub/x", Keys: pushKeys{P256dh: validP256dh(), Auth: validAuth()}}},
		{"port-only host", pushSubscribeBody{Endpoint: "https://:443/x", Keys: pushKeys{P256dh: validP256dh(), Auth: validAuth()}}},
		{"embedded credentials", pushSubscribeBody{Endpoint: "https://user:pw@push.example/x", Keys: pushKeys{P256dh: validP256dh(), Auth: validAuth()}}},
		{"endpoint too long", pushSubscribeBody{Endpoint: "https://push.example.com/" + strings.Repeat("x", 2048), Keys: pushKeys{P256dh: validP256dh(), Auth: validAuth()}}},
		{"p256dh 64 bytes", pushSubscribeBody{Endpoint: "https://push.example.com/sub/x", Keys: pushKeys{P256dh: badP256dh64, Auth: validAuth()}}},
		{"p256dh wrong prefix", pushSubscribeBody{Endpoint: "https://push.example.com/sub/x", Keys: pushKeys{P256dh: badP256dhWrongPrefix, Auth: validAuth()}}},
		{"auth 15 bytes", pushSubscribeBody{Endpoint: "https://push.example.com/sub/x", Keys: pushKeys{P256dh: validP256dh(), Auth: badAuth15}}},
		{"device_name control char", pushSubscribeBody{Endpoint: "https://push.example.com/sub/x", Keys: pushKeys{P256dh: validP256dh(), Auth: validAuth()}, DeviceName: "bad\x00name"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, tc.body)
			if rr.Code != http.StatusBadRequest || decodeErr(t, rr).Error != "INVALID_INPUT" {
				t.Fatalf("%s: status = %d %s, want 400 INVALID_INPUT", tc.name, rr.Code, rr.Body.String())
			}
		})
	}

	t.Run("body over 8 KiB", func(t *testing.T) {
		// Every subscription field stays valid; an ignored JSON field pushes
		// the body past the limit, so this proves MaxBodySize itself refuses
		// it rather than a field-length check that would fire regardless.
		oversized := struct {
			pushSubscribeBody
			Padding string `json:"padding"`
		}{
			pushSubscribeBody: validSubscribeBody("https://push.example.com/sub/x"),
			Padding:           strings.Repeat("x", 9<<10),
		}
		rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, oversized)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("oversized body: status = %d %s, want 400", rr.Code, rr.Body.String())
		}
	})
}

// ─── Refresh and cap ─────────────────────────────────────────────────────────

func TestPushSubscriptions_RefreshIsAnUpsert(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, _ := buildPushRouter(t, database, true)
	userID := mintUser(t, database, "push-refresh")
	token, _ := mintSession(t, database, userID)
	ctx := context.Background()

	body := validSubscribeBody("https://push.example.com/sub/refresh")
	rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("first subscribe = %d %s", rr.Code, rr.Body.String())
	}
	var first struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE push_subscriptions SET last_seen_at = datetime('now', '-1 day') WHERE id = ?`, first.ID); err != nil {
		t.Fatalf("backdating: %v", err)
	}
	var before string
	if err := database.QueryRowContext(ctx, `SELECT last_seen_at FROM push_subscriptions WHERE id = ?`, first.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}

	rr = pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("second subscribe = %d %s", rr.Code, rr.Body.String())
	}
	var second struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("second subscribe id = %d, want the same row %d", second.ID, first.ID)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE endpoint = ?`, body.Endpoint).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows for the endpoint = %d, want 1", n)
	}
	var afterRaw string
	if err := database.QueryRowContext(ctx, `SELECT last_seen_at FROM push_subscriptions WHERE id = ?`, first.ID).Scan(&afterRaw); err != nil {
		t.Fatal(err)
	}
	beforeTime, err := time.Parse("2006-01-02 15:04:05", before)
	if err != nil {
		t.Fatalf("parsing before %q: %v", before, err)
	}
	afterTime, err := time.Parse("2006-01-02 15:04:05", afterRaw)
	if err != nil {
		t.Fatalf("parsing after %q: %v", afterRaw, err)
	}
	if !afterTime.After(beforeTime) {
		t.Errorf("last_seen_at after refresh = %q, before (backdated) = %q; want it strictly later", afterRaw, before)
	}
}

func TestPushSubscriptions_DeviceCapEvictsOldest(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, _ := buildPushRouter(t, database, true)
	userID := mintUser(t, database, "push-cap")
	token, _ := mintSession(t, database, userID)
	ctx := context.Background()

	endpoint := func(n int) string { return "https://push.example.com/sub/cap-" + itoa(int64(n)) }

	for i := range 10 {
		rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, validSubscribeBody(endpoint(i)))
		if rr.Code != http.StatusCreated {
			t.Fatalf("subscribe #%d = %d %s", i, rr.Code, rr.Body.String())
		}
		// Stagger last_seen_at so the oldest is unambiguous regardless of
		// same-second insert timing: endpoint 0 is oldest, endpoint 9 newest.
		if _, err := database.ExecContext(ctx,
			`UPDATE push_subscriptions SET last_seen_at = datetime('now', ?) WHERE user_id = ? AND endpoint = ?`,
			"-"+itoa(int64(10-i))+" minutes", userID, endpoint(i),
		); err != nil {
			t.Fatalf("staggering #%d: %v", i, err)
		}
	}

	// The 11th subscription triggers the cap; it is the newest of all.
	rr := pushDo(t, router, http.MethodPost, "/api/v1/push/subscriptions", token, validSubscribeBody(endpoint(10)))
	if rr.Code != http.StatusCreated {
		t.Fatalf("11th subscribe = %d %s", rr.Code, rr.Body.String())
	}

	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 10 {
		t.Fatalf("rows after the 11th subscribe = %d, want 10", n)
	}
	var oldestSurvives int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE endpoint = ?`, endpoint(0)).Scan(&oldestSurvives); err != nil {
		t.Fatal(err)
	}
	if oldestSurvives != 0 {
		t.Errorf("the oldest subscription (endpoint 0) survived the cap")
	}
}

// ─── VAPID ───────────────────────────────────────────────────────────────────

func TestPushVAPID_ReturnsTheRunningKey(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	router, push := buildPushRouter(t, database, true)
	userID := mintUser(t, database, "push-vapid")
	token, _ := mintSession(t, database, userID)

	rr := pushDo(t, router, http.MethodGet, "/api/v1/push/vapid", token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /vapid = %d %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		PublicKey string `json:"public_key"`
		KeyID     string `json:"key_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(resp.PublicKey)
	if err != nil {
		t.Fatalf("public_key is not raw-url-base64: %v", err)
	}
	if len(raw) != 65 || raw[0] != 0x04 {
		t.Fatalf("decoded public_key = %d bytes starting 0x%02x, want 65 bytes starting 0x04", len(raw), raw[0])
	}
	_, wantKeyID, ok := push.PublicKey()
	if !ok || resp.KeyID != wantKeyID {
		t.Fatalf("key_id = %q, want the service's %q (ok=%v)", resp.KeyID, wantKeyID, ok)
	}
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}
