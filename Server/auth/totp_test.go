package auth_test

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestGenerateTOTPCodeAndVerify_RFCVector(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	code, err := auth.GenerateTOTPCode(secret, time.Unix(59, 0).UTC())
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}
	if code != "287082" {
		t.Fatalf("code = %q, want 287082", code)
	}
	if !auth.VerifyTOTPCode(secret, code, time.Unix(59, 0).UTC()) {
		t.Fatal("VerifyTOTPCode should accept the RFC vector code")
	}
	if auth.VerifyTOTPCode(secret, "000000", time.Unix(59, 0).UTC()) {
		t.Fatal("VerifyTOTPCode should reject an invalid code")
	}
}

func TestVerifyTOTPCode_ClockSkewTolerance(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	now := time.Now().UTC()
	code, err := auth.GenerateTOTPCode(secret, now)
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}

	// Code should verify at current time.
	if !auth.VerifyTOTPCode(secret, code, now) {
		t.Error("VerifyTOTPCode should accept code at generation time")
	}

	// Code should also verify one period (30s) earlier (skew tolerance).
	if !auth.VerifyTOTPCode(secret, code, now.Add(-30*time.Second)) {
		t.Error("VerifyTOTPCode should accept code one period earlier (clock skew)")
	}

	// Code should verify one period later.
	if !auth.VerifyTOTPCode(secret, code, now.Add(30*time.Second)) {
		t.Error("VerifyTOTPCode should accept code one period later (clock skew)")
	}
}

func TestVerifyTOTPCode_RejectsBadLength(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	// Too short.
	if auth.VerifyTOTPCode(secret, "12345", time.Now()) {
		t.Error("VerifyTOTPCode should reject 5-digit code")
	}
	// Too long.
	if auth.VerifyTOTPCode(secret, "1234567", time.Now()) {
		t.Error("VerifyTOTPCode should reject 7-digit code")
	}
	// Empty.
	if auth.VerifyTOTPCode(secret, "", time.Now()) {
		t.Error("VerifyTOTPCode should reject empty code")
	}
}

func TestGenerateTOTPCode_InvalidSecret(t *testing.T) {
	_, err := auth.GenerateTOTPCode("not-valid-base32!!!", time.Now())
	if err == nil {
		t.Error("GenerateTOTPCode should error for invalid base32 secret")
	}
}

// ─── GenerateTOTPSecret ─────────────────────────────────────────────────────

func TestGenerateTOTPSecret_ReturnsValidBase32(t *testing.T) {
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret() error: %v", err)
	}
	if secret == "" {
		t.Fatal("GenerateTOTPSecret() returned empty string")
	}

	// Should be valid base32 (usable with GenerateTOTPCode).
	_, err = auth.GenerateTOTPCode(secret, time.Now())
	if err != nil {
		t.Errorf("generated secret is not valid base32 for TOTP: %v", err)
	}
}

func TestGenerateTOTPSecret_Unique(t *testing.T) {
	s1, _ := auth.GenerateTOTPSecret()
	s2, _ := auth.GenerateTOTPSecret()
	if s1 == s2 {
		t.Error("GenerateTOTPSecret() produced duplicate secrets")
	}
}

// ─── PartialAuthStore (memory-only; the persisted shape is in
// second_factor_persist_test.go) ──────────────────────────────────────────────

func TestPartialAuthStore_IssueAndLookup(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPartialAuthStore(time.Minute)
	token, err := store.Issue(ctx, 42, "desktop", "192.168.1.1")
	if err != nil {
		t.Fatalf("Issue() error: %v", err)
	}
	if token == "" {
		t.Fatal("Issue() returned empty token")
	}

	challenge, ok := store.Lookup(ctx, token)
	if !ok {
		t.Fatal("Lookup() ok = false for valid token")
	}
	if challenge.UserID != 42 {
		t.Errorf("UserID = %d, want 42", challenge.UserID)
	}
	if challenge.Device != "desktop" {
		t.Errorf("Device = %q, want 'desktop'", challenge.Device)
	}
	if challenge.IP != "192.168.1.1" {
		t.Errorf("IP = %q, want '192.168.1.1'", challenge.IP)
	}
}

