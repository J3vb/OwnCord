package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/alphasnap"
	"github.com/J3vb/OwnCord/Server/storage"
)

// seedErasureMember creates a member with two attachment rows (a message
// attachment and an avatar) and materialises their files in dir, per the
// drill protocol's "files" rule. Another admin-class account exists so the
// last-admin guard never fires.
func seedErasureMember(t *testing.T, database *db.DB, dir string) (int64, []string) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.CreateUser(ctx, "erasure-owner", "hash", 1); err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	uid, err := database.CreateUser(ctx, "erasure-member", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	chID, err := database.CreateChannel(ctx, "erasure-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, chID, uid, "with a file", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	files := []string{"stored-msg-file", "stored-avatar-file"}
	for i, f := range files {
		var msg any
		if i == 0 {
			msg = msgID
		}
		if _, err := database.ExecContext(ctx,
			`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES (?, ?, 'f.png', ?, 'image/png', 4, ?)`,
			fmt.Sprintf("att-%d", i), msg, f, uid); err != nil {
			t.Fatalf("seed attachment: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, f), []byte("data"), 0o600); err != nil {
			t.Fatalf("seed file: %v", err)
		}
	}
	return uid, files
}

func newTestStorage(t *testing.T, dir string) *storage.Storage {
	t.Helper()
	st, err := storage.New(dir, 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	return st
}

func fileExists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	if err == nil {
		return true
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat %s: %v", path, err)
	}
	return false
}

func TestErasureService_EraseRemovesRowsAndFiles(t *testing.T) {
	database := newTestDB(t)
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))

	if err := svc.Erase(context.Background(), uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after the erasure", f)
		}
	}
	if u, _ := database.GetUserByID(context.Background(), uid); u != nil {
		t.Errorf("user row survived: %+v", u)
	}
	jobs, err := database.ListUnfinishedErasureJobs(context.Background())
	if err != nil || len(jobs) != 0 {
		t.Errorf("unfinished jobs = %v, %v; want none", jobs, err)
	}
	if err := svc.Erase(context.Background(), uid); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("second erasure = %v, want ErrNotFound", err)
	}
}

// Interruption between the commit and the file removal: the process dies
// with the files on disk and the job at db_done. A restart — a fresh handle
// on the same file, as the maintenance loop's startup resume sees it —
// finishes the job.
func TestErasureService_RestartResumesTheFileHalf(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "erasure.sqlite")
	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)

	// The database half commits; the process is gone before any unlink.
	if _, err := database.EraseAccount(context.Background(), uid, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	for _, f := range files {
		if !fileExists(t, filepath.Join(dir, f)) {
			t.Fatalf("%s should still be on disk before the restart", f)
		}
	}

	reopened, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open after restart: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if err := db.Migrate(reopened); err != nil {
		t.Fatalf("db.Migrate after restart: %v", err)
	}
	svc := NewErasureService(reopened)
	svc.SetFiles(newTestStorage(t, dir))
	done, err := svc.Resume(context.Background())
	if err != nil || done != 1 {
		t.Fatalf("Resume = %d, %v; want 1 job done", done, err)
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after the resumed job", f)
		}
	}
	jobs, err := reopened.ListUnfinishedErasureJobs(context.Background())
	if err != nil || len(jobs) != 0 {
		t.Errorf("unfinished jobs after resume = %v, %v", jobs, err)
	}
}

// failingRemover fails every removal until allowed; the runner must record
// the attempt and keep the job for the next pass.
type failingRemover struct {
	real  FileRemover
	allow bool
}

func (f *failingRemover) Delete(name string) error {
	if !f.allow {
		return fmt.Errorf("remove %s: %w", name, storage.ErrIO)
	}
	return f.real.Delete(name)
}

