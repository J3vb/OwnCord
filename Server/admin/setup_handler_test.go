package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/owncord/server/admin"
)

func TestSetupStatus_NeedsSetup(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	rr := doRequest(t, handler, "GET", "/setup/status", "", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /setup/status = %d, want 200", rr.Code)
	}

	var resp struct {
		NeedsSetup bool `json:"needs_setup"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.NeedsSetup {
		t.Error("needs_setup = false, want true (no users)")
	}
}

func TestSetupStatus_NoSetupNeeded(t *testing.T) {
	database := openAdminTestDB(t)
	createAdminUser(t, database) // Create a user first
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	rr := doRequest(t, handler, "GET", "/setup/status", "", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /setup/status = %d, want 200", rr.Code)
	}

	var resp struct {
		NeedsSetup bool `json:"needs_setup"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.NeedsSetup {
		t.Error("needs_setup = true, want false (user exists)")
	}
}

func TestSetup_CreatesOwner(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "myadmin",
		"password": "SecurePass123!",
	})

	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Token      string `json:"token"`
		UserID     int64  `json:"user_id"`
		Username   string `json:"username"`
		InviteCode string `json:"invite_code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Token == "" {
		t.Error("token is empty")
	}
	if resp.Username != "myadmin" {
		t.Errorf("username = %q, want %q", resp.Username, "myadmin")
	}
	if resp.InviteCode == "" {
		t.Error("invite_code is empty")
	}
	if resp.UserID == 0 {
		t.Error("user_id is 0")
	}

	// Verify user was created with Owner role.
	user, err := database.GetUserByUsername(context.Background(), "myadmin")
	if err != nil || user == nil {
		t.Fatal("user not found in database after setup")
	}
	if user.RoleID != 1 {
		t.Errorf("role_id = %d, want 1 (Owner)", user.RoleID)
	}
}

func TestSetup_BlockedAfterFirstUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	// First setup succeeds.
	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "owner1",
		"password": "SecurePass123!",
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("first setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}

	// Second setup is blocked.
	rr2 := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "hacker",
		"password": "EvilPass456!",
	})
	if rr2.Code != http.StatusForbidden {
		t.Errorf("second setup = %d, want 403", rr2.Code)
	}
}

func TestSetup_WeakPassword(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "admin",
		"password": "short",
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("weak password = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
}

func TestSetup_MissingFields(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "",
		"password": "",
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("missing fields = %d, want 400", rr.Code)
	}
}

// TestSetup_ConcurrentRace fires many parallel setup requests at a fresh
// server and asserts that exactly one owner is created (BUG-119).
func TestSetup_ConcurrentRace(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	const goroutines = 20
	results := make(chan int, goroutines)

	// Launch goroutines simultaneously.
	start := make(chan struct{})
	for i := range goroutines {
		go func(n int) {
			<-start // wait for the gate
			rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
				"username": fmt.Sprintf("owner%d", n),
				"password": "SecurePass123!",
			})
			results <- rr.Code
		}(i)
	}
	close(start) // release all goroutines at once

	created := 0
	for range goroutines {
		code := <-results
		switch code {
		case http.StatusCreated:
			created++
		case http.StatusForbidden, http.StatusTooManyRequests:
			// expected for losers (already set up or rate-limited)
		default:
			t.Errorf("unexpected status %d", code)
		}
	}

	if created != 1 {
		t.Errorf("expected exactly 1 owner created, got %d", created)
	}

	// Verify only one user exists in the database.
	count, err := database.UserCount(context.Background())
	if err != nil {
		t.Fatalf("UserCount: %v", err)
	}
	if count != 1 {
		t.Errorf("user count = %d, want 1", count)
	}
}

// A freshly generated config leaves allowed_origins empty, and browsers send an
// Origin header on same-origin POSTs. Before isSameOrigin existed, that pairing
// made first-run setup fail on every new install with "cross-origin setup
// request blocked". These two tests pin both halves: same-origin gets through
// on an empty allowlist, and a foreign origin still does not.
func TestSetup_SameOriginAllowedWithEmptyAllowlist(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	body, err := json.Marshal(map[string]string{"username": "owner", "password": "correct-horse"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest("POST", "/setup", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// httptest.NewRequest sets Host to example.com; the browser would send the
	// matching Origin for a page served from this same server.
	req.Header.Set("Origin", "https://"+req.Host)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup with same-origin Origin = %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
}

func TestSetup_ForeignOriginStillBlocked(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database))

	body, err := json.Marshal(map[string]string{"username": "owner", "password": "correct-horse"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest("POST", "/setup", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("POST /setup from a foreign origin = %d, want 403", rr.Code)
	}

	count, err := database.UserCount(context.Background())
	if err != nil {
		t.Fatalf("UserCount: %v", err)
	}
	if count != 0 {
		t.Fatalf("owner account created from a foreign origin: user count = %d, want 0", count)
	}
}
