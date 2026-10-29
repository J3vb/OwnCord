package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// WP 8.4d: behaviour of the seven owner-type bits beyond the gate itself
// (TestGatedRoutes walks every route's gate): the own-tokens scope of
// MANAGE_TOKENS, the rank rules of ISSUE_RECOVERY and ERASE_ACCOUNTS, and the
// re-check a download link and a log stream make after the bit is removed.

const ownerTypeBackup = "chatserver_20260901_100000.db"

type ownerTypeFixture struct {
	api      *admin.AdminAPI
	database *db.DB
	dir      string
	owner    string
}

func newOwnerTypeFixture(t *testing.T) ownerTypeFixture {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ownerTypeBackup), []byte("backup bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := openAdminTestDB(t)
	api := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, admin.NewRingBuffer(8), nil, nil, newTestServices(database),
		admin.SetupOptions{BackupDir: dir})
	_, owner := createRoleUser(t, database, permissions.OwnerRoleID, "Owner", permissions.AllPerms, 100, "ownertypeowner")
	return ownerTypeFixture{api: api, database: database, dir: dir, owner: owner}
}

type tokenRow struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Label    string `json:"label"`
}

func listTokens(t *testing.T, f ownerTypeFixture, token string) []tokenRow {
	t.Helper()
	w := doRequest(t, f.api, http.MethodGet, "/tokens", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /tokens = %d; body: %s", w.Code, w.Body.String())
	}
	var rows []tokenRow
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode tokens: %v", err)
	}
	return rows
}

