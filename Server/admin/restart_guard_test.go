package admin_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/updater"
)

// ─── The restart handoff: swap success paths and the serialization guard ────
//
// applyStagedUpdate no longer spawns, signals, or exits — the restart goes
// through the coordinator hook (admin.SetRestartHandoff) and the main package
// performs the drain + handoff. That is what makes the success paths below
// testable at all, and the three-state guard (idle → busy → restart-pending)
// is what keeps concurrent applies/restores/restarts from racing each other.

// stageFakeUpdate lays out a fake current binary and a staged .new whose
// hash matches, returning the three paths plus the staged hash.
func stageFakeUpdate(t *testing.T) (exePath, oldPath, newPath, stagedHash string) {
	t.Helper()
	dir := t.TempDir()
	exePath = filepath.Join(dir, "chatserver")
	oldPath = exePath + ".old"
	newPath = exePath + ".new"
	if err := os.WriteFile(exePath, []byte("old binary"), 0o755); err != nil {
		t.Fatalf("writing fake exe: %v", err)
	}
	staged := []byte("verified staged bytes")
	if err := os.WriteFile(newPath, staged, 0o755); err != nil {
		t.Fatalf("writing staged binary: %v", err)
	}
	sum := sha256.Sum256(staged)
	return exePath, oldPath, newPath, hex.EncodeToString(sum[:])
}

// The success path: the verified staged binary ends up at exePath, the
// previous binary at .old, no corrective broadcast is sent, and the swap
// reports committed.
func TestApplyStagedUpdate_Success_SwapsWithoutAbortBroadcast(t *testing.T) {
	exePath, oldPath, newPath, stagedHash := stageFakeUpdate(t)

	hub := &mockHub{}
	if !admin.ApplyStagedUpdate(hub, exePath, oldPath, newPath, stagedHash) {
		t.Fatal("ApplyStagedUpdate = false, want committed swap")
	}

	if len(hub.restartCalls) != 0 {
		t.Errorf("restartCalls = %+v, want none (no corrective broadcast on success)", hub.restartCalls)
	}
	if got, err := os.ReadFile(exePath); err != nil || string(got) != "verified staged bytes" {
		t.Errorf("exePath contents = %q, err=%v; want the staged bytes", got, err)
	}
	if got, err := os.ReadFile(oldPath); err != nil || string(got) != "old binary" {
		t.Errorf(".old contents = %q, err=%v; want the previous binary", got, err)
	}
	if _, err := os.Stat(newPath); !os.IsNotExist(err) {
		t.Errorf(".new still exists after commit (stat err=%v)", err)
	}
}

// The full background tail on success: countdown broadcast, swap, guard
// promoted to restart-pending, restart requested through the hook with
// reason "update".
func TestApplyAndRestart_Success_RequestsRestartAndMarksPending(t *testing.T) {
	exePath, oldPath, newPath, stagedHash := stageFakeUpdate(t)

	admin.ResetRestartState()
	admin.ForceRestartState(true) // the handler claims busy before spawning the goroutine
	reasons, restoreHook := admin.StubRestartCapture()
	defer restoreHook()
	defer admin.SetApplyRestartDelay(time.Millisecond)()

	hub := &mockHub{}
	admin.ApplyAndRestart(hub, exePath, oldPath, newPath, stagedHash)

	if len(hub.restartCalls) != 1 || hub.restartCalls[0].reason != "update" {
		t.Fatalf("restartCalls = %+v, want exactly the update countdown", hub.restartCalls)
	}
	if got := reasons(); len(got) != 1 || got[0] != "update" {
		t.Errorf("restart hook reasons = %v, want [update]", got)
	}
	if got := admin.CurrentRestartState(); got != "pending" {
		t.Errorf("restart state after committed swap = %q, want pending", got)
	}
}

// The background tail on a failed swap: corrective broadcast (covered in
// depth by the OC-0226 tests), no restart request, and the busy slot released
// so a corrected release can be applied without a manual restart.
func TestApplyAndRestart_Abort_ReleasesGuard(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "chatserver")
	oldPath := exePath + ".old"
	newPath := exePath + ".new" // never written → re-verification fails

	admin.ResetRestartState()
	admin.ForceRestartState(true)
	reasons, restoreHook := admin.StubRestartCapture()
	defer restoreHook()
	defer admin.SetApplyRestartDelay(time.Millisecond)()

	hub := &mockHub{}
	admin.ApplyAndRestart(hub, exePath, oldPath, newPath,
		"0000000000000000000000000000000000000000000000000000000000000000")

	if got := reasons(); len(got) != 0 {
		t.Errorf("restart hook reasons = %v, want none on abort", got)
	}
	if got := admin.CurrentRestartState(); got != "idle" {
		t.Errorf("restart state after aborted swap = %q, want idle (slot released)", got)
	}
	if len(hub.restartCalls) != 2 || hub.restartCalls[1].reason != "update_aborted" {
		t.Errorf("restartCalls = %+v, want countdown then update_aborted", hub.restartCalls)
	}
}

