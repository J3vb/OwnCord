package api_test

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

// newVoiceAPITestDB opens an in-memory DB for voice API tests.
func newVoiceAPITestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: apiTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

// buildVoiceRouter returns a chi router with voice routes mounted.
func buildVoiceRouter(database *db.DB, cfg *config.Config) http.Handler {
	r := chi.NewRouter()
	api.MountVoiceRoutes(r, cfg, database)
	return r
}

// seedAPIUser creates a user+session and returns a valid bearer token.
func seedVoiceAPIUser(t *testing.T, database *db.DB, username string) string {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	token := "test-token-" + username
	hash := auth.HashToken(token)
	future := time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	_, err = database.Exec(
		`INSERT INTO sessions (user_id, token, device, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)`,
		user.ID, hash, "test", "127.0.0.1", future,
	)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}
	return token
}

// voiceGetWithToken performs a GET with Authorization: Bearer header.
func voiceGetWithToken(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

// defaultVoiceCfg returns a Config with a known TURN secret for testing.
func defaultVoiceCfg() *config.Config {
	return &config.Config{
		Server: config.ServerConfig{Name: "Test"},
		Voice: config.VoiceConfig{
			TURNSecret:  "test-secret-key-12345",
			STUNPort:    3478,
			TURNPort:    3478,
			TURNEnabled: true,
		},
	}
}

// ─── GET /api/v1/voice/credentials ───────────────────────────────────────────

func TestVoiceCredentials_Authenticated_Returns200(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "alice")
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

func TestVoiceCredentials_Unauthenticated_Returns401(t *testing.T) {
	database := newVoiceAPITestDB(t)
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/voice/credentials", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestVoiceCredentials_ResponseContainsIceServers(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "bob")
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	iceServers, ok := resp["ice_servers"]
	if !ok {
		t.Fatal("response missing ice_servers field")
	}
	servers, ok := iceServers.([]any)
	if !ok || len(servers) == 0 {
		t.Error("ice_servers is empty or wrong type")
	}
}

func TestVoiceCredentials_ContainsSTUNEntry(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "carol")
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	servers := resp["ice_servers"].([]any)
	foundSTUN := false
	for _, s := range servers {
		entry := s.(map[string]any)
		if urls, ok := entry["urls"].(string); ok {
			if len(urls) > 5 && urls[:5] == "stun:" {
				foundSTUN = true
				break
			}
		}
	}
	if !foundSTUN {
		t.Error("ice_servers does not contain a STUN entry")
	}
}

func TestVoiceCredentials_ContainsTURNEntry(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "dave")
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	servers := resp["ice_servers"].([]any)
	foundTURN := false
	for _, s := range servers {
		entry := s.(map[string]any)
		if urls, ok := entry["urls"].(string); ok {
			if len(urls) > 5 && urls[:5] == "turn:" {
				foundTURN = true
				// TURN entries must have username and credential.
				if _, hasUser := entry["username"]; !hasUser {
					t.Error("TURN entry missing username")
				}
				if _, hasCred := entry["credential"]; !hasCred {
					t.Error("TURN entry missing credential")
				}
				break
			}
		}
	}
	if !foundTURN {
		t.Error("ice_servers does not contain a TURN entry")
	}
}

func TestVoiceCredentials_TURNCredentialIsValidHMAC(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "eve")
	secret := "test-secret-key-12345"
	cfg := &config.Config{
		Voice: config.VoiceConfig{
			TURNSecret:  secret,
			STUNPort:    3478,
			TURNPort:    3478,
			TURNEnabled: true,
		},
	}

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	servers := resp["ice_servers"].([]any)
	for _, s := range servers {
		entry := s.(map[string]any)
		urls, _ := entry["urls"].(string)
		if len(urls) < 5 || urls[:5] != "turn:" {
			continue
		}
		username, _ := entry["username"].(string)
		credential, _ := entry["credential"].(string)

		if username == "" || credential == "" {
			t.Fatal("TURN entry has empty username or credential")
		}

		// Verify HMAC-SHA1: credential should be base64(HMAC-SHA1(secret, username)).
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username))
		expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		if credential != expected {
			t.Errorf("TURN credential HMAC mismatch\n  got:  %s\n  want: %s", credential, expected)
		}
		return
	}
	t.Error("no TURN entry found to validate HMAC")
}

func TestVoiceCredentials_UsernameContainsTimestampAndUserID(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "frank")
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	servers := resp["ice_servers"].([]any)
	for _, s := range servers {
		entry := s.(map[string]any)
		urls, _ := entry["urls"].(string)
		if len(urls) < 5 || urls[:5] != "turn:" {
			continue
		}
		username, _ := entry["username"].(string)

		// Username format: "<unix_timestamp>:<userID>".
		var ts, uid int64
		if _, err := fmt.Sscanf(username, "%d:%d", &ts, &uid); err != nil {
			t.Errorf("TURN username %q is not in format <timestamp>:<userID>: %v", username, err)
		}
		if ts <= time.Now().Unix() {
			t.Errorf("TURN username timestamp %d is in the past, want future", ts)
		}
		if uid <= 0 {
			t.Errorf("TURN username userID %d must be positive", uid)
		}
		return
	}
	t.Error("no TURN entry found to validate username format")
}

func TestVoiceCredentials_ResponseContainsExpiresIn(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "grace")
	cfg := defaultVoiceCfg()

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	expiresIn, ok := resp["expires_in"]
	if !ok {
		t.Fatal("response missing expires_in field")
	}
	// expires_in should be 86400 (24 hours in seconds).
	val, ok := expiresIn.(float64)
	if !ok || val != 86400 {
		t.Errorf("expires_in = %v, want 86400", expiresIn)
	}
}

func TestVoiceCredentials_TURNDisabled_NoTURNEntry(t *testing.T) {
	database := newVoiceAPITestDB(t)
	token := seedVoiceAPIUser(t, database, "henry")
	cfg := &config.Config{
		Voice: config.VoiceConfig{
			TURNSecret:  "secret",
			STUNPort:    3478,
			TURNPort:    3478,
			TURNEnabled: false, // TURN disabled
		},
	}

	router := buildVoiceRouter(database, cfg)
	rr := voiceGetWithToken(t, router, "/api/v1/voice/credentials", token)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}

	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)

	servers := resp["ice_servers"].([]any)
	for _, s := range servers {
		entry := s.(map[string]any)
		if urls, _ := entry["urls"].(string); len(urls) >= 5 && urls[:5] == "turn:" {
			t.Error("TURN entry present when TURNEnabled=false")
		}
	}
}