// A MANAGE_TOKENS holder who is not the owner lists only the tokens bound to
// them, mints only for themself and cannot revoke anyone else's; the owner is
// unchanged.
func TestManageTokens_HolderIsConfinedToOwnTokens(t *testing.T) {
	f := newOwnerTypeFixture(t)
	_, holder := createRoleUser(t, f.database, 20, "Token holders", permissions.ManageTokens, 50, "tokenholder")
	createRoleUser(t, f.database, 21, "Others", permissions.ReadMessages, 40, "tokenother")

	// Seed one token for the other member and one for the owner, via the owner.
	w := doRequest(t, f.api, http.MethodPost, "/tokens", f.owner, map[string]any{"label": "other-bot", "username": "tokenother"})
	if w.Code != http.StatusCreated {
		t.Fatalf("owner mint for other = %d; body: %s", w.Code, w.Body.String())
	}
	var otherTok struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &otherTok)
	if w = doRequest(t, f.api, http.MethodPost, "/tokens", f.owner, map[string]any{"label": "owner-bot"}); w.Code != http.StatusCreated {
		t.Fatalf("owner mint for self = %d; body: %s", w.Code, w.Body.String())
	}

	// Create: empty username and the holder's own name bind to the holder.
	for _, body := range []map[string]any{{"label": "mine-empty"}, {"label": "mine-named", "username": "tokenholder"}} {
		w = doRequest(t, f.api, http.MethodPost, "/tokens", holder, body)
		var resp struct {
			ID   int64  `json:"id"`
			User string `json:"user"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if w.Code != http.StatusCreated || resp.User != "tokenholder" {
			t.Fatalf("holder mint %v = %d user %q; body: %s", body, w.Code, resp.User, w.Body.String())
		}
	}
	// Any other username, the owner's included, is a 403 that mints nothing.
	for _, name := range []string{"tokenother", "ownertypeowner", "nobody-at-all"} {
		if w = doRequest(t, f.api, http.MethodPost, "/tokens", holder, map[string]any{"label": "stolen", "username": name}); w.Code != http.StatusForbidden {
			t.Errorf("holder mint for %q = %d, want 403; body: %s", name, w.Code, w.Body.String())
		}
	}

	// List: the holder sees exactly their two; the owner sees all four.
	own := listTokens(t, f, holder)
	if len(own) != 2 {
		t.Fatalf("holder lists %d tokens (%+v), want only the 2 bound to them", len(own), own)
	}
	for _, r := range own {
		if r.Username != "tokenholder" {
			t.Errorf("holder's list leaked %+v", r)
		}
	}
	if all := listTokens(t, f, f.owner); len(all) != 4 {
		t.Errorf("owner lists %d tokens, want all 4", len(all))
	}

	// Revoke: someone else's token is 404, the same as an unknown id, and stays active.
	for name, id := range map[string]int64{"another member's": otherTok.ID, "an unknown": 99999} {
		if w = doRequest(t, f.api, http.MethodDelete, "/tokens/"+itoa(id), holder, nil); w.Code != http.StatusNotFound {
			t.Errorf("holder revoking %s token = %d, want 404; body: %s", name, w.Code, w.Body.String())
		}
	}
	for _, r := range listTokens(t, f, f.owner) {
		if r.ID == otherTok.ID && r.Label != "other-bot" {
			t.Errorf("token %d changed: %+v", r.ID, r)
		}
	}
	rows := listTokens(t, f, holder)
	if w = doRequest(t, f.api, http.MethodDelete, "/tokens/"+itoa(rows[0].ID), holder, nil); w.Code != http.StatusNoContent {
		t.Errorf("holder revoking own token = %d, want 204; body: %s", w.Code, w.Body.String())
	}
	// The owner revokes anyone's.
	if w = doRequest(t, f.api, http.MethodDelete, "/tokens/"+itoa(otherTok.ID), f.owner, nil); w.Code != http.StatusNoContent {
		t.Errorf("owner revoking another member's token = %d, want 204", w.Code)
	}
}

// An ISSUE_RECOVERY holder issues to a lower-ranked member only: an equal or
// higher rank and the owner are 403, and nothing is stored.
func TestIssueRecovery_HolderRankRule(t *testing.T) {
	ctx := context.Background()
	f := newOwnerTypeFixture(t)
	_, holder := createRoleUser(t, f.database, 20, "Recoverers", permissions.IssueRecovery, 60, "recoverer")
	low, _ := createRoleUser(t, f.database, 21, "Lower", permissions.ReadMessages, 40, "lowermember")
	peer, _ := createRoleUser(t, f.database, 22, "Peers", permissions.ReadMessages, 60, "peermember")
	high, _ := createRoleUser(t, f.database, 23, "Higher", permissions.ReadMessages, 70, "highermember")
	ownerUser, err := f.database.GetUserByUsername(ctx, "ownertypeowner")
	if err != nil || ownerUser == nil {
		t.Fatalf("owner user: %v", err)
	}
	body := map[string]string{"verification": "in_person"}

	for name, target := range map[string]int64{"an equal rank": peer, "a higher rank": high, "the owner": ownerUser.ID} {
		if w := doRequest(t, f.api, http.MethodPost, "/users/"+itoa(target)+"/recovery-credential", holder, body); w.Code != http.StatusForbidden {
			t.Errorf("holder issuing to %s = %d, want 403; body: %s", name, w.Code, w.Body.String())
		}
		if a, _ := f.database.GetRecoveryAssist(ctx, target); a != nil {
			t.Errorf("a refused issuance to %s stored a credential", name)
		}
	}
	w := doRequest(t, f.api, http.MethodPost, "/users/"+itoa(low)+"/recovery-credential", holder, body)
	if w.Code != http.StatusCreated {
		t.Fatalf("holder issuing to a lower rank = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	// The owner still issues to a higher-ranked member.
	if w = doRequest(t, f.api, http.MethodPost, "/users/"+itoa(high)+"/recovery-credential", f.owner, body); w.Code != http.StatusCreated {
		t.Errorf("owner issuing to a higher rank = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}

// An ERASE_ACCOUNTS holder without ADMINISTRATOR erases a lower-ranked member
// and is refused at or above their own rank.
func TestEraseAccounts_HolderWithoutAdministrator(t *testing.T) {
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (20, 'Erasers', ?, 60, 0), (21, 'Peers', ?, 60, 0)`,
		permissions.EraseAccounts, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	_, holder := sessionFor(t, database, "eraser", 20)
	peer, _ := sessionFor(t, database, "erase-peer", 21)
	owner, _ := sessionFor(t, database, "erase-the-owner", 1)
	low, _ := sessionFor(t, database, "erase-low", 4)

	for name, target := range map[string]int64{"an equal rank": peer, "the owner": owner} {
		if w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(target), holder, nil); w.Code != http.StatusForbidden {
			t.Errorf("holder erasing %s = %d, want 403; body: %s", name, w.Code, w.Body.String())
		}
		if u, _ := database.GetUserByID(context.Background(), target); u == nil {
			t.Errorf("a refused erasure removed %s", name)
		}
	}
	if w := doRequest(t, handler, http.MethodDelete, "/users/"+itoa(low), holder, nil); w.Code != http.StatusNoContent {
		t.Fatalf("holder erasing a lower rank = %d, want 204; body: %s", w.Code, w.Body.String())
	}
	if u, _ := database.GetUserByID(context.Background(), low); u != nil {
		t.Error("the lower-ranked member survived")
	}
}

