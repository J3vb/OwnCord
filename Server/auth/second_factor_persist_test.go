package auth_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// S-13 (B4-3): with a persister the three second-factor stores survive a
// restart, keep secrets out of the database, and fail closed when the
// persister fails. A "restart" here is a second store over the same
// database: the first store's map is what a dead process loses.

func persistedDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	// Every row references users(id): mint the accounts the tests use.
	for _, name := range []string{"alice", "bob"} {
		if _, err := database.CreateUser(context.Background(), name, "x", 4); err != nil {
			t.Fatalf("create user %s: %v", name, err)
		}
	}
	return database
}

func testAESKey() []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	return key
}

func TestPartialAuthStore_SurvivesRestart(t *testing.T) {
	ctx := context.Background()
	database := persistedDB(t)

	before := auth.NewPartialAuthStore(time.Minute).WithPersister(database)
	token, err := before.Issue(ctx, 1, "desktop", "203.0.113.9")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if !before.RegisterFailure(ctx, token, 5) {
		t.Fatal("RegisterFailure killed the challenge on the first failure")
	}

	// The row must carry the digest, never the token.
	var stored string
	if err := database.QueryRowContext(ctx, `SELECT token_hash FROM partial_auth_challenges`).Scan(&stored); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if stored == token || stored != auth.HashToken(token) {
		t.Fatalf("stored token_hash = %q, want the SHA-256 digest of the token and never the token", stored)
	}

	after := auth.NewPartialAuthStore(time.Minute).WithPersister(database)
	got, ok := after.Lookup(ctx, token)
	if !ok {
		t.Fatal("the challenge did not survive the restart")
	}
	if got.UserID != 1 || got.Device != "desktop" || got.IP != "203.0.113.9" || got.Failures != 1 {
		t.Fatalf("restored challenge = %+v, want user 1 / desktop / 203.0.113.9 / 1 failure", got)
	}

	// The database decides the single winner: the new process consumes it,
	// and the old process's cached copy is worthless afterwards.
	if _, ok := after.Consume(ctx, token); !ok {
		t.Fatal("Consume after restart failed")
	}
	if _, ok := before.Consume(ctx, token); ok {
		t.Fatal("a stale cache consumed a challenge the database had already spent")
	}
	if _, ok := after.Lookup(ctx, token); ok {
		t.Fatal("a consumed challenge still resolves")
	}
}

func TestPartialAuthStore_RestoreAndExhaustionPersist(t *testing.T) {
	ctx := context.Background()
	database := persistedDB(t)

	store := auth.NewPartialAuthStore(time.Minute).WithPersister(database)
	token, err := store.Issue(ctx, 1, "d", "ip")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	claimed, ok := store.Consume(ctx, token)
	if !ok {
		t.Fatal("Consume failed")
	}
	store.Restore(ctx, token, claimed)

	restarted := auth.NewPartialAuthStore(time.Minute).WithPersister(database)
	if _, ok := restarted.Lookup(ctx, token); !ok {
		t.Fatal("a restored challenge did not survive the restart")
	}
	for range 4 {
		restarted.RegisterFailure(ctx, token, 5)
	}
	if restarted.RegisterFailure(ctx, token, 5) {
		t.Fatal("the fifth failure should exhaust the challenge")
	}
	again := auth.NewPartialAuthStore(time.Minute).WithPersister(database)
	if _, ok := again.Lookup(ctx, token); ok {
		t.Fatal("an exhausted challenge came back after a restart")
	}
}

