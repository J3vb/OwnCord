package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Migration 044 and the counter rows themselves (B5-2). The admission and
// recount logic is proved in service/upload_quota_test.go; these pin the
// schema half: what the migration seeds, what the guard does at the
// boundary, and how a counter row lives and dies beside the rows it caches.

// TestMigration044_SeedsCountersFromAttachmentsAndSkipsLegacyOrphans: an
// upgrade starts every uploader's counter from their rows, and a legacy
// attachment whose uploader has no users row (uploader_id predates its
// foreign key) is skipped rather than failing the migration.
func TestMigration044_SeedsCountersFromAttachmentsAndSkipsLegacyOrphans(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	// Apply everything up to 043, build the pre-044 world, then apply 044.
	if err := db.MigrateFS(database, migrationsBefore(t, "044")); err != nil {
		t.Fatalf("migrate to 043: %v", err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	exec(`INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4), (11, 'bob', 'x', 4)`)
	exec(`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('a1', 'a', 'a1', 'x', 100, 10), ('a2', 'a', 'a2', 'x', 250, 10), ('b1', 'b', 'b1', 'x', 7, 11)`)
	exec(`PRAGMA foreign_keys = OFF`)
	exec(`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('ghost', 'g', 'ghost', 'x', 999, 999)`)
	exec(`INSERT INTO attachments (id, filename, stored_as, mime_type, size) VALUES ('legacy', 'l', 'legacy', 'x', 5)`)
	exec(`PRAGMA foreign_keys = ON`)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("044 failed on a legacy tree: %v", err)
	}
	for _, tc := range []struct {
		user int64
		want int64
	}{{10, 350}, {11, 7}} {
		got, err := database.UserStorageUsed(ctx, tc.user)
		if err != nil || got != tc.want {
			t.Errorf("seeded counter for %d = %d, %v; want %d", tc.user, got, err, tc.want)
		}
	}
	var rows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_storage`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("user_storage rows = %d, %v; want 2 (the ghost uploader and the NULL uploader seed nothing)", rows, err)
	}
	total, err := database.TotalAttachmentBytes(ctx)
	if err != nil || total != 100+250+7+999+5 {
		t.Fatalf("TotalAttachmentBytes = %d, %v; want every row, legacy included", total, err)
	}
}

// TestChargeUserStorage_GuardIsExactAtTheBoundary: at quota admits, one byte
// over refuses, a zero quota is unlimited, and a release floors at zero.
func TestChargeUserStorage_GuardIsExactAtTheBoundary(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	if ok, err := database.ChargeUserStorage(ctx, 10, 100, 100); err != nil || !ok {
		t.Fatalf("exactly at quota: ok=%v err=%v", ok, err)
	}
	if ok, err := database.ChargeUserStorage(ctx, 10, 1, 100); err != nil || ok {
		t.Fatalf("one byte over: ok=%v err=%v, want refused", ok, err)
	}
	if ok, err := database.ChargeUserStorage(ctx, 10, 1<<40, 0); err != nil || !ok {
		t.Fatalf("unlimited quota: ok=%v err=%v", ok, err)
	}
	if err := database.ReleaseUserStorage(ctx, 10, 1<<50); err != nil {
		t.Fatalf("release past zero: %v", err)
	}
	if got, err := database.UserStorageUsed(ctx, 10); err != nil || got != 0 {
		t.Fatalf("counter after an over-release = %d, %v; want 0 (floored)", got, err)
	}
	if got, err := database.UserStorageUsed(ctx, 999); err != nil || got != 0 {
		t.Fatalf("a user with no row holds %d, %v; want 0", got, err)
	}
}

// TestUserStorage_RowSurvivesRetentionAtZeroAndDiesWithTheAccount is the
// retention/deletion test for the counter rows themselves: deleting every
// attachment leaves a zero row (the user still exists, the counter is still
// theirs), and erasing the account takes the row with it.
func TestUserStorage_RowSurvivesRetentionAtZeroAndDiesWithTheAccount(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := database.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	exec(`INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4)`)
	exec(`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('a1', 'a', 'a1', 'x', 100, 10)`)
	if ok, err := database.ChargeUserStorage(ctx, 10, 100, 0); err != nil || !ok {
		t.Fatal(err)
	}
	exec(`DELETE FROM attachments WHERE id = 'a1'`) // what retention does to the rows
	if err := database.RecountUserStorage(ctx, 10); err != nil {
		t.Fatal(err)
	}
	var rows int
	var bytes int64
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(bytes_used), -1) FROM user_storage WHERE user_id = 10`).Scan(&rows, &bytes); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || bytes != 0 {
		t.Fatalf("after retention: rows=%d bytes=%d; want the row kept at 0", rows, bytes)
	}
	if _, err := database.EraseAccount(ctx, 10, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_storage WHERE user_id = 10`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("after erasure: rows=%d, %v; want 0 (class 12a)", rows, err)
	}
	ids, err := database.ListUserStorageIDs(ctx)
	if err != nil || len(ids) != 0 {
		t.Fatalf("ListUserStorageIDs after erasure = %v, %v; want none", ids, err)
	}
}