func TestPartialAuthStore_Consume(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPartialAuthStore(time.Minute)
	token, _ := store.Issue(ctx, 1, "mobile", "10.0.0.1")

	// Consume should return the challenge and remove it.
	challenge, ok := store.Consume(ctx, token)
	if !ok {
		t.Fatal("Consume() ok = false for valid token")
	}
	if challenge.UserID != 1 {
		t.Errorf("UserID = %d, want 1", challenge.UserID)
	}

	// Second consume should fail.
	_, ok = store.Consume(ctx, token)
	if ok {
		t.Error("Consume() ok = true for already consumed token")
	}
}

func TestPartialAuthStore_ConsumeInvalidToken(t *testing.T) {
	store := auth.NewPartialAuthStore(time.Minute)
	_, ok := store.Consume(context.Background(), "nonexistent")
	if ok {
		t.Error("Consume() ok = true for nonexistent token")
	}
}

func TestPartialAuthStore_LookupInvalidToken(t *testing.T) {
	store := auth.NewPartialAuthStore(time.Minute)
	_, ok := store.Lookup(context.Background(), "nonexistent")
	if ok {
		t.Error("Lookup() ok = true for nonexistent token")
	}
}

func TestPartialAuthStore_RegisterFailure(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPartialAuthStore(time.Minute)
	token, _ := store.Issue(ctx, 1, "mobile", "10.0.0.1")

	// First failure — should still be alive (maxFailures=3).
	if !store.RegisterFailure(ctx, token, 3) {
		t.Error("RegisterFailure() = false on first failure, want true")
	}

	// Second failure.
	if !store.RegisterFailure(ctx, token, 3) {
		t.Error("RegisterFailure() = false on second failure, want true")
	}

	// Third failure — reaches maxFailures, token should be deleted.
	if store.RegisterFailure(ctx, token, 3) {
		t.Error("RegisterFailure() = true on third failure (at max), want false")
	}

	// Token should be gone.
	_, ok := store.Lookup(ctx, token)
	if ok {
		t.Error("token should be deleted after max failures")
	}
}

func TestPartialAuthStore_RegisterFailureUnknownToken(t *testing.T) {
	store := auth.NewPartialAuthStore(time.Minute)
	if store.RegisterFailure(context.Background(), "nonexistent", 3) {
		t.Error("RegisterFailure() = true for nonexistent token, want false")
	}
}

func TestPartialAuthStore_ExpiryCleanup(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPartialAuthStore(50 * time.Millisecond)
	token, _ := store.Issue(ctx, 1, "dev", "1.2.3.4")

	time.Sleep(80 * time.Millisecond)

	// Lookup triggers cleanup — expired token should be gone.
	_, ok := store.Lookup(ctx, token)
	if ok {
		t.Error("Lookup() ok = true for expired token, want false")
	}
}

// ─── PendingTOTPStore ───────────────────────────────────────────────────────