func TestPendingTOTPStore_SurvivesRestartSealed(t *testing.T) {
	ctx := context.Background()
	database := persistedDB(t)
	key := testAESKey()
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

	before := auth.NewPendingTOTPStore(time.Minute).WithPersister(database, key)
	if err := before.Put(ctx, 1, secret); err != nil {
		t.Fatalf("Put: %v", err)
	}

	var sealed string
	if err := database.QueryRowContext(ctx, `SELECT secret_enc FROM pending_totp_enrollments WHERE user_id = 1`).Scan(&sealed); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if sealed == secret {
		t.Fatal("the pending enrolment secret was persisted in the clear")
	}

	after := auth.NewPendingTOTPStore(time.Minute).WithPersister(database, key)
	got, ok := after.Lookup(ctx, 1)
	if !ok || got != secret {
		t.Fatalf("Lookup after restart = %q, %v; want the staged secret", got, ok)
	}

	after.Delete(ctx, 1)
	third := auth.NewPendingTOTPStore(time.Minute).WithPersister(database, key)
	if _, ok := third.Lookup(ctx, 1); ok {
		t.Fatal("a deleted enrolment came back after a restart")
	}
}

func TestUsedTOTPCodeStore_ReplayRejectedAcrossRestart(t *testing.T) {
	ctx := context.Background()
	database := persistedDB(t)

	before := auth.NewUsedTOTPCodeStore().WithPersister(database)
	if !before.MarkUsed(ctx, 1, "123456") {
		t.Fatal("first use refused")
	}
	var stored string
	if err := database.QueryRowContext(ctx, `SELECT code_hash FROM totp_used_codes WHERE user_id = 1`).Scan(&stored); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if stored == "123456" || stored == "1:123456" {
		t.Fatalf("the used code was persisted in the clear: %q", stored)
	}

	after := auth.NewUsedTOTPCodeStore().WithPersister(database)
	if after.MarkUsed(ctx, 1, "123456") {
		t.Fatal("a code spent before the restart was accepted again")
	}
	if !after.MarkUsed(ctx, 2, "123456") {
		t.Fatal("another user's identical code refused")
	}
	after.Unmark(ctx, 1, "123456")
	if !before.MarkUsed(ctx, 1, "123456") {
		t.Fatal("Unmark in one process did not release the code for another")
	}
}

