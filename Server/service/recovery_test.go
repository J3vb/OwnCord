package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

const kitPassword = "KitHolderPass1!"

// newKitService seeds an account (with 2FA enrolled when totp is true) and
// returns the service, the user and a captured log so the hygiene checks
// can grep it.
func newKitService(t *testing.T, totp bool) (*AuthService, *db.User, *bytes.Buffer) {
	t.Helper()
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword(kitPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	uid, err := database.CreateUser(ctx, "kitholder", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	key := make([]byte, 32)
	if totp {
		secret, _ := auth.GenerateTOTPSecret()
		enc, err := auth.EncryptTOTPSecret(key, secret)
		if err != nil {
			t.Fatalf("EncryptTOTPSecret: %v", err)
		}
		if err := database.UpdateUserTOTPSecret(ctx, uid, &enc); err != nil {
			t.Fatalf("UpdateUserTOTPSecret: %v", err)
		}
	}
	for _, dev := range []string{"laptop", "phone"} {
		if _, err := database.CreateSession(ctx, uid, "tok-"+dev, dev, "10.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	user, _ := database.GetUserByID(ctx, uid)

	logs := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return NewAuthService(database, auth.NewRateLimiter(), key, nil), user, logs
}

func recoverWith(svc *AuthService, username, secret, ip string) (*AuthResult, error) {
	return svc.RecoverWithKit(context.Background(), RecoverInput{
		Username: username, KitSecret: secret, NewPassword: "Recovered-Pass2!", Device: "test", IP: ip,
	})
}

type recordingRecoveryDisconnector struct {
	disconnected []int64
}

func (*recordingRecoveryDisconnector) BroadcastMemberBan(int64) {}

func (r *recordingRecoveryDisconnector) DisconnectRevokedUser(userID int64) {
	r.disconnected = append(r.disconnected, userID)
}

// Recovery is a session-compromise boundary: deleting the rows is not enough
// for a socket that already authenticated. The replacement session is issued
// only after the old live connection has been cut off.
func TestRecoveryKit_DisconnectsRevokedLiveSocket(t *testing.T) {
	ctx := context.Background()
	svc, user, _ := newKitService(t, false)
	disconnector := &recordingRecoveryDisconnector{}
	svc.broadcaster = disconnector
	issue, err := svc.EnrolRecoveryKit(ctx, Principal{User: user}, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	wrong, _, err := auth.GenerateRecoveryKitSecret()
	if err != nil {
		t.Fatalf("GenerateRecoveryKitSecret: %v", err)
	}
	if _, err := recoverWith(svc, "kitholder", wrong, "203.0.113.4"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong kit = %v, want the uniform refusal", err)
	}
	if len(disconnector.disconnected) != 0 {
		t.Fatalf("failed recovery disconnected %v", disconnector.disconnected)
	}
	if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.5"); err != nil {
		t.Fatalf("RecoverWithKit: %v", err)
	}
	if len(disconnector.disconnected) != 1 || disconnector.disconnected[0] != user.ID {
		t.Fatalf("disconnected = %v, want [%d]", disconnector.disconnected, user.ID)
	}
}

func TestRecoveryKit_EnrolRecoverRotate(t *testing.T) {
	ctx := context.Background()
	svc, user, logs := newKitService(t, true)
	p := Principal{User: user}

	status, err := svc.RecoveryKitStatus(ctx, p)
	if err != nil || status.Enrolled {
		t.Fatalf("status before enrolment = %+v, %v; want not enrolled", status, err)
	}
	if _, err := svc.EnrolRecoveryKit(ctx, p, "wrong password", ""); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("enrol with a wrong password = %v, want the password refusal", err)
	}
	issue, err := svc.EnrolRecoveryKit(ctx, p, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	if issue.Secret == "" || issue.CreatedAt == "" {
		t.Fatalf("issue = %+v, want the secret handed out once", issue)
	}
	canonical, _ := auth.NormalizeRecoveryKitSecret(issue.Secret)
	if status, _ := svc.RecoveryKitStatus(ctx, p); !status.Enrolled {
		t.Fatal("status after enrolment says not enrolled")
	}
	kit, _ := svc.st.GetRecoveryKit(ctx, user.ID)
	if kit == nil || strings.Contains(kit.Verifier, canonical) || !strings.HasPrefix(kit.Verifier, "$argon2id$") {
		t.Fatalf("stored verifier = %q, want an argon2id verifier that does not contain the secret", kit.Verifier)
	}

	// Recovery: signs in without the second factor (the account has TOTP),
	// replaces the password, revokes every session, spends the kit.
	res, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.5")
	if err != nil {
		t.Fatalf("RecoverWithKit: %v", err)
	}
	if res.Token == "" || res.Requires2FA {
		t.Fatalf("recovery result = %+v, want a session without a 2FA challenge", res)
	}
	sessions, _ := svc.st.ListUserSessions(ctx, user.ID)
	if len(sessions) != 1 || sessions[0].TokenHash != auth.HashToken(res.Token) {
		t.Fatalf("sessions after recovery = %d, want only the fresh one", len(sessions))
	}
	if _, err := svc.Login(ctx, LoginInput{Username: "kitholder", Password: kitPassword, Device: "t", IP: "203.0.113.6"}); err == nil {
		t.Fatal("the old password still signs in")
	}
	if status, _ := svc.RecoveryKitStatus(ctx, p); status.Enrolled || status.UsedAt == nil {
		t.Fatalf("status after recovery = %+v, want spent", status)
	}
	// Spent: the same secret is refused, and re-enrolment issues a new one.
	if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.7"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("spent kit = %v, want the uniform refusal", err)
	}
	fresh, _ := svc.st.GetUserByID(ctx, user.ID)
	again, err := svc.EnrolRecoveryKit(ctx, Principal{User: fresh}, "Recovered-Pass2!", "")
	if err != nil || again.Secret == issue.Secret {
		t.Fatalf("re-enrolment = %+v, %v; want a different secret", again, err)
	}

	// Hygiene: neither secret nor verifier reaches the log or the audit rows.
	verifierNow, _ := svc.st.GetRecoveryKit(ctx, user.ID)
	for _, leak := range []string{issue.Secret, canonical, kit.Verifier, again.Secret, verifierNow.Verifier} {
		if strings.Contains(logs.String(), leak) {
			t.Fatalf("the log contains recovery material: %q", leak)
		}
	}
	rows, err := svc.st.(*db.DB).QueryContext(ctx, `SELECT action, detail FROM audit_log WHERE actor_id = ?`, user.ID)
	if err != nil {
		t.Fatalf("query audit: %v", err)
	}
	defer rows.Close() //nolint:errcheck
	actions := map[string]bool{}
	for rows.Next() {
		var action, detail string
		if err := rows.Scan(&action, &detail); err != nil {
			t.Fatalf("scan: %v", err)
		}
		actions[action] = true
		for _, leak := range []string{issue.Secret, canonical, kit.Verifier} {
			if strings.Contains(detail, leak) {
				t.Fatalf("audit row %s carries recovery material", action)
			}
		}
	}
	if !actions["recovery_kit_issued"] || !actions["recovery_kit_used"] {
		t.Fatalf("audit actions = %v, want recovery_kit_issued and recovery_kit_used", actions)
	}
}

func TestRecoveryKit_ClientGeneratedSecret(t *testing.T) {
	ctx := context.Background()
	svc, user, _ := newKitService(t, false)
	p := Principal{User: user}
	if _, err := svc.EnrolRecoveryKit(ctx, p, kitPassword, "too-short"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("malformed client secret = %v, want ErrBadRequest", err)
	}
	shown, _, _ := auth.GenerateRecoveryKitSecret()
	issue, err := svc.EnrolRecoveryKit(ctx, p, kitPassword, strings.ToLower(shown))
	if err != nil {
		t.Fatalf("EnrolRecoveryKit(client secret): %v", err)
	}
	if issue.Secret != "" {
		t.Fatal("a client-generated secret was echoed back")
	}
	if _, err := recoverWith(svc, "KITHOLDER", shown, "203.0.113.8"); err != nil {
		t.Fatalf("recovery with the client secret: %v", err)
	}
}

func TestRecoveryKit_UniformRefusalsAndLockout(t *testing.T) {
	ctx := context.Background()
	svc, user, _ := newKitService(t, false)
	issue, err := svc.EnrolRecoveryKit(ctx, Principal{User: user}, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	wrong, _, _ := auth.GenerateRecoveryKitSecret()
	if _, err := recoverWith(svc, "nobody", wrong, "203.0.113.9"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unknown account = %v, want the uniform refusal", err)
	}
	if _, err := recoverWith(svc, "kitholder", wrong, "203.0.113.9"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong secret = %v, want the uniform refusal", err)
	}
	// Five failures against the account lock recovery for it — even with
	// the right secret, from another address — and are audited.
	for i := range recoveryKitFailureThreshold {
		_, _ = recoverWith(svc, "kitholder", wrong, fmt.Sprintf("203.0.113.%d", 30+i))
	}
	if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.40"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("after %d failures = %v, want the lockout", recoveryKitFailureThreshold, err)
	}
	var locked int
	if err := svc.st.(*db.DB).QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_kit_locked' AND actor_id = ?`, user.ID).Scan(&locked); err != nil || locked != 1 {
		t.Fatalf("recovery_kit_locked rows = %d, %v; want 1", locked, err)
	}
	kit, _ := svc.st.GetRecoveryKit(ctx, user.ID)
	if kit.UsedAt != nil {
		t.Fatal("a refused attempt spent the kit")
	}
}

func TestRecoveryKit_ConcurrentRedemptionAdmitsOne(t *testing.T) {
	ctx := context.Background()
	svc, user, _ := newKitService(t, false)
	issue, err := svc.EnrolRecoveryKit(ctx, Principal{User: user}, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	const racers = 4
	results := make(chan error, racers)
	var wg sync.WaitGroup
	for i := range racers {
		wg.Go(func() {
			_, err := recoverWith(svc, "kitholder", issue.Secret, fmt.Sprintf("203.0.113.%d", 50+i))
			results <- err
		})
	}
	wg.Wait()
	close(results)
	ok := 0
	for err := range results {
		if err == nil {
			ok++
		} else if !errors.Is(err, ErrUnauthorized) && !errors.Is(err, ErrRateLimited) {
			t.Errorf("unexpected outcome: %v", err)
		}
	}
	if ok != 1 {
		t.Fatalf("%d redemptions succeeded, want exactly 1", ok)
	}
	if sessions, _ := svc.st.ListUserSessions(ctx, user.ID); len(sessions) != 1 {
		t.Fatalf("sessions = %d, want the one winner's", len(sessions))
	}
}

func TestRecoveryKit_AdmissionBudgetRefusesWithoutWork(t *testing.T) {
	ctx := context.Background()
	svc, user, _ := newKitService(t, false)
	issue, err := svc.EnrolRecoveryKit(ctx, Principal{User: user}, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	svc.limiter.SetAdmissionBudget(1)
	release, admitted := svc.limiter.Admission().TryAcquire()
	if !admitted {
		t.Fatal("could not hold the only slot")
	}
	if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.60"); !errors.Is(err, ErrRateLimited) || !strings.Contains(err.Error(), "in progress") {
		t.Fatalf("with the budget held = %v, want ErrAuthBusy", err)
	}
	release()
	kit, _ := svc.st.GetRecoveryKit(ctx, user.ID)
	if kit.UsedAt != nil {
		t.Fatal("a refused attempt spent the kit")
	}
	if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.61"); err != nil {
		t.Fatalf("recovery once the slot is back: %v", err)
	}
}

// A refusal for load charges no attempt (Codex on #1512): an honest holder
// retrying through a busy period is not locked out by the refusals.
func TestRecoveryKit_AdmissionRefusalChargesNoAttempt(t *testing.T) {
	ctx := context.Background()
	svc, user, _ := newKitService(t, false)
	issue, err := svc.EnrolRecoveryKit(ctx, Principal{User: user}, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	svc.limiter.SetAdmissionBudget(1)
	release, admitted := svc.limiter.Admission().TryAcquire()
	if !admitted {
		t.Fatal("could not hold the only slot")
	}
	for i := range recoveryKitFailureThreshold + 2 {
		if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.90"); err != ErrAuthBusy { //nolint:errorlint // the sentinel itself, not its kind
			t.Fatalf("attempt %d under load = %v, want ErrAuthBusy", i+1, err)
		}
	}
	release()
	if _, err := recoverWith(svc, "kitholder", issue.Secret, "203.0.113.90"); err != nil {
		t.Fatalf("recover after the busy period = %v, want success (the refusals must not have counted)", err)
	}
}
