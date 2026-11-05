package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// enrolCauseKit gives the cause-log fixture's account a recovery kit and
// returns its secret.
func enrolCauseKit(t *testing.T, f *authCauseFixture) string {
	t.Helper()
	issue, err := f.svc.EnrolRecoveryKit(context.Background(), sessionPrincipal(f.user), causeLogPassword, "")
	mustDo(t, "EnrolRecoveryKit", err)
	return issue.Secret
}

func recoverCause(f *authCauseFixture, secret string) (*AuthResult, error) {
	return f.svc.RecoverWithKit(context.Background(), RecoverInput{
		Username: causeLogUser, KitSecret: secret, NewPassword: "Recovered-Pass2!", Device: "dev", IP: causeLogIP,
	})
}

// A recovery that committed but could not start a session sends the holder to
// sign in: the kit is spent, so "try again" would only burn a lockout attempt.
func TestRecovery_SessionIssueFailureAfterCommitSaysSignIn(t *testing.T) {
	ctx := context.Background()
	f := newAuthCauseFixture(t)
	secret := enrolCauseKit(t, f)

	f.st.fail["CreateSession"] = errors.New("database is locked")
	res, err := recoverCause(f, secret)
	if !errors.Is(err, ErrRecoveredSignInRequired) || res != nil {
		t.Fatalf("recover with a failing session store = %+v, %v; want ErrRecoveredSignInRequired", res, err)
	}
	delete(f.st.fail, "CreateSession")

	if _, err := f.svc.Login(ctx, LoginInput{Username: causeLogUser, Password: "Recovered-Pass2!", Device: "dev", IP: causeLogIP}); err != nil {
		t.Fatalf("login with the new password after the recovery: %v", err)
	}
	if _, err := recoverCause(f, secret); !errors.Is(err, ErrRecoveryKitInvalid) {
		t.Fatalf("second recovery with the same kit = %v, want the spent-kit refusal", err)
	}
}

// An account whose deletion is being completed is refused like Login refuses
// it, not told to sign in.
func TestRecovery_AccountErasingAfterCommitIsRefusedLikeLogin(t *testing.T) {
	f := newAuthCauseFixture(t)
	secret := enrolCauseKit(t, f)

	f.st.fail["CreateSession"] = fmt.Errorf("CreateSession user %d: %w", f.user.ID, db.ErrAccountErasing)
	if _, err := recoverCause(f, secret); !errors.Is(err, ErrBanned) {
		t.Fatalf("recover while the account is erasing = %v, want ErrBanned", err)
	}
}

// cancelAfterAssistStore cancels the request context right after the
// credential is stored, as a client that disconnects at that moment would.
type cancelAfterAssistStore struct {
	*db.DB
	cancel context.CancelFunc
}

func (s *cancelAfterAssistStore) UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error {
	err := s.DB.UpsertRecoveryAssist(ctx, userID, verifier, issuedBy, verification, expiresAt)
	s.cancel()
	return err
}

func TestRecoveryAssist_AuditSurvivesADisconnectAfterStore(t *testing.T) {
	_, owner, user, database := newAssistFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc := NewAuthService(&cancelAfterAssistStore{DB: database, cancel: cancel}, auth.NewRateLimiter(), make([]byte, 32), nil)

	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	var audits int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_assist_issued' AND target_id = ?`, user.ID).Scan(&audits); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	if audits != 1 {
		t.Fatalf("recovery_assist_issued rows = %d, want 1 after the client went away", audits)
	}
}