func TestCleanupExpiredSecondFactorState(t *testing.T) {
	ctx := context.Background()
	database := persistedDB(t)
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)

	if err := database.UpsertPartialAuth(ctx, "old-challenge", 1, "", "", 0, past); err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPartialAuth(ctx, "live-challenge", 1, "", "", 0, future); err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPendingTOTP(ctx, 1, "sealed", past); err != nil {
		t.Fatal(err)
	}
	if _, err := database.InsertUsedTOTPCode(ctx, 1, "old-code", past); err != nil {
		t.Fatal(err)
	}
	if _, err := database.InsertUsedTOTPCode(ctx, 1, "live-code", future); err != nil {
		t.Fatal(err)
	}

	if err := database.CleanupExpiredSecondFactorState(ctx); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	count := func(q string) int {
		var n int
		if err := database.QueryRowContext(ctx, q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	if got := count(`SELECT COUNT(*) FROM partial_auth_challenges`); got != 1 {
		t.Fatalf("partial challenges after cleanup = %d, want 1 (the live one)", got)
	}
	if got := count(`SELECT COUNT(*) FROM pending_totp_enrollments`); got != 0 {
		t.Fatalf("pending enrolments after cleanup = %d, want 0", got)
	}
	if got := count(`SELECT COUNT(*) FROM totp_used_codes`); got != 1 {
		t.Fatalf("used codes after cleanup = %d, want 1 (the live one)", got)
	}
}

// failingPersister answers every call with an error: the outage case.
type failingPersister struct{}

var errPersister = errors.New("persister down")

func (failingPersister) UpsertPartialAuth(context.Context, string, int64, string, string, int, time.Time) error {
	return errPersister
}
func (failingPersister) GetPartialAuth(context.Context, string) (int64, string, string, int, time.Time, bool, error) {
	return 0, "", "", 0, time.Time{}, false, errPersister
}
func (failingPersister) DeletePartialAuth(context.Context, string) (bool, error) {
	return false, errPersister
}
func (failingPersister) UpsertPendingTOTP(context.Context, int64, string, time.Time) error {
	return errPersister
}
func (failingPersister) GetPendingTOTP(context.Context, int64) (string, time.Time, bool, error) {
	return "", time.Time{}, false, errPersister
}
func (failingPersister) DeletePendingTOTP(context.Context, int64) error { return errPersister }
func (failingPersister) InsertUsedTOTPCode(context.Context, int64, string, time.Time) (bool, error) {
	return false, errPersister
}
func (failingPersister) DeleteUsedTOTPCode(context.Context, int64, string) error { return errPersister }

// A store that cannot persist refuses rather than pretends: no challenge is
// issued, no enrolment staged, and a code whose single use cannot be
// recorded is rejected.
func TestSecondFactorStores_FailClosedWhenPersisterFails(t *testing.T) {
	ctx := context.Background()
	var p failingPersister

	partial := auth.NewPartialAuthStore(time.Minute).WithPersister(p)
	if token, err := partial.Issue(ctx, 1, "d", "ip"); err == nil {
		t.Fatalf("Issue returned a token (%q) it could not persist", token)
	}
	if _, ok := partial.Lookup(ctx, "anything"); ok {
		t.Fatal("Lookup resolved a challenge through a failing persister")
	}

	pending := auth.NewPendingTOTPStore(time.Minute).WithPersister(p, testAESKey())
	if err := pending.Put(ctx, 1, "SECRET"); err == nil {
		t.Fatal("Put staged an enrolment it could not persist")
	}
	if _, ok := pending.Lookup(ctx, 1); ok {
		t.Fatal("Lookup resolved an enrolment through a failing persister")
	}

	used := auth.NewUsedTOTPCodeStore().WithPersister(p)
	if used.MarkUsed(ctx, 1, "123456") {
		t.Fatal("MarkUsed accepted a code whose use could not be recorded")
	}
}

// ─── Recovery codes ─────────────────────────────────────────────────────────

func TestRecoveryCodes_GenerateNormalizeMatch(t *testing.T) {
	codes, hashes, err := auth.GenerateRecoveryCodes()
	if err != nil {
		t.Fatalf("GenerateRecoveryCodes: %v", err)
	}
	if len(codes) != 10 || len(hashes) != 10 {
		t.Fatalf("got %d codes / %d hashes, want 10 / 10", len(codes), len(hashes))
	}
	seen := map[string]bool{}
	for i, code := range codes {
		if len(code) != 11 || code[5] != '-' {
			t.Fatalf("code %q is not shaped XXXXX-XXXXX", code)
		}
		if seen[code] {
			t.Fatalf("duplicate code %q in one set", code)
		}
		seen[code] = true
		if hashes[i] == code {
			t.Fatal("a hash equals its code")
		}
		canonical, ok := auth.NormalizeRecoveryCode(" " + code + " ")
		if !ok {
			t.Fatalf("NormalizeRecoveryCode(%q) rejected a generated code", code)
		}
		if got := auth.MatchRecoveryCode(canonical, hashes); got != i {
			t.Fatalf("MatchRecoveryCode(%q) = %d, want %d", code, got, i)
		}
		// Lower case and a missing separator are the same code.
		lower, ok := auth.NormalizeRecoveryCode(strings.ToLower(strings.ReplaceAll(code, "-", "")))
		if !ok || lower != canonical {
			t.Fatalf("NormalizeRecoveryCode of the lower-case, unseparated form = %q, %v; want %q", lower, ok, canonical)
		}
	}
	if got := auth.MatchRecoveryCode("AAAAAAAAAA", hashes); got != -1 {
		t.Fatalf("MatchRecoveryCode matched a code that was never issued: %d", got)
	}
}

func TestNormalizeRecoveryCode_RejectsOtherShapes(t *testing.T) {
	for _, in := range []string{"123456", "", "ABCDE-FGHJ", "ABCDE-FGHJK-M", "ABCDE-FGH0K", "abcde-fghil"} {
		if canonical, ok := auth.NormalizeRecoveryCode(in); ok {
			t.Errorf("NormalizeRecoveryCode(%q) = %q, true; want a rejection", in, canonical)
		}
	}
}
