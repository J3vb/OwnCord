package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// These two tests pin OC-0253: once CreateOwnerIfEmpty has committed the
// owner row, a failure in one of the remaining best-effort steps
// (CreateSession, CreateInvite) must never surface as a 5xx. A 5xx at that
// point orphans the just-created owner — the setup endpoint's gate is "no
// users exist", so every retry after the account exists hits db.ErrConflict
// and is refused with 403 "setup has already been completed" forever, with
// the wizard payload never applied and the bootstrap invite never minted.
//
// Each test breaks exactly one satellite table so that CreateOwnerIfEmpty
// (which only touches `users`) still commits, isolating the failure to the
// single downstream step under test.

// TestSetup_SessionCreationFailureDoesNotOrphanOwner breaks the sessions
// table (independent of `users`) so CreateSession fails after the owner
// commits, then asserts the account is still reported as created — with a
// warning, not a 500 — and is actually present in the database afterward.
func TestSetup_SessionCreationFailureDoesNotOrphanOwner(t *testing.T) {
	database := openAdminTestDB(t)

	if _, err := database.ExecContext(context.Background(), `DROP TABLE sessions`); err != nil {
		t.Fatalf("DROP TABLE sessions: %v", err)
	}

	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "owner1",
		"password": "SecurePass123!",
	})

	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup with a broken sessions table = %d, want 201 (the owner account must still be usable); body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		UserID     int64    `json:"user_id"`
		Username   string   `json:"username"`
		InviteCode string   `json:"invite_code"`
		Warnings   []string `json:"warnings"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.UserID == 0 {
		t.Error("user_id is 0: owner account was not reported as created")
	}
	if len(resp.Warnings) == 0 {
		t.Error("warnings is empty: the session-creation failure must be surfaced, not swallowed")
	}

	// The crux of OC-0253: without the fix the handler answers 500 here and
	// a retry of POST /setup gets 403 "setup has already been completed"
	// forever, with no way to recover the account it just orphaned.
	user, err := database.GetUserByUsername(context.Background(), "owner1")
	if err != nil || user == nil {
		t.Fatalf("owner account was not created: (%v, %v)", user, err)
	}
	if user.RoleID != 1 {
		t.Errorf("role_id = %d, want 1 (Owner)", user.RoleID)
	}
}

// TestSetup_InviteCreationFailureDoesNotOrphanOwner breaks the invites table
// so CreateInvite fails after the owner (and its session) commit, then
// asserts the account and session are still reported as created — with a
// warning instead of a 500 — rather than the whole request failing.
func TestSetup_InviteCreationFailureDoesNotOrphanOwner(t *testing.T) {
	database := openAdminTestDB(t)

	if _, err := database.ExecContext(context.Background(), `DROP TABLE invites`); err != nil {
		t.Fatalf("DROP TABLE invites: %v", err)
	}

	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]string{
		"username": "owner2",
		"password": "SecurePass123!",
	})

	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup with a broken invites table = %d, want 201 (the owner account must still be usable); body=%s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Token      string   `json:"token"`
		UserID     int64    `json:"user_id"`
		InviteCode string   `json:"invite_code"`
		Warnings   []string `json:"warnings"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.UserID == 0 {
		t.Error("user_id is 0: owner account was not reported as created")
	}
	if len(resp.Warnings) == 0 {
		t.Error("warnings is empty: the invite-creation failure must be surfaced, not swallowed")
	}

	user, err := database.GetUserByUsername(context.Background(), "owner2")
	if err != nil || user == nil {
		t.Fatalf("owner account was not created: (%v, %v)", user, err)
	}
}