// RESTORE_BACKUPS opens delete, list and the archive link; ManageBackups alone
// does not open delete.
func TestRestoreBackups_HolderDeletesAndListsAndLinks(t *testing.T) {
	f := newOwnerTypeFixture(t)
	_, holder := createRoleUser(t, f.database, 20, "Restorers", permissions.RestoreBackups, 50, "restorer")
	_, keeper := createRoleUser(t, f.database, 21, "Keepers", permissions.ManageBackups, 50, "keeper")

	if w := doRequest(t, f.api, http.MethodGet, "/backups", holder, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), ownerTypeBackup) {
		t.Fatalf("restorer GET /backups = %d; body: %s", w.Code, w.Body.String())
	}
	// But it does not create one, or link a single backup.
	for _, rt := range []struct{ method, path string }{
		{http.MethodPost, "/backup"},
		{http.MethodPost, "/backups/" + ownerTypeBackup + "/link"},
	} {
		if w := doRequest(t, f.api, rt.method, rt.path, holder, nil); w.Code != http.StatusForbidden {
			t.Errorf("restorer %s %s = %d, want 403", rt.method, rt.path, w.Code)
		}
	}
	if w := doRequest(t, f.api, http.MethodPost, "/archive/link", holder, map[string]any{}); w.Code != http.StatusOK {
		t.Errorf("restorer POST /archive/link = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if w := doRequest(t, f.api, http.MethodDelete, "/backups/"+ownerTypeBackup, keeper, nil); w.Code != http.StatusForbidden {
		t.Errorf("MANAGE_BACKUPS holder deleting a backup = %d, want 403", w.Code)
	}
	if w := doRequest(t, f.api, http.MethodDelete, "/backups/"+ownerTypeBackup, holder, nil); w.Code != http.StatusNoContent {
		t.Fatalf("restorer deleting a backup = %d, want 204; body: %s", w.Code, w.Body.String())
	}
	if got := backupFiles(t, f.dir); len(got) != 0 {
		t.Errorf("backup directory after the delete = %v, want empty", got)
	}
}

