package service

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// totpDisconnectSpy stands in for the hub: it records which accounts it was
// asked to drop outright and which to check for a revoked session.
type totpDisconnectSpy struct {
	dropped []int64
	checked []int64
}

func (s *totpDisconnectSpy) BroadcastMemberBan(int64) {}
func (s *totpDisconnectSpy) DisconnectRevokedUser(userID int64) {
	s.dropped = append(s.dropped, userID)
}
func (s *totpDisconnectSpy) DisconnectIfSessionRevoked(userID int64) {
	s.checked = append(s.checked, userID)
}

// Enabling or disabling 2FA revokes the account's other sessions; the
// account's live socket must be checked against them in the same call, not
// left to the sweep, and never dropped outright since the caller's session
// stays.
func TestTOTPChange_ChecksTheAccountsLiveSocket(t *testing.T) {
	ctx := context.Background()
	database := secondFactorDB(t)
	hash, err := auth.HashPassword("correctPass1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(ctx, "toggler", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, _ := database.GetUserByID(ctx, uid)
	if _, err := database.CreateSession(ctx, uid, "kept", "laptop", "10.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	kept, _ := database.GetSessionByTokenHash(ctx, "kept")
	p := Principal{User: user, Session: kept}

	spy := &totpDisconnectSpy{}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), spy)

	if _, err := database.CreateSession(ctx, uid, "stolen-1", "phone", "10.0.0.2"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.EnableTOTP(ctx, p, "correctPass1"); err != nil {
		t.Fatalf("EnableTOTP: %v", err)
	}
	secret, ok := svc.pending.Lookup(ctx, uid)
	if !ok {
		t.Fatal("no staged enrolment")
	}
	code, _ := auth.GenerateTOTPCode(secret, time.Now().UTC())
	if _, err := svc.ConfirmTOTP(ctx, p, "correctPass1", code); err != nil {
		t.Fatalf("ConfirmTOTP: %v", err)
	}
	if len(spy.checked) != 1 || spy.checked[0] != uid {
		t.Fatalf("after enable: checked = %v, want [%d]", spy.checked, uid)
	}

	if _, err := database.CreateSession(ctx, uid, "stolen-2", "tablet", "10.0.0.3"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.DisableTOTP(ctx, p, "correctPass1"); err != nil {
		t.Fatalf("DisableTOTP: %v", err)
	}
	if len(spy.checked) != 2 || spy.checked[1] != uid {
		t.Fatalf("after disable: checked = %v, want [%d %d]", spy.checked, uid, uid)
	}
	if len(spy.dropped) != 0 {
		t.Fatalf("the kept session's socket was dropped outright: %v", spy.dropped)
	}

	// Nothing else to revoke: no check is asked for.
	if _, err := svc.EnableTOTP(ctx, p, "correctPass1"); err != nil {
		t.Fatalf("EnableTOTP: %v", err)
	}
	secret, _ = svc.pending.Lookup(ctx, uid)
	code, _ = auth.GenerateTOTPCode(secret, time.Now().UTC().Add(30*time.Second))
	if _, err := svc.ConfirmTOTP(ctx, p, "correctPass1", code); err != nil {
		t.Fatalf("ConfirmTOTP: %v", err)
	}
	if len(spy.checked) != 2 {
		t.Fatalf("a change that revoked nothing asked for a check: %v", spy.checked)
	}
}
