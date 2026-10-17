package service

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// failDrain makes the drain stage fail: seedErasureMember's subject uploaded
// two attachments, and the stage that deletes them runs after the lock.
const failDrainTrigger = `CREATE TRIGGER fail_drain BEFORE DELETE ON attachments BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END`

func installFailDrain(t *testing.T, database *db.DB) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), failDrainTrigger); err != nil {
		t.Fatalf("install fault: %v", err)
	}
}

func clearFailDrain(t *testing.T, database *db.DB) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), `DROP TRIGGER fail_drain`); err != nil {
		t.Fatalf("drop fault: %v", err)
	}
}

func countBans(hub *recordingErasureHub) int {
	n := 0
	for _, c := range hub.calls {
		if strings.HasPrefix(c, "ban:") {
			n++
		}
	}
	return n
}

func accountGone(t *testing.T, database *db.DB, uid int64) bool {
	t.Helper()
	u, err := database.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	return u == nil
}

// A stage that fails after the lock does not fail the erasure: Erase answers
// ErrErasureInProgress, keeps the marker pending, wakes the maintenance loop,
// and the next Resume completes the job. The member_ban goes out once, at
// completion.
func TestErasureService_FailureAfterLockResumesOnTick(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	markers := newTestMarkers(t)
	hub := &recordingErasureHub{}
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetHub(hub)
	installFailDrain(t, database)

	err := svc.Erase(ctx, uid)
	if !errors.Is(err, ErrErasureInProgress) {
		t.Fatalf("Erase with a failing drain = %v, want ErrErasureInProgress", err)
	}
	if m, _ := markers.Markers(ctx); len(m) != 1 || m[0].State != db.MarkerPending {
		t.Fatalf("markers after the failed drain = %+v, want one pending (it must not be discarded)", m)
	}
	select {
	case <-svc.WakeCh():
	default:
		t.Error("Erase left work for the maintenance loop and did not wake it")
	}
	if accountGone(t, database, uid) {
		t.Fatal("the account is gone though the drain failed")
	}
	if got := fmt.Sprint(hub.calls); got != fmt.Sprintf("[disconnect:%d]", uid) {
		t.Errorf("hub calls before completion = %s, want only the disconnect (no member_ban yet)", got)
	}
	for _, f := range files {
		if !fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s removed while the erasure was unfinished", f)
		}
	}
	if done, err := svc.Resume(ctx); done != 0 || err == nil {
		t.Errorf("Resume with the fault still there = %d, %v; want 0 and an error, the job staying queued", done, err)
	}

	clearFailDrain(t, database)
	if done, err := svc.Resume(ctx); done != 1 || err != nil {
		t.Fatalf("Resume = %d, %v; want 1", done, err)
	}
	if !accountGone(t, database, uid) {
		t.Error("the account survived the resumed erasure")
	}
	if n := countBans(hub); n != 1 {
		t.Errorf("member_ban broadcasts = %d (%v), want exactly 1, at completion", n, hub.calls)
	}
	if m, _ := markers.Markers(ctx); len(m) != 1 || m[0].State != db.MarkerRecorded {
		t.Errorf("markers after completion = %+v, want one recorded", m)
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after completion", f)
		}
	}
	if done, err := svc.Resume(ctx); done != 0 || err != nil {
		t.Errorf("second Resume = %d, %v; want nothing left", done, err)
	}
	if n := countBans(hub); n != 1 {
		t.Errorf("member_ban broadcasts after the second Resume = %d, want still 1", n)
	}
}

// The routes report success for an erasure that is committed to but not
// finished.
func TestAuthService_DeleteAccountReportsSuccessWhileInProgress(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	hash, _ := auth.HashPassword("correct horse battery")
	if err := database.UpdateUserPassword(ctx, uid, hash); err != nil {
		t.Fatal(err)
	}
	user, _ := database.GetUserByID(ctx, uid)
	shared := NewErasureService(database)
	shared.SetFiles(newTestStorage(t, dir))
	svc := NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), &recordingBanBroadcaster{})
	svc.UseErasure(shared)
	installFailDrain(t, database)

	if err := svc.DeleteAccount(ctx, Principal{User: user}, "correct horse battery", ""); err != nil {
		t.Fatalf("DeleteAccount with the erasure in progress = %v, want success", err)
	}
	clearFailDrain(t, database)
	if done, err := shared.Resume(ctx); done != 1 || err != nil {
		t.Fatalf("Resume = %d, %v", done, err)
	}
	if !accountGone(t, database, uid) {
		t.Error("the account survived")
	}
}