// The archive link is re-checked when it is opened, like a backup link: a
// RESTORE_BACKUPS holder who lost the bit gets nothing, and an Administrator
// without the bit never could.
func TestRestoreBackups_ArchiveLinkRevalidatedOnRedeem(t *testing.T) {
	issue := func(t *testing.T, f ownerTypeFixture, token string) string {
		t.Helper()
		w := doRequest(t, f.api, http.MethodPost, "/archive/link", token, map[string]any{})
		if w.Code != http.StatusOK {
			t.Fatalf("POST /archive/link = %d; body: %s", w.Code, w.Body.String())
		}
		return linkPath(t, w.Body.Bytes())
	}
	t.Run("bit removed from the role", func(t *testing.T) {
		f := newOwnerTypeFixture(t)
		_, holder := createRoleUser(t, f.database, 20, "Restorers", permissions.RestoreBackups, 50, "restorer")
		path := issue(t, f, holder)
		if _, err := f.database.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = 20`, permissions.ReadMessages); err != nil {
			t.Fatal(err)
		}
		if w := openLinkNoAuth(f.api, path); w.Code != http.StatusForbidden {
			t.Errorf("archive link after the bit was removed = %d, want 403", w.Code)
		}
	})
	t.Run("holder redeems", func(t *testing.T) {
		f := newOwnerTypeFixture(t)
		_, holder := createRoleUser(t, f.database, 20, "Restorers", permissions.RestoreBackups, 50, "restorer")
		// The re-check passes; the fixture has no config.yaml to zip, so the
		// archive itself answers 500, which is past the link gate.
		if w := openLinkNoAuth(f.api, issue(t, f, holder)); w.Code == http.StatusForbidden {
			t.Errorf("archive link of a live holder = 403, want it redeemed; body: %.200s", w.Body.String())
		}
	})
	t.Run("a backup link does not open the archive", func(t *testing.T) {
		f := newOwnerTypeFixture(t)
		_, keeper := createRoleUser(t, f.database, 21, "Keepers", permissions.ManageBackups, 50, "keeper")
		w := doRequest(t, f.api, http.MethodPost, "/backups/"+ownerTypeBackup+"/link", keeper, map[string]any{})
		tok := mustQueryToken(t, linkPath(t, w.Body.Bytes()))
		if dl := openLinkNoAuth(f.api, "/admin/api/archive/download?token="+tok); dl.Code != http.StatusForbidden {
			t.Errorf("backup token on the archive route = %d, want 403", dl.Code)
		}
	})
}

// The log stream re-checks VIEW_DIAGNOSTICS before it writes: a holder whose
// bit was removed after the ticket was issued is refused when the stream
// opens, a live holder streams, and an Administrator needs no bit.
func TestViewDiagnostics_LogStreamRevalidated(t *testing.T) {
	stream := func(t *testing.T, f ownerTypeFixture, token string, mutate func()) int {
		t.Helper()
		w := doRequest(t, f.api, http.MethodPost, "/logs/ticket", token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("POST /logs/ticket = %d; body: %s", w.Code, w.Body.String())
		}
		var payload struct {
			Ticket string `json:"ticket"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &payload)
		if mutate != nil {
			mutate()
		}
		srv := httptest.NewServer(f.api)
		defer srv.Close()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/logs/stream?ticket="+payload.Ticket, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("stream request: %v", err)
		}
		defer resp.Body.Close() //nolint:errcheck
		return resp.StatusCode
	}
	t.Run("live holder streams", func(t *testing.T) {
		f := newOwnerTypeFixture(t)
		_, holder := createRoleUser(t, f.database, 20, "Diagnosers", permissions.ViewDiagnostics, 50, "diagnoser")
		if got := stream(t, f, holder, nil); got != http.StatusOK {
			t.Errorf("stream status = %d, want 200", got)
		}
	})
	t.Run("bit removed after the ticket", func(t *testing.T) {
		f := newOwnerTypeFixture(t)
		_, holder := createRoleUser(t, f.database, 20, "Diagnosers", permissions.ViewDiagnostics, 50, "diagnoser")
		got := stream(t, f, holder, func() {
			if _, err := f.database.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = 20`, permissions.ReadMessages|permissions.KickMembers); err != nil {
				t.Fatal(err)
			}
		})
		if got != http.StatusForbidden {
			t.Errorf("stream status after the bit was removed = %d, want 403", got)
		}
	})
	t.Run("administrator without the bit streams", func(t *testing.T) {
		f := newOwnerTypeFixture(t)
		_, adm := createRoleUser(t, f.database, 22, "Super", permissions.Administrator, 90, "diagsuper")
		if got := stream(t, f, adm, nil); got != http.StatusOK {
			t.Errorf("stream status = %d, want 200", got)
		}
	})
}

// A non-owner's use of an owner-type action leaves an audit row naming them.
func TestOwnerTypeActions_HolderUseIsAudited(t *testing.T) {
	f := newOwnerTypeFixture(t)
	holderID, holder := createRoleUser(t, f.database, 20, "Restorers", permissions.RestoreBackups|permissions.ManageTokens, 50, "auditedholder")
	rec := audittest.Install(t, f.database)

	if w := doRequest(t, f.api, http.MethodPost, "/archive/link", holder, map[string]any{}); w.Code != http.StatusOK {
		t.Fatalf("POST /archive/link = %d", w.Code)
	}
	if e := rec.Wait(t, "archive_link"); e.ActorID != holderID {
		t.Errorf("archive_link actor = %d, want the holder %d", e.ActorID, holderID)
	}
	if w := doRequest(t, f.api, http.MethodDelete, "/backups/"+ownerTypeBackup, holder, nil); w.Code != http.StatusNoContent {
		t.Fatalf("DELETE backup = %d", w.Code)
	}
	if e := rec.Wait(t, "backup_delete"); e.ActorID != holderID {
		t.Errorf("backup_delete actor = %d, want the holder %d", e.ActorID, holderID)
	}
	if w := doRequest(t, f.api, http.MethodPost, "/tokens", holder, map[string]any{"label": "audited"}); w.Code != http.StatusCreated {
		t.Fatalf("POST /tokens = %d", w.Code)
	}
	if e := rec.Wait(t, "api_token_create"); e.ActorID != holderID {
		t.Errorf("api_token_create actor = %d, want the holder %d", e.ActorID, holderID)
	}
}
