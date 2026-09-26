package db_test

import (
	"context"
	"testing"
)

// TestTakeInventory_LockoutClassMatchesExactSuffixNotLIKE is OC-0432: class 6
// ("6 rate-limit keys") must use the same exact-suffix predicate as
// erasureDeleteLockouts, not a LIKE pattern built from the raw username. A
// username containing a LIKE metacharacter (auth.ValidateUsername permits `_`
// and `%`) must not widen the match onto an unrelated account's lockout key.
func TestTakeInventory_LockoutClassMatchesExactSuffixNotLIKE(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	// "axb" holds a login lockout. "a_b" is a different account whose
	// username, read as a LIKE pattern, has "_" match the "x" in "axb".
	otherUID := seedUser(t, database, "axb")
	subjectUID := seedUser(t, database, "a_b")
	_ = otherUID
	if _, err := database.ExecContext(ctx,
		`INSERT INTO rate_lockouts (key, expires_at) VALUES ('login_user_lock:axb', datetime('now', '+15 minutes'))`); err != nil {
		t.Fatalf("seed lockout: %v", err)
	}

	out, err := database.TakeInventory(ctx, subjectUID, "a_b")
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	if got := out["6 rate-limit keys"]; got != 0 {
		t.Errorf(`TakeInventory("a_b") class 6 = %d, want 0 (login_user_lock:axb belongs to a different account and must not match)`, got)
	}
}