// Edge case 1 at the service level: the process dies with a pending marker
// and a queued job. On restart ReplayMarkers finishes the database half and
// Resume the files; the marker ends recorded.
func TestErasureService_CrashMidErasureCompletesOnRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	uid, files := seedErasureMember(t, database, dir)
	markers := newTestMarkers(t)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	installFailDrain(t, database)
	if err := svc.Erase(ctx, uid); !errors.Is(err, ErrErasureInProgress) {
		t.Fatalf("Erase = %v, want ErrErasureInProgress", err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openFileDB(t, dbPath)
	t.Cleanup(func() { _ = reopened.Close() })
	clearFailDrain(t, reopened)
	restarted := NewErasureService(reopened)
	restarted.SetFiles(newTestStorage(t, dir))
	restarted.SetMarkers(markers)
	report, err := restarted.ReplayMarkers(ctx)
	if err != nil || report.Erased != 1 {
		t.Fatalf("ReplayMarkers = %+v, %v; want the locked account erased", report, err)
	}
	if !accountGone(t, reopened, uid) {
		t.Fatal("the account survived the restart replay")
	}
	if m, _ := markers.Markers(ctx); len(m) != 1 || m[0].State != db.MarkerRecorded {
		t.Errorf("markers after the replay = %+v, want one recorded", m)
	}
	// The replay runs the file half itself (eraseForReplay); Resume has
	// nothing left and must not undo or repeat any of it.
	if done, err := restarted.Resume(ctx); done != 0 || err != nil {
		t.Fatalf("Resume after the replay = %d, %v; want nothing left", done, err)
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after the restart", f)
		}
	}
	var rows int
	if err := reopened.QueryRowContext(ctx, `SELECT COUNT(*) FROM erasure_jobs WHERE user_id = ?`, uid).Scan(&rows); err != nil || rows != 1 {
		t.Errorf("erasure_jobs rows = %d (%v), want exactly one", rows, err)
	}
}

// Past the inline budget Erase hands the rest to the maintenance loop and
// reports in-progress; nothing is lost and Resume completes it.
func TestErasureService_InlineBudgetHandsOffToResume(t *testing.T) {
	defer func(prev time.Duration) { eraseInlineBudget = prev }(eraseInlineBudget)
	eraseInlineBudget = -time.Second
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, files := seedErasureMember(t, database, dir)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))

	if err := svc.Erase(ctx, uid); !errors.Is(err, ErrErasureInProgress) {
		t.Fatalf("Erase past the budget = %v, want ErrErasureInProgress", err)
	}
	select {
	case <-svc.WakeCh():
	default:
		t.Error("no wake after the budget ran out")
	}
	svc.RequestResume()
	svc.RequestResume() // a wake while one is pending is the same wake
	<-svc.WakeCh()
	select {
	case <-svc.WakeCh():
		t.Error("two requests queued two wakes")
	default:
	}
	if done, err := svc.Resume(ctx); done != 1 || err != nil {
		t.Fatalf("Resume = %d, %v", done, err)
	}
	if !accountGone(t, database, uid) {
		t.Error("the account survived")
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk", f)
		}
	}
}

// A user an Erase or Resume is already driving is skipped by the other, and a
// queued job is never run as if its database half were finished.
func TestErasureService_InFlightUserIsNotDrivenTwice(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, _ := seedErasureMember(t, database, dir)
	svc := NewErasureService(database)
	svc.SetFiles(newTestStorage(t, dir))
	job, err := database.EraseAccountLock(ctx, uid, true)
	if err != nil {
		t.Fatalf("EraseAccountLock: %v", err)
	}
	if err := svc.runJob(ctx, job); err == nil {
		t.Error("runJob accepted a queued job")
	}

	if !svc.claim(uid) {
		t.Fatal("first claim refused")
	}
	if svc.claim(uid) {
		t.Fatal("second claim granted")
	}
	if err := svc.Erase(ctx, uid); !errors.Is(err, ErrErasureInProgress) {
		t.Errorf("Erase of a user being driven = %v, want ErrErasureInProgress", err)
	}
	if done, err := svc.Resume(ctx); done != 0 || err != nil {
		t.Errorf("Resume over a user being driven = %d, %v; want it skipped", done, err)
	}
	if accountGone(t, database, uid) {
		t.Fatal("the account was erased by someone who did not hold the claim")
	}
	svc.release(uid)
	if done, err := svc.Resume(ctx); done != 1 || err != nil {
		t.Fatalf("Resume after the release = %d, %v", done, err)
	}
	if !accountGone(t, database, uid) {
		t.Error("the account survived")
	}
}