func TestErasureService_FailedRemovalIsRetriedAndMissingFilesCount(t *testing.T) {
	database := newTestDB(t)
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	remover := &failingRemover{real: newTestStorage(t, dir)}
	svc := NewErasureService(database)
	svc.SetFiles(remover)

	err := svc.Erase(context.Background(), uid)
	if !errors.Is(err, ErrErasureFilesPending) {
		t.Fatalf("Erase with a failing remover = %v, want ErrErasureFilesPending", err)
	}
	if u, _ := database.GetUserByID(context.Background(), uid); u != nil {
		t.Fatal("the account must be gone even though its files are pending")
	}
	jobs, err := database.ListUnfinishedErasureJobs(context.Background())
	if err != nil || len(jobs) != 1 {
		t.Fatalf("unfinished jobs = %v, %v; want the pending one", jobs, err)
	}
	if jobs[0].Attempts != 1 || jobs[0].LastError == "" {
		t.Errorf("job after the failure = %+v, want attempts 1 and an error", jobs[0])
	}

	// Still failing: another attempt, still pending.
	if done, err := svc.Resume(context.Background()); done != 0 || err == nil {
		t.Fatalf("Resume while failing = %d, %v; want 0 and an error", done, err)
	}
	// One file disappears out of band (the reconciliation pass, an
	// operator): a missing file counts as removed.
	if err := os.Remove(filepath.Join(dir, files[0])); err != nil {
		t.Fatalf("remove out of band: %v", err)
	}
	remover.allow = true
	if done, err := svc.Resume(context.Background()); done != 1 || err != nil {
		t.Fatalf("Resume once removal works = %d, %v; want 1 done", done, err)
	}
	job, err := database.GetErasureJob(context.Background(), jobs[0].ID)
	if err != nil {
		t.Fatalf("GetErasureJob: %v", err)
	}
	if job.State != db.ErasureStateDone || job.FilesRemoved != 2 || job.Attempts != 3 {
		t.Errorf("job after completion = %+v, want done, 2 removed, 3 attempts", job)
	}
	if fileExists(t, filepath.Join(dir, files[1])) {
		t.Errorf("%s still on disk", files[1])
	}
}

func TestErasureService_NoStorageLeavesTheJobPending(t *testing.T) {
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	svc := NewErasureService(database)
	if svc.HasFiles() {
		t.Fatal("HasFiles before SetFiles")
	}
	if err := svc.Erase(context.Background(), uid); !errors.Is(err, ErrErasureFilesPending) {
		t.Fatalf("Erase without storage = %v, want ErrErasureFilesPending", err)
	}
	jobs, err := database.ListUnfinishedErasureJobs(context.Background())
	if err != nil || len(jobs) != 1 || jobs[0].LastError == "" {
		t.Fatalf("unfinished jobs = %v, %v; want one with the no-storage error", jobs, err)
	}
	// A job with nothing to remove completes without storage.
	if _, err := database.CreateUser(context.Background(), "fileless", "hash", 4); err != nil {
		t.Fatal(err)
	}
	fileless, _ := database.GetUserByUsername(context.Background(), "fileless")
	if err := svc.Erase(context.Background(), fileless.ID); err != nil {
		t.Errorf("Erase of a fileless account without storage = %v, want nil", err)
	}
	// Storage arrives (the maintenance loop's fallback); the pending job
	// finishes.
	svc.SetFiles(newTestStorage(t, dir))
	if done, err := svc.Resume(context.Background()); done != 1 || err != nil {
		t.Errorf("Resume after SetFiles = %d, %v; want 1", done, err)
	}
}

// Reconcile removes what no row names and nothing else: the stranded file
// (HP-4 drill D5's class), never a live attachment, an emoji's file, a file
// younger than the cutoff, or anything when no storage is installed.
func TestErasureService_ReconcileRemovesOnlyStrandedFiles(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, err := database.CreateUser(ctx, "reconcile-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id) VALUES ('live', 'l', 'live-file', 'image/png', 1, ?)`, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO emoji (shortcode, filename, uploaded_by) VALUES ('e', 'emoji-file', ?)`, uid); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	for _, name := range []string{"live-file", "emoji-file", "stranded-1", "stranded-2", "fresh-upload"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if name != "fresh-upload" {
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "a-directory"), 0o700); err != nil {
		t.Fatal(err)
	}
	store := newTestStorage(t, dir)
	cutoff := time.Now().Add(-time.Hour)

	svc := NewErasureService(database)
	if n, err := svc.Reconcile(ctx, store, cutoff, 100); n != 0 || err != nil {
		t.Fatalf("Reconcile without storage = %d, %v; want 0", n, err)
	}
	svc.SetFiles(store)
	// Bounded: one per call.
	if n, err := svc.Reconcile(ctx, store, cutoff, 1); n != 1 || err != nil {
		t.Fatalf("Reconcile(limit 1) = %d, %v; want 1", n, err)
	}
	if n, err := svc.Reconcile(ctx, store, cutoff, 100); n != 1 || err != nil {
		t.Fatalf("second Reconcile = %d, %v; want the remaining 1", n, err)
	}
	if n, err := svc.Reconcile(ctx, store, cutoff, 100); n != 0 || err != nil {
		t.Fatalf("third Reconcile = %d, %v; want 0 (nothing stranded)", n, err)
	}
	for _, name := range []string{"live-file", "emoji-file", "fresh-upload"} {
		if !fileExists(t, filepath.Join(dir, name)) {
			t.Errorf("%s was removed; it is referenced or too young", name)
		}
	}
	for _, name := range []string{"stranded-1", "stranded-2"} {
		if fileExists(t, filepath.Join(dir, name)) {
			t.Errorf("%s survived reconciliation", name)
		}
	}
}

