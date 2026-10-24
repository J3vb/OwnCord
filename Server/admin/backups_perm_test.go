package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// WP 8.4c: MANAGE_BACKUPS lets a non-owner create a backup, list backups and
// download one through a single-use link. Restore, delete, the full archive,
// the backup policy, updates, tokens and config stay owner-only.

const backupsPermFile = "chatserver_20260901_100000.db"

// backupsPermFixture is an admin API over a temp backup directory holding one
// backup file, with one principal per kind of role.
type backupsPermFixture struct {
	api      *admin.AdminAPI
	database *db.DB
	dir      string
	owner    string
	holder   string // holds MANAGE_BACKUPS only
	holderID int64
	admin    string // ADMINISTRATOR, not the owner
	manager  string // MANAGE_SERVER | MANAGE_ROLES: perimeter access, no backup bit
}

func newBackupsPermFixture(t *testing.T) backupsPermFixture {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, backupsPermFile), []byte("backup bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := openAdminTestDB(t)
	api := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{BackupDir: dir})
	holderID, holder := createRoleUser(t, database, 20, "Backup Keepers", permissions.ManageBackups, 50, "backupholder")
	_, adminTok := createRoleUser(t, database, 22, "Super", permissions.Administrator, 90, "backupsuper")
	_, manager := createRoleUser(t, database, 21, "Manager", permissions.ManageServer|permissions.ManageRoles, 55, "backupmanager")
	_, owner := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.Administrator, 100, "backupowner")
	return backupsPermFixture{api: api, database: database, dir: dir, owner: owner, holder: holder,
		holderID: holderID, admin: adminTok, manager: manager}
}

func backupFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func linkPath(t *testing.T, body []byte) string {
	t.Helper()
	var resp struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || !strings.Contains(resp.Path, "token=") {
		t.Fatalf("link response %s: %v", body, err)
	}
	return resp.Path
}

func openLinkNoAuth(api http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, strings.TrimPrefix(path, "/admin/api"), nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)
	return w
}

// A holder reaches the three backup routes and redeems the link; so do the
// owner and an Administrator (the bypass is the same as every other bit).
func TestManageBackups_HolderCanCreateListAndDownload(t *testing.T) {
	// A fresh fixture per principal: a manual backup is named to the second,
	// so two in one second would collide on the file name.
	for _, who := range []string{"holder", "administrator", "owner"} {
		t.Run(who, func(t *testing.T) {
			f := newBackupsPermFixture(t)
			token := map[string]string{"holder": f.holder, "administrator": f.admin, "owner": f.owner}[who]
			if w := doRequest(t, f.api, http.MethodPost, "/backup", token, nil); w.Code != http.StatusOK {
				t.Fatalf("POST /backup = %d, want 200; body: %s", w.Code, w.Body.String())
			}
			w := doRequest(t, f.api, http.MethodGet, "/backups", token, nil)
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), backupsPermFile) {
				t.Fatalf("GET /backups = %d, want 200 listing the backup; body: %s", w.Code, w.Body.String())
			}
			w = doRequest(t, f.api, http.MethodPost, "/backups/"+backupsPermFile+"/link", token, map[string]any{})
			if w.Code != http.StatusOK {
				t.Fatalf("POST link = %d, want 200; body: %s", w.Code, w.Body.String())
			}
			dl := openLinkNoAuth(f.api, linkPath(t, w.Body.Bytes()))
			if dl.Code != http.StatusOK || dl.Body.String() != "backup bytes" {
				t.Fatalf("redeem = %d %q, want 200 with the file", dl.Code, dl.Body.String())
			}
		})
	}
}

// Everything past create, list and download stays the owner's: a holder gets
// 403 where the owner does not.
func TestManageBackups_HolderRefusedOnOwnerOnlyBackupRoutes(t *testing.T) {
	f := newBackupsPermFixture(t)
	for _, rt := range []struct{ method, path string }{
		{http.MethodDelete, "/backups/" + backupsPermFile},
		{http.MethodPost, "/backups/" + backupsPermFile + "/restore"},
		{http.MethodGet, "/archive"},
		{http.MethodPost, "/archive/link"},
		{http.MethodGet, "/tokens"},
		{http.MethodGet, "/updates"},
		{http.MethodGet, "/config/settings"},
	} {
		if w := doRequest(t, f.api, rt.method, rt.path, f.holder, nil); w.Code != http.StatusForbidden {
			t.Errorf("holder %s %s = %d, want 403; body: %s", rt.method, rt.path, w.Code, w.Body.String())
		}
	}
	// The backup policy is MANAGE_SERVER plus owner-only keys; a holder has neither.
	if w := doRequest(t, f.api, http.MethodPatch, "/settings", f.holder, map[string]string{"backup_schedule": "daily"}); w.Code != http.StatusForbidden {
		t.Errorf("holder PATCH backup_schedule = %d, want 403", w.Code)
	}
	if got := backupFiles(t, f.dir); len(got) != 1 {
		t.Errorf("refused requests changed the backup directory: %v", got)
	}
}

