package admin_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/owncord/server/admin"
)

func TestSetupStatus_NeedsSetup(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

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
	user, err := database.GetUserByUsername("myadmin")
	if err != nil || user == nil {
		t.Fatal("user not found in database after setup")
	}
	if user.RoleID != 1 {
		t.Errorf("role_id = %d, want 1 (Owner)", user.RoleID)
	}
}

func TestSetup_BlockedAfterFirstUser(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

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
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil)

	const goroutines = 20
	results := make(chan int, goroutines)

	// Launch goroutines simultaneously.
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
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
	for i := 0; i < goroutines; i++ {
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
	count, err := database.UserCount()
	if err != nil {
		t.Fatalf("UserCount: %v", err)
	}
	if count != 1 {
		t.Errorf("user count = %d, want 1", count)
	}
}