// The B4-9 lineage checklist end to end on the alpha snapshot: every
// inventory class zero and zero files for the subject on disk.
func TestErasureService_LineageChecklistOnAlphaSnapshot(t *testing.T) {
	path, err := alphasnap.Copy(t.TempDir())
	if err != nil {
		t.Fatalf("alphasnap.Copy: %v", err)
	}
	database, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	ctx := context.Background()
	var uid int64
	var uname string
	if err := database.QueryRowContext(ctx, `
		SELECT u.id, u.username FROM users u WHERE u.role_id = 4
		ORDER BY (SELECT COUNT(*) FROM attachments a WHERE a.uploader_id = u.id) DESC, u.id LIMIT 1`).Scan(&uid, &uname); err != nil {
		t.Fatalf("pick subject: %v", err)
	}
	dir := t.TempDir()
	rows, err := database.QueryContext(ctx, `SELECT stored_as, size FROM attachments WHERE uploader_id = ?`, uid)
	if err != nil {
		t.Fatalf("list attachments: %v", err)
	}
	seeded := 0
	for rows.Next() {
		var name string
		var size int64
		if err := rows.Scan(&name, &size); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
		seeded++
	}
	_ = rows.Close()
	if seeded == 0 {
		t.Fatalf("subject %d has no attachments; pick a member with everything", uid)
	}
	before, err := database.TakeInventory(ctx, uid, uname)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}

	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}

	after, err := database.TakeInventory(ctx, uid, uname)
	if err != nil {
		t.Fatalf("TakeInventory: %v", err)
	}
	for _, c := range db.SubjectInventory {
		want := 0
		if db.InventoryKeptByErasure[c.Key] {
			want = before[c.Key]
		}
		if after[c.Key] != want {
			t.Errorf("%s = %d after erasure, want %d", c.Key, after[c.Key], want)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("lineage — subject %d: %d attachment files seeded, %d left on disk", uid, seeded, len(entries))
	if len(entries) != 0 {
		t.Errorf("%d of the subject's files survived on disk", len(entries))
	}
}

// ─── The two routes ─────────────────────────────────────────────────────────

type recordingBanBroadcaster struct{ banned []int64 }

func (r *recordingBanBroadcaster) BroadcastMemberBan(userID int64) {
	r.banned = append(r.banned, userID)
}

func TestAuthService_DeleteAccountErasesAndBroadcasts(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	hash, err := auth.HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateUserPassword(ctx, uid, hash); err != nil {
		t.Fatal(err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	bcast := &recordingBanBroadcaster{}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), bcast)
	shared := NewErasureService(database)
	shared.SetFiles(newTestStorage(t, dir))
	svc.UseErasure(shared)
	svc.UseErasure(nil) // a nil runner is ignored

	if err := svc.DeleteAccount(ctx, Principal{User: user}, "wrong", "203.0.113.9"); !errors.Is(err, ErrIncorrectPassword) {
		t.Fatalf("wrong password = %v", err)
	}
	if err := svc.DeleteAccount(ctx, Principal{User: user}, "correct horse battery", "203.0.113.9"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if u, _ := database.GetUserByID(ctx, uid); u != nil {
		t.Error("user row survived")
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk", f)
		}
	}
	if len(bcast.banned) != 1 || bcast.banned[0] != uid {
		t.Errorf("member_ban broadcasts = %v, want [%d]", bcast.banned, uid)
	}
	var audits int
	// Unlinked from the start (B4-10): no actor id, no target id, no IP.
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'account_deleted' AND actor_id = 0 AND target_id = 0 AND detail NOT LIKE '%203.0.113.9%'`).Scan(&audits); err != nil || audits != 1 {
		t.Errorf("unlinked account_deleted audit rows = %d (%v), want 1", audits, err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE actor_id = ? OR (target_type = 'user' AND target_id = ?)`, uid, uid).Scan(&audits); err != nil || audits != 0 {
		t.Errorf("audit rows still naming the subject = %d (%v), want 0", audits, err)
	}
}

