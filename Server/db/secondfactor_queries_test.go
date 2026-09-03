package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The db half of S-13 / BPR-046 (B4-3): the persister methods behind the
// auth service's second-factor stores and the recovery-code rows, exercised
// directly so the package's own coverage carries them.

func secondFactorTestDB(t *testing.T) (*db.DB, int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	uid, err := database.CreateUser(context.Background(), "second-factor", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return database, uid
}

func TestPartialAuthPersistence_RoundTrip(t *testing.T) {
	ctx := context.Background()
	database, uid := secondFactorTestDB(t)
	exp := time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second)

	if _, _, _, _, _, found, err := database.GetPartialAuth(ctx, "missing"); err != nil || found {
		t.Fatalf("GetPartialAuth(missing) = found %v, err %v; want not found, nil", found, err)
	}
	if err := database.UpsertPartialAuth(ctx, "h1", uid, "desktop", "203.0.113.4", 0, exp); err != nil {
		t.Fatalf("UpsertPartialAuth: %v", err)
	}
	userID, device, ip, failures, expiresAt, found, err := database.GetPartialAuth(ctx, "h1")
	if err != nil || !found {
		t.Fatalf("GetPartialAuth: found %v, err %v", found, err)
	}
	if userID != uid || device != "desktop" || ip != "203.0.113.4" || failures != 0 || !expiresAt.Equal(exp) {
		t.Fatalf("row = %d/%s/%s/%d/%v, want %d/desktop/203.0.113.4/0/%v", userID, device, ip, failures, expiresAt, uid, exp)
	}

	// Upsert refreshes in place: the failure count moves, the key does not.
	if err := database.UpsertPartialAuth(ctx, "h1", uid, "desktop", "203.0.113.4", 3, exp); err != nil {
		t.Fatalf("UpsertPartialAuth (update): %v", err)
	}
	if _, _, _, failures, _, _, err := database.GetPartialAuth(ctx, "h1"); err != nil || failures != 3 {
		t.Fatalf("failures after update = %d, err %v; want 3", failures, err)
	}

	deleted, err := database.DeletePartialAuth(ctx, "h1")
	if err != nil || !deleted {
		t.Fatalf("DeletePartialAuth = %v, %v; want true, nil", deleted, err)
	}
	deleted, err = database.DeletePartialAuth(ctx, "h1")
	if err != nil || deleted {
		t.Fatalf("second DeletePartialAuth = %v, %v; want false, nil (single winner)", deleted, err)
	}
}

func TestPendingTOTPPersistence_RoundTrip(t *testing.T) {
	ctx := context.Background()
	database, uid := secondFactorTestDB(t)
	exp := time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second)

	if _, _, found, err := database.GetPendingTOTP(ctx, uid); err != nil || found {
		t.Fatalf("GetPendingTOTP(none) = found %v, err %v", found, err)
	}
	if err := database.UpsertPendingTOTP(ctx, uid, "sealed-1", exp); err != nil {
		t.Fatalf("UpsertPendingTOTP: %v", err)
	}
	if err := database.UpsertPendingTOTP(ctx, uid, "sealed-2", exp); err != nil {
		t.Fatalf("UpsertPendingTOTP (replace): %v", err)
	}
	sealed, expiresAt, found, err := database.GetPendingTOTP(ctx, uid)
	if err != nil || !found || sealed != "sealed-2" || !expiresAt.Equal(exp) {
		t.Fatalf("GetPendingTOTP = %q, %v, %v, %v; want sealed-2 at %v", sealed, expiresAt, found, err, exp)
	}
	if err := database.DeletePendingTOTP(ctx, uid); err != nil {
		t.Fatalf("DeletePendingTOTP: %v", err)
	}
	if _, _, found, err := database.GetPendingTOTP(ctx, uid); err != nil || found {
		t.Fatalf("GetPendingTOTP after delete = found %v, err %v", found, err)
	}
}

func TestUsedTOTPCodePersistence_FirstUseWins(t *testing.T) {
	ctx := context.Background()
	database, uid := secondFactorTestDB(t)
	exp := time.Now().Add(90 * time.Second)

	inserted, err := database.InsertUsedTOTPCode(ctx, uid, "digest", exp)
	if err != nil || !inserted {
		t.Fatalf("first InsertUsedTOTPCode = %v, %v; want true, nil", inserted, err)
	}
	inserted, err = database.InsertUsedTOTPCode(ctx, uid, "digest", exp)
	if err != nil || inserted {
		t.Fatalf("replay InsertUsedTOTPCode = %v, %v; want false, nil", inserted, err)
	}
	if err := database.DeleteUsedTOTPCode(ctx, uid, "digest"); err != nil {
		t.Fatalf("DeleteUsedTOTPCode: %v", err)
	}
	inserted, err = database.InsertUsedTOTPCode(ctx, uid, "digest", exp)
	if err != nil || !inserted {
		t.Fatalf("InsertUsedTOTPCode after release = %v, %v; want true, nil", inserted, err)
	}
}