func TestPendingTOTPStore_PutAndLookup(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPendingTOTPStore(time.Minute)
	if err := store.Put(ctx, 42, "MYSECRET"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	secret, ok := store.Lookup(ctx, 42)
	if !ok {
		t.Fatal("Lookup() ok = false for valid userID")
	}
	if secret != "MYSECRET" {
		t.Errorf("secret = %q, want 'MYSECRET'", secret)
	}
}

func TestPendingTOTPStore_LookupMissing(t *testing.T) {
	store := auth.NewPendingTOTPStore(time.Minute)
	_, ok := store.Lookup(context.Background(), 999)
	if ok {
		t.Error("Lookup() ok = true for missing userID, want false")
	}
}

func TestPendingTOTPStore_Delete(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPendingTOTPStore(time.Minute)
	if err := store.Put(ctx, 42, "SECRET"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	store.Delete(ctx, 42)

	_, ok := store.Lookup(ctx, 42)
	if ok {
		t.Error("Lookup() ok = true after Delete(), want false")
	}
}

func TestPendingTOTPStore_Overwrite(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPendingTOTPStore(time.Minute)
	if err := store.Put(ctx, 42, "OLD"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.Put(ctx, 42, "NEW"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	secret, ok := store.Lookup(ctx, 42)
	if !ok {
		t.Fatal("Lookup() ok = false")
	}
	if secret != "NEW" {
		t.Errorf("secret = %q, want 'NEW' after overwrite", secret)
	}
}

func TestPendingTOTPStore_ExpiryCleanup(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPendingTOTPStore(50 * time.Millisecond)
	if err := store.Put(ctx, 42, "EPHEMERAL"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	time.Sleep(80 * time.Millisecond)

	_, ok := store.Lookup(ctx, 42)
	if ok {
		t.Error("Lookup() ok = true for expired entry, want false")
	}
}

// ─── UsedTOTPCodeStore ──────────────────────────────────────────────────────

func TestUsedTOTPCodeStore_MarkUsed(t *testing.T) {
	ctx := context.Background()
	store := auth.NewUsedTOTPCodeStore()

	// First use should succeed.
	if !store.MarkUsed(ctx, 1, "123456") {
		t.Error("MarkUsed() = false on first use, want true")
	}

	// Replay should be rejected.
	if store.MarkUsed(ctx, 1, "123456") {
		t.Error("MarkUsed() = true on replay, want false")
	}
}

func TestUsedTOTPCodeStore_DifferentUsersSameCode(t *testing.T) {
	ctx := context.Background()
	store := auth.NewUsedTOTPCodeStore()
	if !store.MarkUsed(ctx, 1, "111111") {
		t.Error("MarkUsed(user1) = false, want true")
	}
	// Same code but different user should succeed.
	if !store.MarkUsed(ctx, 2, "111111") {
		t.Error("MarkUsed(user2) = false for same code different user, want true")
	}
}

func TestUsedTOTPCodeStore_DifferentCodes(t *testing.T) {
	ctx := context.Background()
	store := auth.NewUsedTOTPCodeStore()
	if !store.MarkUsed(ctx, 1, "111111") {
		t.Error("MarkUsed(code1) = false, want true")
	}
	if !store.MarkUsed(ctx, 1, "222222") {
		t.Error("MarkUsed(code2) = false for different code same user, want true")
	}
}

// ─── VerifyTOTPCodeOnce ─────────────────────────────────────────────────────

func TestVerifyTOTPCodeOnce_ValidCodeAccepted(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	now := time.Now().UTC()
	code, err := auth.GenerateTOTPCode(secret, now)
	if err != nil {
		t.Fatalf("GenerateTOTPCode: %v", err)
	}

	store := auth.NewUsedTOTPCodeStore()
	if !auth.VerifyTOTPCodeOnce(context.Background(), secret, code, now, 1, store) {
		t.Error("VerifyTOTPCodeOnce() = false for valid code, want true")
	}
}

func TestVerifyTOTPCodeOnce_ReplayRejected(t *testing.T) {
	ctx := context.Background()
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	now := time.Now().UTC()
	code, _ := auth.GenerateTOTPCode(secret, now)

	store := auth.NewUsedTOTPCodeStore()
	auth.VerifyTOTPCodeOnce(ctx, secret, code, now, 1, store)

	// Second verification of the same code should be rejected.
	if auth.VerifyTOTPCodeOnce(ctx, secret, code, now, 1, store) {
		t.Error("VerifyTOTPCodeOnce() = true for replayed code, want false")
	}
}

func TestVerifyTOTPCodeOnce_InvalidCodeRejected(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	store := auth.NewUsedTOTPCodeStore()

	if auth.VerifyTOTPCodeOnce(context.Background(), secret, "000000", time.Unix(59, 0), 1, store) {
		t.Error("VerifyTOTPCodeOnce() = true for invalid code, want false")
	}
}

func TestVerifyTOTPCodeOnce_NilStoreAccepted(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	now := time.Now().UTC()
	code, _ := auth.GenerateTOTPCode(secret, now)

	// With nil store, replay prevention is skipped — should still verify.
	if !auth.VerifyTOTPCodeOnce(context.Background(), secret, code, now, 1, nil) {
		t.Error("VerifyTOTPCodeOnce() = false with nil store, want true")
	}
}

func TestBuildTOTPURI_ContainsIssuerAndSecret(t *testing.T) {
	secret := "JBSWY3DPEHPK3PXP"
	uri := auth.BuildTOTPURI("alice", secret, "OwnCord")
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("url.Parse: %v", err)
	}
	if parsed.Scheme != "otpauth" {
		t.Fatalf("scheme = %q, want otpauth", parsed.Scheme)
	}
	if !strings.Contains(parsed.Path, "OwnCord:alice") {
		t.Fatalf("path = %q, want issuer and username label", parsed.Path)
	}
	query := parsed.Query()
	if query.Get("secret") != secret {
		t.Fatalf("secret = %q, want %q", query.Get("secret"), secret)
	}
	if query.Get("issuer") != "OwnCord" {
		t.Fatalf("issuer = %q, want OwnCord", query.Get("issuer"))
	}
}

// ─── OC-0378: Restore / Unmark ──────────────────────────────────────────────

func TestPartialAuthStore_RestoreAfterConsume(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPartialAuthStore(time.Minute)
	token, err := store.Issue(ctx, 7, "device", "203.0.113.7")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store.RegisterFailure(ctx, token, 5) // Failures=1 must survive the round trip

	claimed, ok := store.Consume(ctx, token)
	if !ok {
		t.Fatal("Consume: challenge not found")
	}
	if _, ok := store.Lookup(ctx, token); ok {
		t.Fatal("consumed token still resolves")
	}

	store.Restore(ctx, token, claimed)
	got, ok := store.Lookup(ctx, token)
	if !ok {
		t.Fatal("restored token does not resolve")
	}
	if got != claimed {
		t.Fatalf("restored challenge = %+v, want %+v", got, claimed)
	}
	if got.Failures != 1 {
		t.Fatalf("Failures = %d, want 1 (restore keeps the count)", got.Failures)
	}
}

func TestPartialAuthStore_RestoreExpiredStaysGone(t *testing.T) {
	ctx := context.Background()
	store := auth.NewPartialAuthStore(20 * time.Millisecond)
	token, err := store.Issue(ctx, 7, "device", "203.0.113.7")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	claimed, ok := store.Consume(ctx, token)
	if !ok {
		t.Fatal("Consume: challenge not found")
	}
	time.Sleep(40 * time.Millisecond)

	store.Restore(ctx, token, claimed)
	if _, ok := store.Lookup(ctx, token); ok {
		t.Fatal("an expired challenge came back to life")
	}
}

func TestUsedTOTPCodeStore_UnmarkAllowsReuse(t *testing.T) {
	ctx := context.Background()
	store := auth.NewUsedTOTPCodeStore()
	if !store.MarkUsed(ctx, 1, "123456") {
		t.Fatal("first MarkUsed refused")
	}
	if store.MarkUsed(ctx, 1, "123456") {
		t.Fatal("replay accepted before Unmark")
	}
	if !store.MarkUsed(ctx, 2, "123456") {
		t.Fatal("another user's identical code refused")
	}

	store.Unmark(ctx, 1, "123456")
	if !store.MarkUsed(ctx, 1, "123456") {
		t.Fatal("code still marked after Unmark")
	}
	if store.MarkUsed(ctx, 2, "123456") {
		t.Fatal("Unmark for user 1 released user 2's code")
	}
}