func TestAuthService_DeleteAccountLastAdminIsRefused(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	hash, _ := auth.HashPassword("correct horse battery")
	uid, err := database.CreateUser(ctx, "only-owner", hash, 1)
	if err != nil {
		t.Fatal(err)
	}
	user, _ := database.GetUserByID(ctx, uid)
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	if err := svc.DeleteAccount(ctx, Principal{User: user}, "correct horse battery", ""); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("DeleteAccount(last owner) = %v, want ErrLastAdmin", err)
	}
	if u, _ := database.GetUserByID(ctx, uid); u == nil {
		t.Error("the last owner was erased")
	}
}

func TestModerationService_EraseUser(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	member, files := seedErasureMember(t, database, dir) // also creates the owner
	owner, _ := database.GetUserByUsername(ctx, "erasure-owner")
	adminID, err := database.CreateUser(ctx, "erasure-admin", "hash", 2)
	if err != nil {
		t.Fatal(err)
	}
	bystander, err := database.CreateUser(ctx, "erasure-bystander", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(database, auth.NewRateLimiter())
	svc.Erasure.SetFiles(newTestStorage(t, dir))
	mod := svc.Moderation

	if err := mod.EraseUser(ctx, bystander, member); !errors.Is(err, ErrForbidden) {
		t.Errorf("member erasing a member = %v, want ErrForbidden", err)
	}
	if err := mod.EraseUser(ctx, owner.ID, owner.ID); !errors.Is(err, ErrBadRequest) {
		t.Errorf("self-erasure via the admin route = %v, want ErrBadRequest", err)
	}
	if err := mod.EraseUser(ctx, owner.ID, 0); !errors.Is(err, ErrBadRequest) {
		t.Errorf("target 0 = %v, want ErrBadRequest", err)
	}
	if err := mod.EraseUser(ctx, owner.ID, 999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing target = %v, want ErrNotFound", err)
	}
	if err := mod.EraseUser(ctx, adminID, owner.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("admin erasing the owner = %v, want ErrForbidden (hierarchy)", err)
	}
	if u, _ := database.GetUserByID(ctx, member); u == nil {
		t.Fatal("a refused erasure removed the account")
	}

	if err := mod.EraseUser(ctx, owner.ID, member); err != nil {
		t.Fatalf("owner erasing a member: %v", err)
	}
	if u, _ := database.GetUserByID(ctx, member); u != nil {
		t.Error("member row survived")
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk", f)
		}
	}
	var audits int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'account_deleted' AND actor_id = ? AND target_id = 0`, owner.ID).Scan(&audits); err != nil || audits != 1 {
		t.Errorf("account_deleted audit rows by the owner (target unlinked) = %d (%v), want 1", audits, err)
	}

	unwired := NewModerationService(database, svc.Permissions)
	if err := unwired.EraseUser(ctx, owner.ID, bystander); !errors.Is(err, ErrInternal) {
		t.Errorf("EraseUser without a runner = %v, want ErrInternal (fail closed)", err)
	}
}

type recordingErasureHub struct {
	calls []string
}

func (h *recordingErasureHub) BroadcastMemberBan(userID int64) {
	h.calls = append(h.calls, fmt.Sprintf("ban:%d", userID))
}

func (h *recordingErasureHub) PurgeUserFromReplay(_ context.Context, userID int64) error {
	h.calls = append(h.calls, fmt.Sprintf("purge:%d", userID))
	return nil
}

// With the hub installed the runner broadcasts the member_ban itself and
// purges replay right behind it, and the routes stop sending their own.
func TestErasureService_HubBroadcastsThenPurges(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	hash, _ := auth.HashPassword("correct horse battery")
	if err := database.UpdateUserPassword(ctx, uid, hash); err != nil {
		t.Fatal(err)
	}
	user, _ := database.GetUserByID(ctx, uid)
	hub := &recordingErasureHub{}
	shared := NewErasureService(database)
	shared.SetFiles(newTestStorage(t, dir))
	if shared.BroadcastsMemberBan() {
		t.Fatal("BroadcastsMemberBan before SetHub")
	}
	shared.SetHub(hub)
	bcast := &recordingBanBroadcaster{}
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), bcast)
	svc.UseErasure(shared)

	if err := svc.DeleteAccount(ctx, Principal{User: user}, "correct horse battery", ""); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	want := fmt.Sprintf("[ban:%d purge:%d]", uid, uid)
	if got := fmt.Sprint(hub.calls); got != want {
		t.Errorf("hub calls = %s, want %s", got, want)
	}
	if len(bcast.banned) != 0 {
		t.Errorf("the auth service broadcast on its own too: %v", bcast.banned)
	}

	all := New(database, auth.NewRateLimiter())
	if all.Moderation.ErasureBroadcastsMemberBan() {
		t.Error("ErasureBroadcastsMemberBan without a hub")
	}
	all.Erasure.SetHub(hub)
	if !all.Moderation.ErasureBroadcastsMemberBan() {
		t.Error("ErasureBroadcastsMemberBan with a hub")
	}
}

func newTestMarkers(t *testing.T) *db.MarkerStore {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = 9
	}
	m, err := db.OpenMarkerStore(filepath.Join(t.TempDir(), "erasure", "markers.sqlite"), key)
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

// With a marker store the erasure records the marker pending, confirms it
// after the commit, and the audit rows carry its token; a refused erasure
// leaves no marker behind.
func TestErasureService_RecordsAndConfirmsTheMarker(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	if svc.SubjectToken(uid) != "" {
		t.Fatal("SubjectToken without markers")
	}
	svc.SetMarkers(markers)
	tok := svc.SubjectToken(uid)
	if tok != markers.SubjectToken(uid) {
		t.Fatalf("SubjectToken = %q", tok)
	}

	// Refused: the sole owner is the last admin-class account.
	owner, _ := database.GetUserByUsername(ctx, "erasure-owner")
	if err := svc.Erase(ctx, owner.ID); !errors.Is(err, db.ErrLastAdmin) {
		t.Fatalf("Erase(owner) = %v, want ErrLastAdmin", err)
	}
	if m, _ := markers.Markers(ctx); len(m) != 0 {
		t.Fatalf("a refused erasure left a marker: %+v", m)
	}

	if err := database.LogAuditEntry(ctx, db.AuditEntry{ActorID: uid, Action: "user_login", TargetType: "user", TargetID: uid, Detail: "ip"}); err != nil {
		t.Fatal(err)
	}
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	m, err := markers.Markers(ctx)
	if err != nil || len(m) != 1 || m[0].SubjectToken != tok || m[0].State != db.MarkerRecorded {
		t.Fatalf("markers after erasure = %+v, %v; want one recorded marker for the subject", m, err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE subject_token = ? AND actor_id = 0 AND target_id = 0`, tok).Scan(&n); err != nil || n != 1 {
		t.Errorf("unlinked audit rows carrying the token = %d (%v), want 1", n, err)
	}
	// Erasing again finds nothing; the marker is not duplicated or lost.
	if err := svc.Erase(ctx, uid); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("second Erase = %v", err)
	}
	if m, _ := markers.Markers(ctx); len(m) != 1 || m[0].State != db.MarkerRecorded {
		t.Errorf("markers after the refused repeat = %+v", m)
	}
}

