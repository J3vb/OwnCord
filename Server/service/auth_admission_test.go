package service

// B4-4 (SEC-01): every deliberately expensive authentication computation —
// the bcrypt compare behind a password confirmation, the hash behind a
// registration, the ten-hash recovery-code issue and the up-to-ten-compare
// recovery-code match — takes the one admission slot the shared limiter
// owns. A refusal runs no bcrypt and charges no lockout attempt, and the
// budget bounds how many computations are ever in flight at once.

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

const admissionPassword = "correct horse battery"

type admissionFixture struct {
	svc      *AuthService
	limiter  *auth.RateLimiter
	database *db.DB
	// plain has no second factor, so every password-confirming route reaches
	// its compare; totp has one, so the verify step reaches the recovery-code
	// match through partial, an open login challenge.
	plain   Principal
	totpUID int64
	partial string
}

func newAdmissionFixture(t *testing.T, budget int) *admissionFixture {
	t.Helper()
	ctx := context.Background()
	database := newTestDB(t)
	hash, err := auth.HashPassword(admissionPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	plainID, err := database.CreateUser(ctx, "budgeted", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	totpID, err := database.CreateUser(ctx, "budgeted-2fa", hash, 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}
	key := make([]byte, 32)
	enc, err := auth.EncryptTOTPSecret(key, secret)
	if err != nil {
		t.Fatalf("EncryptTOTPSecret: %v", err)
	}
	if err := database.UpdateUserTOTPSecret(ctx, totpID, &enc); err != nil {
		t.Fatalf("UpdateUserTOTPSecret: %v", err)
	}

	limiter := auth.NewRateLimiter()
	limiter.SetAdmissionBudget(budget)
	svc := NewAuthService(database, limiter, key, nil)
	partial, err := svc.partial.Issue(ctx, totpID, "device", "203.0.113.9")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	plain, err := database.GetUserByID(ctx, plainID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	return &admissionFixture{
		svc: svc, limiter: limiter, database: database,
		plain: Principal{User: plain}, totpUID: totpID, partial: partial,
	}
}

// hold takes the budget's only slot for the rest of the test, or until the
// returned release is called.
func (f *admissionFixture) hold(t *testing.T) func() {
	t.Helper()
	release, ok := f.limiter.Admission().TryAcquire()
	if !ok {
		t.Fatal("could not take the budget's only slot")
	}
	t.Cleanup(release)
	return release
}

type admissionSite struct {
	name string
	call func(ctx context.Context) error
}

// sites is every service path that pays for bcrypt, each called with input
// that would otherwise reach the expensive step.
func (f *admissionFixture) sites() []admissionSite {
	const ip = "203.0.113.7"
	s, p := f.svc, f.plain
	return []admissionSite{
		{"Login", func(ctx context.Context) error {
			_, err := s.Login(ctx, LoginInput{Username: "budgeted", Password: admissionPassword, IP: ip})
			return err
		}},
		{"Register", func(ctx context.Context) error {
			_, err := s.Register(ctx, RegisterInput{Username: "newcomer", Password: "another horse", InviteCode: "unused", IP: ip})
			return err
		}},
		{"DeleteAccount", func(ctx context.Context) error { return s.DeleteAccount(ctx, p, admissionPassword, ip) }},
		{"EnableTOTP", func(ctx context.Context) error { _, err := s.EnableTOTP(ctx, p, admissionPassword); return err }},
		{"ConfirmTOTP", func(ctx context.Context) error {
			_, err := s.ConfirmTOTP(ctx, p, admissionPassword, "000000")
			return err
		}},
		{"DisableTOTP", func(ctx context.Context) error { _, err := s.DisableTOTP(ctx, p, admissionPassword); return err }},
		{"RegenerateRecoveryCodes", func(ctx context.Context) error {
			_, err := s.RegenerateRecoveryCodes(ctx, p, admissionPassword)
			return err
		}},
		{"VerifyTOTP with a recovery code", func(ctx context.Context) error {
			_, err := s.VerifyTOTP(ctx, f.partial, "ABCDE-FGHJK")
			return err
		}},
	}
}

func TestExpensiveAuth_RefusedWhenBudgetExhausted(t *testing.T) {
	ctx := context.Background()
	f := newAdmissionFixture(t, 1)
	f.hold(t)

	for _, site := range f.sites() {
		err := site.call(ctx)
		if !errors.Is(err, ErrAuthBusy) {
			t.Errorf("%s with an exhausted budget: error = %v, want ErrAuthBusy", site.name, err)
		}
		if !errors.Is(err, ErrRateLimited) {
			t.Errorf("%s: ErrAuthBusy must carry the rate-limit category (429), got %v", site.name, err)
		}
	}
	if peak := f.limiter.Admission().Peak(); peak != 1 {
		t.Fatalf("peak = %d, want 1: a refused site must not have been admitted", peak)
	}
	if u, err := f.database.GetUserByID(ctx, f.plain.User.ID); err != nil || u == nil || u.Username != "budgeted" {
		t.Fatalf("the refused DeleteAccount touched the account: user = %+v, err = %v", u, err)
	}
}

func TestExpensiveAuth_BusyRefusalsChargeNoAttempt(t *testing.T) {
	ctx := context.Background()
	f := newAdmissionFixture(t, 1)
	release := f.hold(t)
	const ip = "203.0.113.20"
	uid := f.plain.User.ID

	// Enough refusals to exhaust every budget they might have been charged
	// to: the login caps are 10 per IP and per username, the deletion and
	// password-confirmation caps 3 per user.
	for i := range 10 {
		if _, err := f.svc.Login(ctx, LoginInput{Username: "budgeted", Password: admissionPassword, IP: ip}); !errors.Is(err, ErrAuthBusy) {
			t.Fatalf("login %d: error = %v, want ErrAuthBusy", i, err)
		}
	}
	for i := range 3 {
		if err := f.svc.DeleteAccount(ctx, f.plain, admissionPassword, ip); !errors.Is(err, ErrAuthBusy) {
			t.Fatalf("delete %d: error = %v, want ErrAuthBusy", i, err)
		}
		if _, err := f.svc.ConfirmTOTP(ctx, f.plain, admissionPassword, "000000"); !errors.Is(err, ErrAuthBusy) {
			t.Fatalf("confirm %d: error = %v, want ErrAuthBusy", i, err)
		}
	}
	release()

	// Had the refusals counted, the per-username login cap would be spent
	// and this correct password would answer ErrLockedOut.
	if _, err := f.svc.Login(ctx, LoginInput{Username: "budgeted", Password: admissionPassword, IP: ip}); err != nil {
		t.Fatalf("login after the refusals: error = %v, want success", err)
	}
	// Three real failures reach the threshold exactly; a fourth counted
	// attempt (any refusal above) would already have tripped the lockout.
	for i := range 3 {
		if err := f.svc.DeleteAccount(ctx, f.plain, "wrong", ip); !errors.Is(err, ErrIncorrectPassword) {
			t.Fatalf("wrong-password delete %d: error = %v, want ErrIncorrectPassword", i, err)
		}
	}
	if f.limiter.IsLockedOut(auth.Key("delete_lock", uid)) {
		t.Fatal("delete-account lockout tripped after three real failures: the refusals were counted")
	}
	for i := range 3 {
		if _, err := f.svc.ConfirmTOTP(ctx, f.plain, "wrong", "000000"); !errors.Is(err, ErrPasswordConfirmationFailed) {
			t.Fatalf("wrong-password confirm %d: error = %v, want ErrPasswordConfirmationFailed", i, err)
		}
	}
	if f.limiter.IsLockedOut(auth.Key("pw_confirm_lock", uid)) {
		t.Fatal("password-confirmation lockout tripped after three real failures: the refusals were counted")
	}
}

func TestExpensiveAuth_ConcurrentAttemptsAdmitAtMostTheBudget(t *testing.T) {
	const budget, attempts = 2, 24
	ctx := context.Background()
	f := newAdmissionFixture(t, budget)

	// Unknown usernames still pay for the dummy compare (the enumeration
	// guard), and distinct names and addresses keep every lockout key apart,
	// so the only thing that can refuse an attempt is the budget.
	errs := make([]error, attempts)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, errs[i] = f.svc.Login(ctx, LoginInput{
				Username: fmt.Sprintf("ghost-%d", i),
				Password: "nope",
				IP:       fmt.Sprintf("203.0.113.%d", 30+i),
			})
		}()
	}
	close(start)
	wg.Wait()

	admitted := 0
	for i, err := range errs {
		switch {
		case errors.Is(err, ErrInvalidCredentials):
			admitted++
		case errors.Is(err, ErrAuthBusy):
		default:
			t.Errorf("attempt %d: error = %v, want ErrInvalidCredentials (admitted) or ErrAuthBusy (refused)", i, err)
		}
	}
	if admitted == 0 {
		t.Fatal("no attempt was admitted")
	}
	b := f.limiter.Admission()
	if b.Peak() > budget {
		t.Fatalf("peak in-flight = %d, want at most the budget %d", b.Peak(), budget)
	}
	if b.InFlight() != 0 {
		t.Fatalf("in flight after every attempt returned = %d, want 0", b.InFlight())
	}
}
