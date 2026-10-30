package service

import (
	"context"
	"errors"
	"github.com/J3vb/OwnCord/Server/permissions"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// The hidden import account must be unreachable as a person. Its stored
// password matches nothing, and the login path refuses it on the account kind
// as well, so a row given a real hash by mistake still cannot sign in.
func TestLogin_RefusesTheHiddenImportAccount(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	id, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	in := LoginInput{Username: "[imported]", Password: "!", Device: "d", IP: "203.0.113.9"}
	for _, pw := range []string{"!", "", "password123", "[imported]"} {
		in.Password = pw
		if _, err := svc.Login(ctx, in); !errors.Is(err, ErrInvalidCredentials) {
			t.Errorf("password %q: err = %v, want ErrInvalidCredentials", pw, err)
		}
	}

	hash, err := auth.HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE users SET password = ? WHERE id = ?`, hash, id); err != nil {
		t.Fatal(err)
	}
	in.Password = "correct horse battery"
	res, err := svc.Login(ctx, in)
	if !errors.Is(err, ErrInvalidCredentials) || res != nil {
		t.Errorf("a system row with a real hash signed in: %+v, %v", res, err)
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM sessions`); n != 0 {
		t.Errorf("sessions issued = %d", n)
	}
}

func TestCreateDM_RefusesTheHiddenImportAccount(t *testing.T) {
	database, permSvc := newDMFixture(t)
	ctx := context.Background()
	id, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewDMService(database, permSvc).CreateDM(ctx, 1, id); err == nil {
		t.Fatal("a direct message to the import account was created")
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM dm_participants WHERE user_id = ?`, id); n != 0 {
		t.Errorf("import account is a DM participant (%d rows)", n)
	}
	u, err := database.GetUserByID(ctx, id)
	if err != nil || u == nil {
		t.Fatal(err)
	}
	if dmReachableUser(u) {
		t.Error("dmReachableUser accepted the import account")
	}
}

// Every moderation or admin action that names a user by id must answer for the
// hidden import account exactly as it does for an id that does not exist.
func TestModeration_TargetsRefuseTheHiddenImportAccount(t *testing.T) {
	svc, database := newTestModerationService(t)
	ctx := context.Background()
	sys, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	const owner = 1
	exp := time.Now().Add(time.Hour)
	calls := map[string]func() error{
		"ban":       func() error { return svc.BanUser(ctx, owner, sys, "r", nil) },
		"ban timed": func() error { return svc.BanUser(ctx, owner, sys, "r", &exp) },
		"unban":     func() error { return svc.UnbanUser(ctx, owner, sys) },
		"warn":      func() error { _, err := svc.Warn(ctx, owner, sys, "r", nil); return err },
		"timeout": func() error {
			_, err := svc.Timeout(ctx, owner, sys, "r", time.Hour, nil)
			return err
		},
		"lift timeout": func() error { return svc.LiftTimeout(ctx, owner, sys) },
		"force logout": func() error { return svc.ForceLogout(ctx, owner, sys) },
		"change role":  func() error { _, err := svc.ChangeUserRole(ctx, owner, sys, 3); return err },
		"add role":     func() error { _, err := svc.AddUserRole(ctx, owner, sys, 3); return err },
		"remove role":  func() error { _, err := svc.RemoveUserRole(ctx, owner, sys, 3); return err },
		"nickname": func() error {
			name := "x"
			_, err := svc.SetNickname(ctx, owner, sys, &name)
			return err
		},
		"ban purge": func() error { return svc.AuthorizeBanPurge(ctx, owner, sys) },
	}
	for name, call := range calls {
		if err := call(); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: err = %v, want ErrNotFound", name, err)
		}
	}
	if u, _ := database.GetUserByID(ctx, sys); u == nil || u.Banned {
		t.Errorf("the account was changed: %+v", u)
	}
	users := NewUserService(database)
	if _, err := users.Get(ctx, sys); !errors.Is(err, ErrNotFound) {
		t.Errorf("admin user lookup err = %v, want ErrNotFound", err)
	}
}

// Erasing the hidden account would delete every imported message with it.
func TestEraseUser_RefusesTheHiddenImportAccountAndKeepsImportedMessages(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	owner, err := database.CreateUser(ctx, "the-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(database, auth.NewRateLimiter())
	svc.Erasure.SetFiles(newTestStorage(t, t.TempDir()))
	sys, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ch, job, err := database.StartImport(ctx, db.StartImportParams{Name: "history"})
	if err != nil {
		t.Fatal(err)
	}
	ids, err := database.ImportChunk(ctx, db.ImportChunkParams{
		JobID: job, ChannelID: ch, AuthorID: sys, Progress: db.ImportProgress{Imported: 1},
		Messages: []db.ImportMessage{{Key: "a", Content: "kept", Timestamp: time.Now(), DiscordUserID: "1", AuthorName: "Ann"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.PublishImport(ctx, job, ch, ids["a"], db.ImportProgress{Imported: 1}); err != nil {
		t.Fatal(err)
	}

	if err := svc.Moderation.EraseUser(ctx, owner, sys); !errors.Is(err, ErrNotFound) {
		t.Fatalf("EraseUser(import account) = %v, want ErrNotFound", err)
	}
	if u, _ := database.GetUserByID(ctx, sys); u == nil {
		t.Error("the import account was erased")
	}
	if n := countRows(t, database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND deleted = 0`, ch); n != 1 {
		t.Errorf("imported messages left = %d, want 1", n)
	}
}

