package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// B4-1's registration-mode state matrix (BPR-041, BG-10): every register
// attempt × mode × invite state, with the consequences — whether an account
// exists afterwards, whether it is locked, and whether the invite was spent.
func TestRegister_ModeMatrix(t *testing.T) {
	type inviteState string
	const (
		valid   inviteState = "valid"
		expired inviteState = "expired"
		revoked inviteState = "revoked"
		absent  inviteState = "absent"
		usedUp  inviteState = "used-up"
	)
	states := []inviteState{valid, expired, revoked, absent, usedUp}
	want := map[string]map[inviteState]int{
		"closed":   {valid: 403, expired: 403, revoked: 403, absent: 403, usedUp: 403},
		"invite":   {valid: 201, expired: 400, revoked: 400, absent: 400, usedUp: 400},
		"approval": {valid: 202, expired: 202, revoked: 202, absent: 202, usedUp: 202},
		"open":     {valid: 201, expired: 201, revoked: 201, absent: 201, usedUp: 201},
	}
	for _, mode := range []string{"closed", "invite", "approval", "open"} {
		for _, st := range states {
			t.Run(mode+"/"+string(st), func(t *testing.T) {
				ctx := context.Background()
				database := newAuthTestDB(t)
				router := buildAuthRouter(database, auth.NewRateLimiter())
				setSetting(t, database, "registration_mode", mode)
				ownerID, err := database.CreateUser(ctx, "owner", "hash", 1)
				if err != nil {
					t.Fatalf("CreateUser: %v", err)
				}
				code := ""
				switch st {
				case valid:
					code, err = database.CreateInvite(ctx, ownerID, 1, nil)
				case expired:
					past := time.Now().Add(-time.Hour)
					code, err = database.CreateInvite(ctx, ownerID, 1, &past)
				case revoked:
					code, err = database.CreateInvite(ctx, ownerID, 1, nil)
					if err == nil {
						err = database.RevokeInvite(ctx, code)
					}
				case usedUp:
					code, err = database.CreateInvite(ctx, ownerID, 1, nil)
					if err == nil {
						_, err = database.ExecContext(ctx, `UPDATE invites SET use_count = max_uses WHERE code = ?`, code)
					}
				case absent:
					// No invite at all.
				}
				if err != nil {
					t.Fatalf("invite setup: %v", err)
				}

				rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
					"username": "fresh", "password": "securePass1", "invite_code": code,
				})
				if rr.Code != want[mode][st] {
					t.Fatalf("status = %d, want %d; body = %s", rr.Code, want[mode][st], rr.Body.String())
				}

				u, err := database.GetUserByUsername(ctx, "fresh")
				if err != nil {
					t.Fatalf("GetUserByUsername: %v", err)
				}
				admitted := rr.Code == http.StatusCreated || rr.Code == http.StatusAccepted
				if (u != nil) != admitted {
					t.Fatalf("account exists = %v after status %d", u != nil, rr.Code)
				}
				if u != nil && u.PendingApproval() != (rr.Code == http.StatusAccepted) {
					t.Errorf("registration_status = %q after status %d", u.RegistrationStatus, rr.Code)
				}
				if st == valid {
					inv, err := database.GetInvite(ctx, code)
					if err != nil || inv == nil {
						t.Fatalf("GetInvite: %v", err)
					}
					wantUses := 0
					if mode == "invite" {
						wantUses = 1
					}
					if inv.Uses != wantUses {
						t.Errorf("invite uses = %d, want %d (only invite mode spends an invite)", inv.Uses, wantUses)
					}
				}
			})
		}
	}
}

// Approval mode (owner decision 1): the application is an account that
// cannot sign in until an admin approves it; denial removes it.
func TestRegister_ApprovalMode_LockedUntilApproved(t *testing.T) {
	ctx := context.Background()
	database := newAuthTestDB(t)
	router := buildAuthRouter(database, auth.NewRateLimiter())
	setSetting(t, database, "registration_mode", "approval")

	rr := postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username": "applicant", "password": "securePass1",
	})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("register status = %d, want 202; body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["status"] != "pending_approval" || resp["token"] != nil {
		t.Fatalf("body = %v, want status pending_approval and no token", resp)
	}
	applicant, err := database.GetUserByUsername(ctx, "applicant")
	if err != nil || applicant == nil || !applicant.PendingApproval() {
		t.Fatalf("applicant = %+v, %v; want a pending row", applicant, err)
	}
	if sessions, err := database.ListUserSessions(ctx, applicant.ID); err != nil || len(sessions) != 0 {
		t.Fatalf("sessions = %d, %v; want none for a pending application", len(sessions), err)
	}

	login := map[string]string{"username": "applicant", "password": "securePass1"}
	rr = postJSON(t, router, "/api/v1/auth/login", login)
	wantErr(t, rr, http.StatusForbidden, "FORBIDDEN", "account is awaiting approval")

	if err := service.NewUserService(database).ApproveRegistration(ctx, 1, applicant.ID); err != nil {
		t.Fatalf("ApproveRegistration: %v", err)
	}
	rr = postJSON(t, router, "/api/v1/auth/login", login)
	if rr.Code != http.StatusOK {
		t.Fatalf("login after approval = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}

	// A denied application is locked for good and its username released:
	// the same name can apply again, and the old credentials never sign in.
	rr = postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username": "denied", "password": "securePass1",
	})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("register status = %d, want 202", rr.Code)
	}
	denied, _ := database.GetUserByUsername(ctx, "denied")
	if err := service.NewUserService(database).DenyRegistration(ctx, 1, denied.ID); err != nil {
		t.Fatalf("DenyRegistration: %v", err)
	}
	if u, _ := database.GetUserByUsername(ctx, "denied"); u != nil {
		t.Fatal("the denied username was not released")
	}
	rr = postJSON(t, router, "/api/v1/auth/login", map[string]string{"username": "denied", "password": "securePass1"})
	if rr.Code == http.StatusOK {
		t.Fatal("a denied application could sign in")
	}
	rr = postJSON(t, router, "/api/v1/auth/register", map[string]string{
		"username": "denied", "password": "securePass1",
	})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("re-application with the released name: status = %d, want 202; body = %s", rr.Code, rr.Body.String())
	}
}