// A principal without the bit, even with MANAGE_SERVER and MANAGE_ROLES, is
// refused on the three routes the bit opens.
func TestManageBackups_NonHolderRefused(t *testing.T) {
	f := newBackupsPermFixture(t)
	for _, rt := range []struct{ method, path string }{
		{http.MethodPost, "/backup"},
		{http.MethodGet, "/backups"},
		{http.MethodPost, "/backups/" + backupsPermFile + "/link"},
		{http.MethodDelete, "/backups/" + backupsPermFile},
		{http.MethodPost, "/backups/" + backupsPermFile + "/restore"},
		{http.MethodGet, "/archive"},
		{http.MethodPost, "/archive/link"},
	} {
		if w := doRequest(t, f.api, rt.method, rt.path, f.manager, nil); w.Code != http.StatusForbidden {
			t.Errorf("non-holder %s %s = %d, want 403; body: %s", rt.method, rt.path, w.Code, w.Body.String())
		}
	}
	if got := backupFiles(t, f.dir); len(got) != 1 {
		t.Errorf("a refused POST /backup wrote a file: %v", got)
	}
}

// The link is re-checked when it is opened: a holder who lost the bit, was
// banned, or lost the session gets nothing, and the owner's links keep working.
func TestManageBackups_LinkRevalidatedOnRedeem(t *testing.T) {
	issue := func(t *testing.T, f backupsPermFixture) string {
		t.Helper()
		w := doRequest(t, f.api, http.MethodPost, "/backups/"+backupsPermFile+"/link", f.holder, map[string]any{})
		if w.Code != http.StatusOK {
			t.Fatalf("holder POST link = %d; body: %s", w.Code, w.Body.String())
		}
		return linkPath(t, w.Body.Bytes())
	}
	t.Run("bit removed from the role", func(t *testing.T) {
		f := newBackupsPermFixture(t)
		path := issue(t, f)
		if _, err := f.database.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = 20`, permissions.ReadMessages); err != nil {
			t.Fatal(err)
		}
		if w := openLinkNoAuth(f.api, path); w.Code != http.StatusForbidden {
			t.Errorf("link after the bit was removed = %d, want 403", w.Code)
		}
	})
	t.Run("banned", func(t *testing.T) {
		f := newBackupsPermFixture(t)
		path := issue(t, f)
		if _, err := f.database.ExecContext(context.Background(), `UPDATE users SET banned = 1 WHERE id = ?`, f.holderID); err != nil {
			t.Fatal(err)
		}
		if w := openLinkNoAuth(f.api, path); w.Code != http.StatusForbidden {
			t.Errorf("link of a banned holder = %d, want 403", w.Code)
		}
	})
	t.Run("session revoked", func(t *testing.T) {
		f := newBackupsPermFixture(t)
		path := issue(t, f)
		if err := f.database.DeleteSession(context.Background(), auth.HashToken(f.holder)); err != nil {
			t.Fatal(err)
		}
		if w := openLinkNoAuth(f.api, path); w.Code != http.StatusForbidden {
			t.Errorf("link after sign-out = %d, want 403", w.Code)
		}
	})
	t.Run("bit held through a second role", func(t *testing.T) {
		f := newBackupsPermFixture(t)
		path := issue(t, f)
		// Moved from the role that carried the bit to one that does not, while
		// another role they hold still carries it: effective permissions are the OR.
		if _, err := f.database.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = 20`, permissions.ReadMessages); err != nil {
			t.Fatal(err)
		}
		if _, err := f.database.ExecContext(context.Background(),
			`INSERT INTO roles (id, name, permissions, position) VALUES (30, 'Second', ?, 20)`, permissions.ManageBackups); err != nil {
			t.Fatal(err)
		}
		if _, err := f.database.ExecContext(context.Background(),
			`INSERT INTO user_roles (user_id, role_id) VALUES (?, 30)`, f.holderID); err != nil {
			t.Fatal(err)
		}
		if w := openLinkNoAuth(f.api, path); w.Code != http.StatusOK {
			t.Errorf("link of a holder whose second role carries the bit = %d, want 200; body: %s", w.Code, w.Body.String())
		}
	})
}

// The full archive's link stays owner-only: a holder cannot get one, and a
// backup-link token does not open the archive.
func TestManageBackups_ArchiveStaysOwnerOnly(t *testing.T) {
	f := newBackupsPermFixture(t)
	w := doRequest(t, f.api, http.MethodPost, "/backups/"+backupsPermFile+"/link", f.holder, map[string]any{})
	u, _ := url.Parse(linkPath(t, w.Body.Bytes()))
	if dl := openLinkNoAuth(f.api, "/admin/api/archive/download?token="+u.Query().Get("token")); dl.Code != http.StatusForbidden {
		t.Errorf("backup token on the archive route = %d, want 403", dl.Code)
	}
}

