package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newAssistFixture is newKitService plus the server owner who issues
// credentials.
func newAssistFixture(t *testing.T, totp bool) (*AuthService, *db.User, *db.User, *db.DB) {
	t.Helper()
	svc, user, _ := newKitService(t, totp)
	database := svc.st.(*db.DB)
	ctx := context.Background()
	oid, err := database.CreateUser(ctx, "owner", "hash", int(permissions.OwnerRoleID))
	if err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	owner, _ := database.GetUserByID(ctx, oid)
	return svc, owner, user, database
}

func TestRecoveryAssist_IssueIsOwnerOnlyWithFixedWording(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, false)

	if _, err := svc.IssueRecoveryAssist(ctx, user.ID, owner.ID, "in_person"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("issue by a member = %v, want forbidden", err)
	}
	if _, err := svc.IssueRecoveryAssist(ctx, 0, user.ID, "in_person"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("issue by an unknown actor = %v, want forbidden", err)
	}
	for _, bad := range []string{"", "checked their ID at the office", "IN_PERSON"} {
		if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, bad); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("verification %q = %v, want bad request", bad, err)
		}
	}
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, 9999, "in_person"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown target = %v, want not found", err)
	}
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, owner.ID, "in_person"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("self-issuance = %v, want bad request", err)
	}
	if err := database.BanUser(ctx, user.ID, "test", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("banned target = %v, want bad request", err)
	}
	if a, _ := database.GetRecoveryAssist(ctx, user.ID); a != nil {
		t.Fatalf("a refused issuance stored a credential: %+v", a)
	}
	var audits int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'recovery_assist_issued'`).Scan(&audits)
	if audits != 0 {
		t.Fatalf("refused issuances wrote %d audit rows", audits)
	}
}

func TestRecoveryAssist_RedeemsOnceWithoutSecondFactor(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, true)
	_, _, logs := newKitService(t, false) // a fresh captured log for this test's hygiene check
	_ = logs

	issue, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "video_call")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	if groups := strings.Split(issue.Credential, "-"); len(groups) != 6 || len(issue.Credential) != 29 || issue.Username != "kitholder" {
		t.Fatalf("issue = %+v, want six groups of four for the target", issue)
	}
	expires, err := time.Parse(time.RFC3339, issue.ExpiresAt)
	if err != nil || time.Until(expires) > 15*time.Minute || time.Until(expires) < 14*time.Minute {
		t.Fatalf("expires_at = %q (%v), want 15 minutes out", issue.ExpiresAt, err)
	}
	canonical, kind := auth.NormalizeRecoverySecret(issue.Credential)
	if kind != auth.RecoverySecretAssist {
		t.Fatalf("credential kind = %v, want assist", kind)
	}
	stored, _ := database.GetRecoveryAssist(ctx, user.ID)
	if stored == nil || strings.Contains(stored.Verifier, canonical) || !strings.HasPrefix(stored.Verifier, "$argon2id$") || stored.IssuedBy != owner.ID {
		t.Fatalf("stored credential = %+v, want an argon2id verifier issued by the owner", stored)
	}

	// The account has TOTP: recovery signs in without the challenge,
	// replaces the password and revokes every session.
	res, err := recoverWith(svc, "kitholder", issue.Credential, "203.0.113.5")
	if err != nil {
		t.Fatalf("recover with the credential: %v", err)
	}
	if res.Token == "" || res.Requires2FA {
		t.Fatalf("recovery result = %+v, want a session without a 2FA challenge", res)
	}
	if sessions, _ := database.ListUserSessions(ctx, user.ID); len(sessions) != 1 || sessions[0].TokenHash != auth.HashToken(res.Token) {
		t.Fatalf("sessions after recovery = %d, want only the fresh one", len(sessions))
	}
	if _, err := svc.Login(ctx, LoginInput{Username: "kitholder", Password: kitPassword, Device: "t", IP: "203.0.113.6"}); err == nil {
		t.Fatal("the old password still signs in")
	}
	if a, _ := database.GetRecoveryAssist(ctx, user.ID); a != nil {
		t.Fatalf("credential after redemption = %+v, want consumed", a)
	}
	// Replay: the same credential is refused with the uniform answer.
	if _, err := recoverWith(svc, "kitholder", issue.Credential, "203.0.113.7"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replayed credential = %v, want the uniform refusal", err)
	}

	// The safe audit record (BPR-045): issuance names the owner and the
	// account, redemption the account; neither row nor the log carries the
	// credential or its verifier.
	rows, err := database.QueryContext(ctx, `SELECT actor_id, action, target_id, detail FROM audit_log WHERE action LIKE 'recovery_assist_%'`)
	if err != nil {
		t.Fatalf("query audit: %v", err)
	}
	defer rows.Close() //nolint:errcheck
	seen := map[string][2]int64{}
	for rows.Next() {
		var actor, target int64
		var action, detail string
		if err := rows.Scan(&actor, &action, &target, &detail); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen[action] = [2]int64{actor, target}
		for _, leak := range []string{issue.Credential, canonical, stored.Verifier} {
			if strings.Contains(detail, leak) {
				t.Fatalf("audit row %s carries recovery material", action)
			}
		}
	}
	if seen["recovery_assist_issued"] != [2]int64{owner.ID, user.ID} || seen["recovery_assist_used"] != [2]int64{user.ID, user.ID} {
		t.Fatalf("audit rows = %v, want issued by the owner for the account and used by the account", seen)
	}
}

func TestRecoveryAssist_LogCarriesNoRecoveryMaterial(t *testing.T) {
	ctx := context.Background()
	svc, user, logs := newKitService(t, false)
	database := svc.st.(*db.DB)
	oid, _ := database.CreateUser(ctx, "owner", "hash", int(permissions.OwnerRoleID))
	owner, _ := database.GetUserByID(ctx, oid)
	issue, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	canonical, _ := auth.NormalizeRecoverySecret(issue.Credential)
	stored, _ := database.GetRecoveryAssist(ctx, user.ID)
	if _, err := recoverWith(svc, "kitholder", issue.Credential, "203.0.113.5"); err != nil {
		t.Fatalf("recover: %v", err)
	}
	if !strings.Contains(logs.String(), "recovery credential issued") || !strings.Contains(logs.String(), "account recovered") {
		t.Fatalf("log lacks the issuance and recovery lines:\n%s", logs.String())
	}
	for _, leak := range []string{issue.Credential, canonical, stored.Verifier} {
		if strings.Contains(logs.String(), leak) {
			t.Fatalf("the log contains recovery material: %q", leak)
		}
	}
}

func TestRecoveryAssist_ExpiryAndReplacement(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, false)
	first, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	// Expired: the server's clock moved past expires_at.
	if _, err := database.ExecContext(ctx, `UPDATE recovery_assists SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?`, user.ID); err != nil {
		t.Fatalf("expire: %v", err)
	}
	if _, err := recoverWith(svc, "kitholder", first.Credential, "203.0.113.8"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expired credential = %v, want the uniform refusal", err)
	}
	if sessions, _ := database.ListUserSessions(ctx, user.ID); len(sessions) != 2 {
		t.Fatalf("sessions after a refused attempt = %d, want both kept", len(sessions))
	}
	// A new issuance replaces it; the old credential never works again.
	second, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "voice_call")
	if err != nil {
		t.Fatalf("re-issue: %v", err)
	}
	if _, err := recoverWith(svc, "kitholder", first.Credential, "203.0.113.9"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replaced credential = %v, want the uniform refusal", err)
	}
	if _, err := recoverWith(svc, "kitholder", second.Credential, "203.0.113.10"); err != nil {
		t.Fatalf("the replacement credential = %v, want success", err)
	}
}

// Restart mid-flow: the credential lives in the database, so a server that
// restarts between issuance and redemption still honours it — and nothing
// else (a limiter's memory, a cached verifier) is needed.
func TestRecoveryAssist_SurvivesARestart(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, false)
	issue, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	restarted := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	if _, err := recoverWith(restarted, "kitholder", issue.Credential, "203.0.113.11"); err != nil {
		t.Fatalf("recover after restart: %v", err)
	}
	if _, err := recoverWith(restarted, "kitholder", issue.Credential, "203.0.113.12"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replay after restart = %v, want the uniform refusal", err)
	}
}

func TestRecoveryAssist_ConcurrentRedemptionAdmitsOne(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, false)
	issue, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	const racers = 4
	results := make(chan error, racers)
	var wg sync.WaitGroup
	for i := range racers {
		wg.Go(func() {
			_, err := recoverWith(svc, "kitholder", issue.Credential, fmt.Sprintf("203.0.113.%d", 60+i))
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
	if sessions, _ := database.ListUserSessions(ctx, user.ID); len(sessions) != 1 {
		t.Fatalf("sessions = %d, want the one winner's", len(sessions))
	}
}

func TestRecoveryAssist_KitAndCredentialDoNotInterfere(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, false)
	kit, err := svc.EnrolRecoveryKit(ctx, Principal{User: user}, kitPassword, "")
	if err != nil {
		t.Fatalf("EnrolRecoveryKit: %v", err)
	}
	cred, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person")
	if err != nil {
		t.Fatalf("IssueRecoveryAssist: %v", err)
	}
	// A credential presented where a kit is expected, and vice versa, is
	// just a wrong secret; the kit stays enrolled after an assisted recovery.
	if _, err := recoverWith(svc, "kitholder", cred.Credential[:29], "203.0.113.20"); err != nil {
		t.Fatalf("credential = %v, want success", err)
	}
	if status, _ := svc.RecoveryKitStatus(ctx, Principal{User: user}); !status.Enrolled {
		t.Fatal("an assisted recovery spent the account's own kit")
	}
	if _, err := recoverWith(svc, "kitholder", kit.Secret, "203.0.113.21"); err != nil {
		t.Fatalf("kit after an assisted recovery = %v, want success", err)
	}
	// A kit recovery withdraws an outstanding credential.
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); err != nil {
		t.Fatalf("re-issue: %v", err)
	}
	recovered, _ := database.GetUserByID(ctx, user.ID)
	again, err := svc.EnrolRecoveryKit(ctx, Principal{User: recovered}, "Recovered-Pass2!", "")
	if err != nil {
		t.Fatalf("re-enrol: %v", err)
	}
	if _, err := recoverWith(svc, "kitholder", again.Secret, "203.0.113.22"); err != nil {
		t.Fatalf("kit: %v", err)
	}
	if a, _ := database.GetRecoveryAssist(ctx, user.ID); a != nil {
		t.Fatalf("credential after a kit recovery = %+v, want withdrawn", a)
	}
}

func TestRecoveryAssist_IssuanceIsBudgeted(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, database := newAssistFixture(t, false)
	// Per target: the fourth issuance for one account within the hour is refused.
	for i := range recoveryAssistTargetLimit {
		if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); err != nil {
			t.Fatalf("issuance %d: %v", i+1, err)
		}
	}
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("over the per-target budget = %v, want rate limited", err)
	}
	// Per owner: across accounts, the sixth issuance is refused.
	others := make([]int64, 0, recoveryAssistIssueLimit)
	for i := range recoveryAssistIssueLimit {
		uid, err := database.CreateUser(ctx, fmt.Sprintf("other%d", i), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		others = append(others, uid)
	}
	issued := 0
	for _, uid := range others {
		if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, uid, "in_person"); err == nil {
			issued++
		} else if !errors.Is(err, ErrRateLimited) {
			t.Fatalf("unexpected refusal: %v", err)
		}
	}
	if issued != recoveryAssistIssueLimit-recoveryAssistTargetLimit {
		t.Fatalf("%d further issuances succeeded, want %d (the owner's budget less the three spent)", issued, recoveryAssistIssueLimit-recoveryAssistTargetLimit)
	}
}

// The two issuance budgets are reserved atomically (Codex on #1513): a
// concurrent burst across targets cannot slip past the owner's limit.
func TestRecoveryAssist_IssuanceBudgetHoldsUnderConcurrency(t *testing.T) {
	ctx := context.Background()
	svc, owner, _, database := newAssistFixture(t, false)
	const racers = 8
	targets := make([]int64, 0, racers)
	for i := range racers {
		uid, err := database.CreateUser(ctx, fmt.Sprintf("target%d", i), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		targets = append(targets, uid)
	}
	svc.limiter.SetAdmissionBudget(racers)
	results := make(chan error, racers)
	var wg sync.WaitGroup
	for _, uid := range targets {
		wg.Go(func() {
			_, err := svc.IssueRecoveryAssist(ctx, owner.ID, uid, "in_person")
			results <- err
		})
	}
	wg.Wait()
	close(results)
	issued := 0
	for err := range results {
		if err == nil {
			issued++
		} else if !errors.Is(err, ErrRateLimited) {
			t.Errorf("unexpected outcome: %v", err)
		}
	}
	if issued != recoveryAssistIssueLimit {
		t.Fatalf("%d credentials issued concurrently, want exactly the owner's budget %d", issued, recoveryAssistIssueLimit)
	}
}

// A refusal for load charges no issuance budget (Codex on #1513).
func TestRecoveryAssist_AdmissionRefusalChargesNoIssuance(t *testing.T) {
	ctx := context.Background()
	svc, owner, user, _ := newAssistFixture(t, false)
	svc.limiter.SetAdmissionBudget(1)
	release, admitted := svc.limiter.Admission().TryAcquire()
	if !admitted {
		t.Fatal("could not hold the only slot")
	}
	for i := range recoveryAssistTargetLimit + 2 {
		if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); err != ErrAuthBusy { //nolint:errorlint // the sentinel itself, not its kind
			t.Fatalf("attempt %d under load = %v, want ErrAuthBusy", i+1, err)
		}
	}
	release()
	// The account's whole budget is still there.
	for i := range recoveryAssistTargetLimit {
		if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); err != nil {
			t.Fatalf("issuance %d after the busy period = %v, want success", i+1, err)
		}
	}
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, user.ID, "in_person"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("over the per-target budget = %v, want rate limited", err)
	}
}
