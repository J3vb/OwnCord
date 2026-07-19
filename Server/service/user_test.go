package service

import (
	"errors"
	"slices"
	"testing"

	"github.com/owncord/server/db"
)

// pwStore wraps a real *db.DB with controllable DeleteOtherSessions behavior
// and audit capture, so the committed-password partial-success contract (W2-2)
// is testable. Embedding *db.DB satisfies the service Store interface; the two
// overridden methods intercept the calls the contract turns on while every
// other call (UpdateUserPassword, GetUserByID) hits the real database.
type pwStore struct {
	*db.DB
	failRevokes int // number of DeleteOtherSessions calls that fail before succeeding
	revokeCalls int
	audits      []string
}

func (f *pwStore) DeleteOtherSessions(_, _ int64) (int64, error) {
	f.revokeCalls++
	if f.revokeCalls <= f.failRevokes {
		return 0, errors.New("session table locked")
	}
	return 2, nil
}

func (f *pwStore) LogAudit(_ int64, action, _ string, _ int64, _ string) error {
	f.audits = append(f.audits, action)
	return nil
}

// TestChangePassword_RevokeFailureIsPartialSuccess locks the W2-2 contract:
// once the password is committed, revocation failure must never surface as an
// error (the old password is dead; a "failed" report walks the user into the
// confirm lockout), and the audit row must still be written.
func TestChangePassword_RevokeFailureIsPartialSuccess(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 7, Username: "pat", PasswordHash: "oldhash"})
	fs := &pwStore{DB: database, failRevokes: 99}
	svc := NewUserService(fs)

	res, err := svc.ChangePassword(7, "newhash", 1)
	if err != nil {
		t.Fatalf("committed password change must not return an error: %v", err)
	}
	if !res.RevokeFailed {
		t.Fatal("RevokeFailed should be set when revocation keeps failing")
	}
	if u, _ := database.GetUserByID(7); u.PasswordHash != "newhash" {
		t.Fatal("password should be committed")
	}
	if !slices.Contains(fs.audits, "password_change") {
		t.Fatal("audit row must be written even when revocation fails")
	}
}

// TestChangePassword_RetryRecoversRevocation: a single transient revocation
// failure is absorbed by the bounded compensating retry.
func TestChangePassword_RetryRecoversRevocation(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 7, Username: "pat", PasswordHash: "oldhash"})
	fs := &pwStore{DB: database, failRevokes: 1}
	svc := NewUserService(fs)

	res, err := svc.ChangePassword(7, "newhash", 1)
	if err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}
	if res.RevokeFailed {
		t.Fatal("retry should have recovered the revocation")
	}
	if res.SessionsRevoked != 2 {
		t.Fatalf("SessionsRevoked = %d, want 2", res.SessionsRevoked)
	}
	if fs.revokeCalls != 2 {
		t.Fatalf("expected exactly one retry (2 calls), got %d", fs.revokeCalls)
	}
}