// POST /updates/apply answers 409 without touching the updater when a restart
// is already pending or another restart-sensitive operation is in flight.
// The guard sits before CheckForUpdate, so no GitHub call is attempted — the
// updater here has no reachable base URL and would error loudly if consulted.
func TestApplyUpdate_Conflict409(t *testing.T) {
	t.Setenv("OWNCORD_CONTAINER", "0")
	database := openAdminTestDB(t)
	u := updater.NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	handler := admin.NewAdminAPI(database, "1.0.0", nil, u, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	cases := []struct {
		name     string
		busy     bool
		wantCode string
	}{
		{"restart pending", false, "RESTART_PENDING"},
		{"apply or restore in flight", true, "UPDATE_IN_PROGRESS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			admin.ForceRestartState(tc.busy)
			t.Cleanup(admin.ResetRestartState)

			w := doRequest(t, handler, http.MethodPost, "/updates/apply", token, nil)
			if w.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
			}
			var resp map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if resp["error"] != tc.wantCode {
				t.Errorf("error code = %q, want %q", resp["error"], tc.wantCode)
			}
		})
	}
}

// POST /backups/{name}/restore refuses the same way — before any disk I/O.
func TestRestoreBackup_Conflict409(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	admin.ForceRestartState(false) // restart pending
	t.Cleanup(admin.ResetRestartState)

	w := doRequest(t, handler, http.MethodPost, "/backups/chatserver_x.db/restore", token, nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "RESTART_PENDING" {
		t.Errorf("error code = %q, want RESTART_PENDING", resp["error"])
	}
}

// A restore whose database.Close() fails is still committed to dying: it must
// request a restart AND leave the guard in restart-pending so nothing else
// starts an update against a process with closed DB pools.
func TestRestore_CloseFailure_StillMarksPendingAndRequestsRestart(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	backupDir := filepath.Join(tmpDir, "data", "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		t.Fatalf("MkdirAll backups: %v", err)
	}
	backupName := "chatserver_20240101_120000.db"
	if err := database.BackupToSafe(context.Background(), filepath.Join(backupDir, backupName), backupDir); err != nil {
		t.Fatalf("BackupToSafe fixture: %v", err)
	}

	reasons, restoreHook := admin.StubRestartCapture()
	defer restoreHook()
	restoreClose := admin.StubCloseError("injected close failure")
	defer restoreClose()

	w := doRequest(t, handler, http.MethodPost, "/backups/"+backupName+"/restore", token, nil)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body: %s", w.Code, w.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for len(reasons()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := reasons(); len(got) != 1 || got[0] != "backup_restore_close_failed" {
		t.Errorf("restart hook reasons = %v, want [backup_restore_close_failed]", got)
	}
	if got := admin.CurrentRestartState(); got != "pending" {
		t.Errorf("restart state = %q, want pending (process is committed to dying)", got)
	}
}

// A setup-wizard restart is skipped (with the response already written) when
// an update or restore already owns the restart: two restart paths must never
// race each other's teardown.
func TestSetupRestart_SkippedWhenPending(t *testing.T) {
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	restarted := make(chan string, 1)
	handler := wizardHandler(t, database, cfgPath, restarted)

	admin.ForceRestartState(false) // restart pending

	rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
		"username": "owner",
		"password": "SecurePass123!",
		"wizard": map[string]any{
			"server_name": "S",
			"port":        9000,
			"tls_mode":    "off",
		},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}

	select {
	case reason := <-restarted:
		t.Errorf("setup requested restart %q despite a pending restart", reason)
	case <-time.After(200 * time.Millisecond):
	}
}

// The unwired default hook must degrade to a loud log — never exit, spawn,
// or panic — so a binary that misses the SetRestartHandoff wiring (or a test
// that forgets to stub) fails soft.
func TestRequestRestart_UnwiredDefaultIsInert(t *testing.T) {
	admin.RequestRestartForTest("unwired-test")
}