// Issuing a link leaves an audit row naming the actor and the backup, never
// the token.
func TestManageBackups_LinkIssueAudited(t *testing.T) {
	f := newBackupsPermFixture(t)
	rec := audittest.Install(t, f.database)
	w := doRequest(t, f.api, http.MethodPost, "/backups/"+backupsPermFile+"/link", f.holder, map[string]any{})
	if w.Code != http.StatusOK {
		t.Fatalf("POST link = %d; body: %s", w.Code, w.Body.String())
	}
	token := mustQueryToken(t, linkPath(t, w.Body.Bytes()))
	e := rec.Wait(t, "backup_link")
	if e.ActorID != f.holderID || !strings.Contains(e.Detail, backupsPermFile) || strings.Contains(e.Detail, token) {
		t.Errorf("backup_link row = %+v, want the holder, the backup name and no token", e)
	}
	audittest.AssertSafeDetails(t, rec.Entries(), token)
}

func mustQueryToken(t *testing.T, path string) string {
	t.Helper()
	u, err := url.Parse(path)
	if err != nil || u.Query().Get("token") == "" {
		t.Fatalf("no token in %q", path)
	}
	return u.Query().Get("token")
}

// Only one manual backup runs at a time: while the first is in flight a second
// POST /backup is a 409 BACKUP_RUNNING that writes nothing, and the guard
// frees once the first finishes.
func TestManageBackups_SingleFlight(t *testing.T) {
	f := newBackupsPermFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	admin.SetBackupHoldForTest(f.api, func() {
		close(entered)
		<-release
	})

	var wg sync.WaitGroup
	var first *httptest.ResponseRecorder
	wg.Go(func() {
		first = doRequest(t, f.api, http.MethodPost, "/backup", f.holder, nil)
	})
	<-entered

	second := doRequest(t, f.api, http.MethodPost, "/backup", f.owner, nil)
	if second.Code != http.StatusConflict || !strings.Contains(second.Body.String(), "BACKUP_RUNNING") {
		t.Errorf("concurrent POST /backup = %d %s, want 409 BACKUP_RUNNING", second.Code, second.Body.String())
	}
	if got := backupFiles(t, f.dir); len(got) != 1 {
		t.Errorf("backup dir during the first backup = %v, want only the seeded file", got)
	}
	close(release)
	wg.Wait()
	if first.Code != http.StatusOK {
		t.Fatalf("first POST /backup = %d, want 200; body: %s", first.Code, first.Body.String())
	}
	admin.SetBackupHoldForTest(f.api, nil)
	// A second timestamp-named file needs a later second; the guard is what is under test.
	if w := doRequest(t, f.api, http.MethodPost, "/backup", f.owner, nil); w.Code == http.StatusConflict {
		t.Errorf("POST /backup after the first finished = 409, want the guard released")
	}
}

// Two backups in the same second get distinct files: the second takes a "_N"
// suffix rather than failing or replacing the first.
func TestFreeBackupPath_SameSecondGetsDistinctNames(t *testing.T) {
	dir := t.TempDir()
	seen := map[string]bool{}
	for i := range 3 {
		p, err := admin.FreeBackupPathForTest(dir, "chatserver_20261023_120000")
		if err != nil {
			t.Fatalf("take %d: %v", i, err)
		}
		if seen[p] {
			t.Fatalf("take %d reused %s", i, p)
		}
		seen[p] = true
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"chatserver_20261023_120000.db", "chatserver_20261023_120000_2.db", "chatserver_20261023_120000_3.db"}
	got := backupFiles(t, dir)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}
}

// Two real creates back to back both succeed and leave two files.
func TestManageBackups_TwoCreatesInOneSecond(t *testing.T) {
	f := newBackupsPermFixture(t)
	for range 2 {
		if w := doRequest(t, f.api, http.MethodPost, "/backup", f.owner, nil); w.Code != http.StatusOK {
			t.Fatalf("POST /backup = %d; body: %s", w.Code, w.Body.String())
		}
	}
	if got := backupFiles(t, f.dir); len(got) != 3 { // the seeded file and two new ones
		t.Errorf("backup dir = %v, want the seeded file and two new backups", got)
	}
}

// What a MANAGE_BACKUPS-only principal gets from the perimeter: the user list
// (accepted: perimeter-level read), and nothing that changes a member.
func TestManageBackupsAlone_PerimeterSurface(t *testing.T) {
	f := newBackupsPermFixture(t)
	if w := doRequest(t, f.api, http.MethodGet, "/users", f.holder, nil); w.Code != http.StatusOK {
		t.Errorf("GET /users = %d, want 200 (perimeter read); body: %s", w.Code, w.Body.String())
	}
	target, _ := createRoleUser(t, f.database, 23, "Plain", permissions.ReadMessages, 10, "someone")
	id := strconv.FormatInt(target, 10)
	if w := doRequest(t, f.api, http.MethodPatch, "/users/"+id, f.holder, map[string]any{"banned": true}); w.Code != http.StatusForbidden {
		t.Errorf("PATCH banned = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, f.api, http.MethodPut, "/users/"+id+"/roles/3", f.holder, nil); w.Code != http.StatusForbidden {
		t.Errorf("PUT role = %d, want 403; body: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, f.api, http.MethodDelete, "/users/"+id+"/sessions", f.holder, nil); w.Code != http.StatusForbidden {
		t.Errorf("DELETE sessions = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}
