package db_test

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

// migrationsBefore returns the embedded migrations up to, not including, the
// one whose name starts with stop.
func migrationsBefore(t *testing.T, stop string) fstest.MapFS {
	t.Helper()
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	out := fstest.MapFS{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), stop) {
			continue
		}
		data, err := fs.ReadFile(migrations.FS, e.Name())
		if err != nil {
			t.Fatalf("ReadFile(%s): %v", e.Name(), err)
		}
		out[e.Name()] = &fstest.MapFile{Data: data}
	}
	return out
}

// B4-1's upgrade mapping (BPR-041): the pre-mode boolean maps to invite or
// closed and never to open, a fresh install defaults to invite-only, and the
// old row is removed.
func TestMigration034_MapsRegistrationOpenWithoutOpening(t *testing.T) {
	cases := []struct {
		name     string
		users    bool
		open     *string // nil = the registration_open row is absent
		wantMode string
	}{
		{"upgrade, registration_open 1", true, new("1"), "invite"},
		{"upgrade, registration_open true", true, new("true"), "invite"},
		{"upgrade, registration_open 0", true, new("0"), "closed"},
		{"upgrade, registration_open garbage", true, new("maybe"), "closed"},
		{"upgrade, row absent", true, nil, "closed"},
		{"fresh install, seed 0", false, new("0"), "invite"},
		{"fresh install, row absent", false, nil, "invite"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := openMemory(t)
			if err := db.MigrateFS(database, migrationsBefore(t, "034_")); err != nil {
				t.Fatalf("migrate to 033: %v", err)
			}
			ctx := context.Background()
			if _, err := database.ExecContext(ctx, `DELETE FROM settings WHERE key = 'registration_open'`); err != nil {
				t.Fatalf("clear seed: %v", err)
			}
			if tc.open != nil {
				if _, err := database.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES ('registration_open', ?)`, *tc.open); err != nil {
					t.Fatalf("seed registration_open: %v", err)
				}
			}
			if tc.users {
				if _, err := database.CreateUser(ctx, "owner", "hash", 1); err != nil {
					t.Fatalf("CreateUser: %v", err)
				}
			}

			if err := db.Migrate(database); err != nil {
				t.Fatalf("migrate to head: %v", err)
			}

			mode, err := database.GetSetting(ctx, "registration_mode")
			if err != nil {
				t.Fatalf("GetSetting(registration_mode): %v", err)
			}
			if mode != tc.wantMode {
				t.Errorf("registration_mode = %q, want %q", mode, tc.wantMode)
			}
			if _, err := database.GetSetting(ctx, "registration_open"); err == nil {
				t.Error("registration_open row survived the migration")
			}
		})
	}
}

// Approval-mode applications are accounts that cannot act yet: they are
// absent from the member roster and from the require_2fa enrolment count,
// and only a still-pending row can be approved or denied.
func TestPendingUsers_HeldOutsideTheRosterUntilDecided(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.CreateUser(ctx, "member", "hash", 4); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	pendingID, err := database.CreatePendingUser(ctx, "applicant", "hash", 4)
	if err != nil {
		t.Fatalf("CreatePendingUser: %v", err)
	}

	u, err := database.GetUserByID(ctx, pendingID)
	if err != nil || u == nil || !u.PendingApproval() {
		t.Fatalf("GetUserByID = %+v, %v; want a pending user", u, err)
	}
	members, err := database.ListMembers(ctx)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	for _, m := range members {
		if m.ID == pendingID {
			t.Error("a pending application appears in the member roster")
		}
	}
	if n, err := database.CountUsersWithoutTOTP(ctx); err != nil || n != 1 {
		t.Errorf("CountUsersWithoutTOTP = %d, %v; want 1 (the pending application does not count)", n, err)
	}
	if n, err := database.CountPendingUsers(ctx); err != nil || n != 1 {
		t.Errorf("CountPendingUsers = %d, %v; want 1", n, err)
	}
	queue, err := database.ListPendingUsers(ctx, 50, 0)
	if err != nil || len(queue) != 1 || queue[0].ID != pendingID || queue[0].Username != "applicant" {
		t.Fatalf("ListPendingUsers = %+v, %v; want the one application", queue, err)
	}

	// Approving makes it an ordinary account; a second decision finds nothing.
	if err := database.ApprovePendingUser(ctx, pendingID); err != nil {
		t.Fatalf("ApprovePendingUser: %v", err)
	}
	if err := database.ApprovePendingUser(ctx, pendingID); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("second approve = %v, want ErrNotFound", err)
	}
	if err := database.DenyPendingUser(ctx, pendingID); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("deny after approve = %v, want ErrNotFound (an approved account is never touched here)", err)
	}
	u, _ = database.GetUserByID(ctx, pendingID)
	if u == nil || u.RegistrationStatus != db.RegistrationActive {
		t.Fatalf("approved user = %+v, want active", u)
	}
	members, _ = database.ListMembers(ctx)
	found := false
	for _, m := range members {
		found = found || m.ID == pendingID
	}
	if !found {
		t.Error("an approved account is missing from the member roster")
	}

	// Denying anonymises and locks the row for good and releases the name.
	deniedID, err := database.CreatePendingUser(ctx, "denied", "hash", 4)
	if err != nil {
		t.Fatalf("CreatePendingUser: %v", err)
	}
	if err := database.DenyPendingUser(ctx, deniedID); err != nil {
		t.Fatalf("DenyPendingUser: %v", err)
	}
	u, _ = database.GetUserByID(ctx, deniedID)
	if u == nil || u.RegistrationStatus != db.RegistrationDenied || u.Username == "denied" || u.PasswordHash != "" {
		t.Fatalf("denied row = %+v, want anonymised and marked denied", u)
	}
	if byName, _ := database.GetUserByUsername(ctx, "denied"); byName != nil {
		t.Error("the denied username was not released")
	}
	if n, _ := database.CountPendingUsers(ctx); n != 0 {
		t.Errorf("CountPendingUsers = %d after the decisions, want 0", n)
	}
	if err := database.ApprovePendingUser(ctx, deniedID); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("approve after deny = %v, want ErrNotFound", err)
	}
}

// Open-mode registration commits the account and its first session together.
func TestCreateUserWithSession_CommitsBothOrNeither(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, err := database.CreateUserWithSession(ctx, "opened", "hash", 4, "sess-opened", "test", "127.0.0.1")
	if err != nil {
		t.Fatalf("CreateUserWithSession: %v", err)
	}
	sess, err := database.GetSessionByTokenHash(ctx, "sess-opened")
	if err != nil || sess == nil || sess.UserID != uid {
		t.Fatalf("session = %+v, %v; want one for user %d", sess, err, uid)
	}
	if sess.Unseen {
		t.Error("a registration's first session should not be flagged as a new login")
	}
	// A duplicate username fails as a whole: no second session row appears.
	if _, err := database.CreateUserWithSession(ctx, "opened", "hash", 4, "sess-dup", "test", "127.0.0.1"); err == nil {
		t.Fatal("duplicate username accepted")
	}
	if sess, _ := database.GetSessionByTokenHash(ctx, "sess-dup"); sess != nil {
		t.Error("a session row survived the rolled-back registration")
	}
}