// ReplayMarkers is the start-up pass: an account a restore brought back is
// erased again, files included, and the audit row names the replay by token.
func TestErasureService_ReplayMarkersErasesAResurrectedAccount(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	backup := filepath.Join(t.TempDir(), "older.db")
	if err := database.BackupToSafe(ctx, backup, filepath.Dir(backup)); err != nil {
		t.Fatal(err)
	}
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	if err := svc.Erase(ctx, uid); err != nil {
		t.Fatalf("Erase: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	// The restore: the older file over the live one, the files back on disk
	// (uploads are not in a backup, but a subject's files may well be — the
	// operator restored the upload directory too).
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dbPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("back"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	restored, err := db.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restored.Close() })
	if err := db.Migrate(restored); err != nil {
		t.Fatal(err)
	}
	if u, _ := restored.GetUserByID(ctx, uid); u == nil {
		t.Fatal("the restore did not resurrect the account")
	}

	fresh := NewErasureService(restored)
	fresh.SetFiles(newTestStorage(t, dir))
	if rep, err := fresh.ReplayMarkers(ctx); err != nil || rep.Erased != 0 {
		t.Fatalf("ReplayMarkers without markers = %+v, %v; want nothing", rep, err)
	}
	fresh.SetMarkers(markers)
	rep, err := fresh.ReplayMarkers(ctx)
	if err != nil {
		t.Fatalf("ReplayMarkers: %v", err)
	}
	if rep.Erased != 1 {
		t.Fatalf("report = %+v, want 1 erased", rep)
	}
	if u, _ := restored.GetUserByID(ctx, uid); u != nil {
		t.Error("the resurrected account survived the replay")
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after the replayed erasure", f)
		}
	}
	var n int
	if err := restored.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'account_erasure_replayed' AND subject_token = ? AND actor_id = 0 AND target_id = 0`, markers.SubjectToken(uid)).Scan(&n); err != nil || n != 1 {
		t.Errorf("account_erasure_replayed rows = %d (%v), want 1", n, err)
	}
}
