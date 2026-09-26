package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// The erasure touches every table, so these rows run on the real migration
// set rather than adminSchema. Migration 001 seeds the roles: 1 Owner,
// 2 Admin, 4 Member.
func openMigratedAdminDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

func sessionFor(t *testing.T, database *db.DB, username string, roleID int) (int64, string) {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "$2a$12$placeholder", roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	token := "erase-token-" + username + "-" + t.Name()
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return uid, token
}

func TestAdminAPI_DeleteUser_ErasesTheAccount(t *testing.T) {
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, svc)
	ownerID, ownerToken := sessionFor(t, database, "erase-owner", 1)
	targetID, _ := sessionFor(t, database, "erase-target", 4)

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetID), ownerToken, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(context.Background(), targetID); u != nil {
		t.Error("target row survived the erasure")
	}
	if len(hub.memberBanIDs) != 1 || hub.memberBanIDs[0] != targetID {
		t.Errorf("member_ban broadcasts = %v, want [%d]", hub.memberBanIDs, targetID)
	}
	var audits int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM audit_log WHERE action = 'account_deleted' AND actor_id = ? AND target_id = 0`, ownerID).Scan(&audits); err != nil || audits != 1 {
		t.Errorf("audit rows = %d (%v), want 1", audits, err)
	}

	// Gone means 404 on a repeat.
	w = doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetID), ownerToken, nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("repeat status = %d, want 404", w.Code)
	}
}

func TestAdminAPI_DeleteUser_Refusals(t *testing.T) {
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	ownerID, ownerToken := sessionFor(t, database, "refuse-owner", 1)
	adminID, adminToken := sessionFor(t, database, "refuse-admin", 2)
	memberID, memberToken := sessionFor(t, database, "refuse-member", 4)

	cases := []struct {
		name   string
		path   string
		token  string
		status int
	}{
		{"unauthenticated", "/users/" + itoa(memberID), "", http.StatusUnauthorized},
		{"member lacks the perimeter", "/users/" + itoa(memberID), memberToken, http.StatusForbidden},
		{"admin cannot erase the owner", "/users/" + itoa(ownerID), adminToken, http.StatusForbidden},
		{"owner cannot erase itself here", "/users/" + itoa(ownerID), ownerToken, http.StatusBadRequest},
		{"invalid id", "/users/not-a-number", ownerToken, http.StatusBadRequest},
		{"unknown id", "/users/999999", ownerToken, http.StatusNotFound},
	}
	for _, tc := range cases {
		w := doRequest(t, handler, http.MethodDelete, tc.path, tc.token, nil)
		if w.Code != tc.status {
			t.Errorf("%s: status = %d, want %d; body: %s", tc.name, w.Code, tc.status, w.Body.String())
		}
	}
	for _, id := range []int64{ownerID, adminID, memberID} {
		if u, _ := database.GetUserByID(context.Background(), id); u == nil {
			t.Errorf("user %d was erased by a refused request", id)
		}
	}
}

func TestAdminAPI_DeleteUser_NoModerationServiceFailsClosed(t *testing.T) {
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	svc.Moderation = nil
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	_, ownerToken := sessionFor(t, database, "closed-owner", 1)
	targetID, _ := sessionFor(t, database, "closed-target", 4)

	w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(targetID), ownerToken, nil)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", w.Code)
	}
	if u, _ := database.GetUserByID(context.Background(), targetID); u == nil {
		t.Error("target erased without a moderation service")
	}
}
