package service

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

func openSealTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	mustDo(t, "db.Open", err)
	t.Cleanup(func() { _ = database.Close() })
	mustDo(t, "Migrate", db.Migrate(database))
	return database
}

func sealTestUser(t *testing.T, database *db.DB, name string, stored *string) int64 {
	t.Helper()
	ctx := context.Background()
	uid := mustCreateUser(t, database, name, "hash", 4)
	if stored != nil {
		mustDo(t, "UpdateUserTOTPSecret", database.UpdateUserTOTPSecret(ctx, uid, stored))
	}
	return uid
}

func storedSecret(t *testing.T, database *db.DB, uid int64) *string {
	t.Helper()
	u, err := database.GetUserByID(context.Background(), uid)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID(%d) = %v, %v", uid, u, err)
	}
	return u.TOTPSecret
}

func sealTestKey() []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return key
}

// TestSealLegacyTOTPSecrets_ConvertsOnlyUnsealedSecrets pins the startup
// conversion: an unsealed base32 secret is sealed and still yields the same
// codes, a sealed secret and a user without one are untouched, a value that is
// neither is counted and left as it is, and a second run changes nothing.
func TestSealLegacyTOTPSecrets_ConvertsOnlyUnsealedSecrets(t *testing.T) {
	database := openSealTestDB(t)
	key := sealTestKey()
	ctx := context.Background()

	legacy := "JBSWY3DPEHPK3PXP"
	sealedValue, err := auth.EncryptTOTPSecret(key, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
	mustDo(t, "EncryptTOTPSecret", err)
	damaged := "not a secret"

	legacyUID := sealTestUser(t, database, "legacy", &legacy)
	sealedUID := sealTestUser(t, database, "sealed", &sealedValue)
	damagedUID := sealTestUser(t, database, "damaged", &damaged)
	noneUID := sealTestUser(t, database, "none", nil)

	sealed, unreadable, err := SealLegacyTOTPSecrets(ctx, database, key)
	mustDo(t, "sealLegacyTOTPSecrets", err)
	if sealed != 1 || !slices.Equal(unreadable, []int64{damagedUID}) {
		t.Fatalf("sealed, unreadable = %d, %v, want 1, [%d]", sealed, unreadable, damagedUID)
	}

	got := storedSecret(t, database, legacyUID)
	if got == nil || *got == legacy {
		t.Fatalf("legacy row = %v, want it sealed", got)
	}
	plain, err := auth.DecryptTOTPSecret(key, *got)
	if err != nil || plain != legacy {
		t.Fatalf("legacy row decrypts to %q, %v, want %q", plain, err, legacy)
	}
	if got := storedSecret(t, database, sealedUID); got == nil || *got != sealedValue {
		t.Fatalf("sealed row = %v, want it unchanged", got)
	}
	if got := storedSecret(t, database, damagedUID); got == nil || *got != damaged {
		t.Fatalf("damaged row = %v, want it unchanged", got)
	}
	if got := storedSecret(t, database, noneUID); got != nil {
		t.Fatalf("user without a secret now has %q", *got)
	}

	before := *storedSecret(t, database, legacyUID)
	sealed, unreadable, err = SealLegacyTOTPSecrets(ctx, database, key)
	if err != nil || sealed != 0 || !slices.Equal(unreadable, []int64{damagedUID}) {
		t.Fatalf("second run = %d, %v, %v, want 0, [%d], nil", sealed, unreadable, err, damagedUID)
	}
	if after := *storedSecret(t, database, legacyUID); after != before {
		t.Fatal("second run rewrote an already sealed row")
	}
}

// racingStore disables two-factor for a user between the conversion's read
// and its write, as a concurrent DELETE /users/me/totp would.
type racingStore struct {
	*db.DB
	t *testing.T
}

func (r racingStore) ReplaceUserTOTPSecret(ctx context.Context, userID int64, old, next string) (bool, error) {
	if err := r.UpdateUserTOTPSecret(ctx, userID, nil); err != nil {
		r.t.Fatalf("UpdateUserTOTPSecret: %v", err)
	}
	ok, err := r.DB.ReplaceUserTOTPSecret(ctx, userID, old, next)
	return ok, err
}

// TestSealLegacyTOTPSecrets_YieldsToAConcurrentChange pins the compare-and-set:
// a row whose secret changed after it was read is not overwritten with the
// sealed form of the old secret, and is not counted as sealed.
func TestSealLegacyTOTPSecrets_YieldsToAConcurrentChange(t *testing.T) {
	database := openSealTestDB(t)
	legacy := "JBSWY3DPEHPK3PXP"
	uid := sealTestUser(t, database, "racer", &legacy)

	sealed, unreadable, err := SealLegacyTOTPSecrets(context.Background(), racingStore{database, t}, sealTestKey())
	if err != nil || sealed != 0 || len(unreadable) != 0 {
		t.Fatalf("SealLegacyTOTPSecrets = %d, %v, %v, want 0, none, nil", sealed, unreadable, err)
	}
	if got := storedSecret(t, database, uid); got != nil {
		t.Fatalf("secret = %q after a concurrent disable, want NULL", *got)
	}
}
