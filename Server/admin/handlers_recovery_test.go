package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// seedUserInRole creates a user in the given role and returns a bearer token.
func seedUserInRole(t *testing.T, database *db.DB, name string, roleID int) (int64, string) {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), name, "$2a$12$placeholder", roleID)
	if err != nil {
		t.Fatalf("CreateUser %s: %v", name, err)
	}
	token := "test-token-" + name + "-" + t.Name()
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return uid, token
}

func TestAdminAPI_RecoveryCredential_OwnerOnlyIssueAndRedeem(t *testing.T) {
	ctx := context.Background()
	database := openAdminTestDB(t)
	svc := newTestServices(database)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, svc)
	ownerToken := createAdminUser(t, database)
	memberToken := createMemberUser(t, database)
	target, _ := seedUserInRole(t, database, "locked-out", 3)
	if _, err := database.CreateSession(ctx, target, "tok-old-device", "old laptop", "10.0.0.9"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	path := "/users/" + itoa(target) + "/recovery-credential"
	body := map[string]string{"verification": "in_person"}

	// Unauthorized issuance: anonymous, a member (outside the perimeter),
	// and an administrator below the owner position.
	if w := doRequest(t, handler, http.MethodPost, path, "", body); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d, want 401", w.Code)
	}
	if w := doRequest(t, handler, http.MethodPost, path, memberToken, body); w.Code != http.StatusForbidden {
		t.Fatalf("member = %d, want 403; body = %s", w.Code, w.Body.String())
	}
	adminRole, err := database.GetRoleByID(ctx, 2)
	if err != nil || adminRole == nil || adminRole.Position >= permissions.OwnerRolePosition {
		t.Fatalf("this test needs the seeded Admin role (id 2) below the owner position; got %+v, %v", adminRole, err)
	}
	_, adminToken := seedUserInRole(t, database, "just-admin", 2)
	if w := doRequest(t, handler, http.MethodPost, path, adminToken, body); w.Code != http.StatusForbidden {
		t.Fatalf("admin = %d, want 403 (owner-only); body = %s", w.Code, w.Body.String())
	}
	// ADMINISTRATOR does not substitute for the owner position either.
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'JuniorAdmin', ?, 50, 0)`,
		permissions.Administrator); err != nil {
		t.Fatalf("inserting junior admin role: %v", err)
	}
	_, juniorToken := seedUserInRole(t, database, "junior-admin", 9)
	if w := doRequest(t, handler, http.MethodPost, path, juniorToken, body); w.Code != http.StatusForbidden {
		t.Fatalf("ADMINISTRATOR below the owner = %d, want 403; body = %s", w.Code, w.Body.String())
	}
	if a, _ := database.GetRecoveryAssist(ctx, target); a != nil {
		t.Fatalf("a refused issuance stored a credential: %+v", a)
	}

	// The owner: fixed wording only, a real target only.
	if w := doRequest(t, handler, http.MethodPost, path, ownerToken, map[string]string{"verification": "they seemed legit"}); w.Code != http.StatusBadRequest {
		t.Fatalf("free-text verification = %d, want 400; body = %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, handler, http.MethodPost, "/users/424242/recovery-credential", ownerToken, body); w.Code != http.StatusNotFound {
		t.Fatalf("unknown target = %d, want 404; body = %s", w.Code, w.Body.String())
	}
	w := doRequest(t, handler, http.MethodPost, path, ownerToken, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("issue = %d; body = %s", w.Code, w.Body.String())
	}
	var issue struct {
		Credential   string `json:"credential"`
		ExpiresAt    string `json:"expires_at"`
		Username     string `json:"username"`
		Verification string `json:"verification"`
	}
	if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(strings.Split(issue.Credential, "-")) != 6 || issue.Username != "locked-out" || issue.Verification != "in_person" {
		t.Fatalf("issue = %+v, want six groups for the target", issue)
	}
	if exp, err := time.Parse(time.RFC3339, issue.ExpiresAt); err != nil || time.Until(exp) > 15*time.Minute {
		t.Fatalf("expires_at = %q, %v; want within 15 minutes", issue.ExpiresAt, err)
	}

	// The user redeems it through the recovery service (the public route's
	// backend) and signs in without the second factor; the old device is out.
	res, err := svc.Auth.RecoverWithKit(ctx, service.RecoverInput{
		Username: "locked-out", KitSecret: issue.Credential, NewPassword: "Back-In-Business1!", Device: "new phone", IP: "203.0.113.40",
	})
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	sessions, _ := database.ListUserSessions(ctx, target)
	if len(sessions) != 1 || sessions[0].TokenHash != auth.HashToken(res.Token) {
		t.Fatalf("sessions after redemption = %d, want only the new one", len(sessions))
	}
	// Single use.
	if _, err := svc.Auth.RecoverWithKit(ctx, service.RecoverInput{
		Username: "locked-out", KitSecret: issue.Credential, NewPassword: "Back-In-Business2!", Device: "d", IP: "203.0.113.41",
	}); err == nil {
		t.Fatal("the credential was redeemed twice")
	}
}