func TestResolveSocketPrincipal_RefusesTheHiddenImportAccount(t *testing.T) {
	svc, database, ctx := sessionFixture(t)
	sys, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateSession(ctx, sys, "sys-hash", "web", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if u, err := svc.ResolveSocketPrincipal(ctx, "sys-hash"); !errors.Is(err, ErrPrincipalGone) || u != nil {
		t.Errorf("ResolveSocketPrincipal = %v, %v; want ErrPrincipalGone", u, err)
	}
}

// Files in a channel an import is still building are not readable by anyone,
// administrators included, until the channel is published.
func TestAuthorize_RefusesFilesOfAPendingImportChannel(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	sys, _ := database.EnsureImportAccount(ctx)
	adminID, err := database.CreateUser(ctx, "root", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	admin, _ := database.GetUserByID(ctx, adminID)
	role := &db.Role{ID: 1, Permissions: permissions.Administrator}
	uploads := NewUploadService(database, NewPermissionService(database, permissions.NewChecker(database)))

	ch, job, err := database.StartImport(ctx, db.StartImportParams{Name: "history"})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CreateAttachment(ctx, "att-1", sys, "a.txt", "att-1", "text/plain", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	ids, err := database.ImportChunk(ctx, db.ImportChunkParams{
		JobID: job, ChannelID: ch, AuthorID: sys, Progress: db.ImportProgress{Imported: 1},
		Messages: []db.ImportMessage{{Key: "a", Content: "x", Timestamp: time.Now(), DiscordUserID: "1", AuthorName: "Ann", AttachmentIDs: []string{"att-1"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	aa, err := uploads.Resolve(ctx, "att-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := uploads.Authorize(ctx, aa, admin, role); !errors.Is(err, ErrNotFound) {
		t.Errorf("file of a channel still being imported: err = %v, want not found", err)
	}
	if err := database.PublishImport(ctx, job, ch, ids["a"], db.ImportProgress{Imported: 1}); err != nil {
		t.Fatal(err)
	}
	aa, _ = uploads.Resolve(ctx, "att-1")
	if err := uploads.Authorize(ctx, aa, admin, role); err != nil {
		t.Errorf("after publishing: %v", err)
	}
}

func TestIssueRecoveryAssist_RefusesTheHiddenImportAccount(t *testing.T) {
	ctx := context.Background()
	svc, owner, _, database := newAssistFixture(t, false)
	sys, err := database.EnsureImportAccount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IssueRecoveryAssist(ctx, owner.ID, sys, "in_person"); !errors.Is(err, ErrNotFound) {
		t.Errorf("assist for the import account = %v, want not found", err)
	}
}