func TestCleanupExpiredSecondFactorState_SweepsOnlyExpired(t *testing.T) {
	ctx := context.Background()
	database, uid := secondFactorTestDB(t)
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)

	for _, row := range []struct {
		hash string
		exp  time.Time
	}{{"old", past}, {"live", future}} {
		if err := database.UpsertPartialAuth(ctx, row.hash, uid, "", "", 0, row.exp); err != nil {
			t.Fatal(err)
		}
		if _, err := database.InsertUsedTOTPCode(ctx, uid, row.hash, row.exp); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.UpsertPendingTOTP(ctx, uid, "sealed", past); err != nil {
		t.Fatal(err)
	}
	if err := database.CleanupExpiredSecondFactorState(ctx); err != nil {
		t.Fatalf("CleanupExpiredSecondFactorState: %v", err)
	}
	if _, _, _, _, _, found, _ := database.GetPartialAuth(ctx, "old"); found {
		t.Fatal("an expired challenge survived the sweep")
	}
	if _, _, _, _, _, found, _ := database.GetPartialAuth(ctx, "live"); !found {
		t.Fatal("a live challenge was swept")
	}
	if _, _, found, _ := database.GetPendingTOTP(ctx, uid); found {
		t.Fatal("an expired enrolment survived the sweep")
	}
	if inserted, _ := database.InsertUsedTOTPCode(ctx, uid, "old", future); !inserted {
		t.Fatal("an expired used-code row survived the sweep")
	}
	if inserted, _ := database.InsertUsedTOTPCode(ctx, uid, "live", future); inserted {
		t.Fatal("a live used-code row was swept")
	}
}

func TestRecoveryCodes_ReplaceListMarkCountDelete(t *testing.T) {
	ctx := context.Background()
	database, uid := secondFactorTestDB(t)

	ids, hashes, err := database.ListUnusedRecoveryCodes(ctx, uid)
	if err != nil || len(ids) != 0 || len(hashes) != 0 {
		t.Fatalf("ListUnusedRecoveryCodes(empty) = %v, %v, %v", ids, hashes, err)
	}
	if err := database.ReplaceRecoveryCodes(ctx, uid, []string{"h-a", "h-b", "h-c"}); err != nil {
		t.Fatalf("ReplaceRecoveryCodes: %v", err)
	}
	ids, hashes, err = database.ListUnusedRecoveryCodes(ctx, uid)
	if err != nil || len(ids) != 3 || len(hashes) != 3 || hashes[0] != "h-a" || hashes[2] != "h-c" {
		t.Fatalf("ListUnusedRecoveryCodes = %v, %v, %v; want three in order", ids, hashes, err)
	}

	consumed, err := database.MarkRecoveryCodeUsed(ctx, ids[1])
	if err != nil || !consumed {
		t.Fatalf("MarkRecoveryCodeUsed = %v, %v; want true, nil", consumed, err)
	}
	consumed, err = database.MarkRecoveryCodeUsed(ctx, ids[1])
	if err != nil || consumed {
		t.Fatalf("second MarkRecoveryCodeUsed = %v, %v; want false, nil (single use)", consumed, err)
	}
	if n, err := database.CountUnusedRecoveryCodes(ctx, uid); err != nil || n != 2 {
		t.Fatalf("CountUnusedRecoveryCodes = %d, %v; want 2", n, err)
	}
	ids, _, err = database.ListUnusedRecoveryCodes(ctx, uid)
	if err != nil || len(ids) != 2 {
		t.Fatalf("ListUnusedRecoveryCodes after use = %v, %v; want two", ids, err)
	}

	// Replacing drops the old set entirely, spent rows included, in one go.
	if err := database.ReplaceRecoveryCodes(ctx, uid, []string{"h-d"}); err != nil {
		t.Fatalf("ReplaceRecoveryCodes (again): %v", err)
	}
	if n, err := database.CountUnusedRecoveryCodes(ctx, uid); err != nil || n != 1 {
		t.Fatalf("CountUnusedRecoveryCodes after replace = %d, %v; want 1", n, err)
	}
	var total int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ?`, uid).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 1 {
		t.Fatalf("%d rows after replace, want 1 (spent rows go too)", total)
	}

	if err := database.DeleteRecoveryCodes(ctx, uid); err != nil {
		t.Fatalf("DeleteRecoveryCodes: %v", err)
	}
	if n, err := database.CountUnusedRecoveryCodes(ctx, uid); err != nil || n != 0 {
		t.Fatalf("CountUnusedRecoveryCodes after delete = %d, %v; want 0", n, err)
	}
}

// EraseAccount purges the four second-factor tables with the rest.
func TestEraseAccount_PurgesSecondFactorState(t *testing.T) {
	ctx := context.Background()
	database, uid := secondFactorTestDB(t)
	// A second account so uid is not the last admin-class account (it is a
	// member anyway) and so the purge is provably scoped to one user.
	other, err := database.CreateUser(ctx, "bystander", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	for _, id := range []int64{uid, other} {
		if err := database.UpsertPartialAuth(ctx, "c"+string(rune('0'+id)), id, "", "", 0, future); err != nil {
			t.Fatal(err)
		}
		if err := database.UpsertPendingTOTP(ctx, id, "sealed", future); err != nil {
			t.Fatal(err)
		}
		if _, err := database.InsertUsedTOTPCode(ctx, id, "d", future); err != nil {
			t.Fatal(err)
		}
		if err := database.ReplaceRecoveryCodes(ctx, id, []string{"h"}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := database.EraseAccount(ctx, uid); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	count := func(q string, id int64) int {
		var n int
		if err := database.QueryRowContext(ctx, q, id).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM partial_auth_challenges WHERE user_id = ?`,
		`SELECT COUNT(*) FROM pending_totp_enrollments WHERE user_id = ?`,
		`SELECT COUNT(*) FROM totp_used_codes WHERE user_id = ?`,
		`SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ?`,
	} {
		if got := count(q, uid); got != 0 {
			t.Errorf("%s = %d after EraseAccount, want 0", q, got)
		}
		if got := count(q, other); got != 1 {
			t.Errorf("%s = %d for the bystander, want 1 (untouched)", q, got)
		}
	}
}
