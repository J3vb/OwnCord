package admin_test

import (
	"net/http"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// TestNewAdminAPI_IndependentInstances: backup paths and the owner-only route
// list used to be package globals, so two admin APIs built in one process
// shared both. Each API now keeps its own: a backup taken through one lands
// only in its directory, and each lists exactly the owner-only routes it
// registered, not the sum of every API built so far.
func TestNewAdminAPI_IndependentInstances(t *testing.T) {
	dirA, dirB := filepath.Join(t.TempDir(), "a"), filepath.Join(t.TempDir(), "b")
	dbA, dbB := openAdminTestDB(t), openAdminTestDB(t)
	apiA := admin.NewAdminAPI(dbA, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(dbA),
		admin.SetupOptions{BackupDir: dirA})
	apiB := admin.NewAdminAPI(dbB, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(dbB),
		admin.SetupOptions{BackupDir: dirB})
	tokenA, tokenB := createAdminUser(t, dbA), createAdminUser(t, dbB)

	if w := doRequest(t, apiA, http.MethodPost, "/backup", tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("POST /backup on A = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if got := listBackupFiles(t, dirA); len(got) != 1 {
		t.Errorf("A's backup dir holds %v, want exactly the one backup A took", got)
	}
	if got := listBackupFiles(t, dirB); len(got) != 0 {
		t.Errorf("B's backup dir holds %v after a backup through A, want none", got)
	}

	// B, built after A, still writes to its own directory only.
	if w := doRequest(t, apiB, http.MethodPost, "/backup", tokenB, nil); w.Code != http.StatusOK {
		t.Fatalf("POST /backup on B = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if got := listBackupFiles(t, dirB); len(got) != 1 {
		t.Errorf("B's backup dir holds %v, want exactly the one backup B took", got)
	}
	if got := listBackupFiles(t, dirA); len(got) != 1 {
		t.Errorf("A's backup dir holds %v after a backup through B, want still one", got)
	}

	// Each API lists only its own owner-only and gated routes: building B must
	// not have grown or reset A's list.
	if admin.SharesOwnerOnlyRegistryForTest(apiA, apiB) {
		t.Fatal("A and B record owner-only routes in one shared registry")
	}
	if got, want := sortedOwnerOnlyRoutes(admin.OwnerOnlyRoutesForTest(apiA)), sortedOwnerOnlyRoutes(expectedOwnerOnlyRoutes); !reflect.DeepEqual(got, want) {
		t.Errorf("A owner-only routes = %+v, want %+v", got, want)
	}
	routesA, routesB := admin.GatedRoutesForTest(apiA), admin.GatedRoutesForTest(apiB)
	want := sortedGatedRoutes(expectedGatedRoutes)
	if got := sortedGatedRoutes(routesA); !reflect.DeepEqual(got, want) {
		t.Errorf("A gated routes = %+v, want %+v", got, want)
	}
	if got := sortedGatedRoutes(routesB); !reflect.DeepEqual(got, want) {
		t.Errorf("B gated routes = %+v, want %+v", got, want)
	}

	// The accessor hands out a copy, so a caller cannot edit the API's list.
	routesA[0] = admin.GatedRoute{Method: "X", Pattern: "/tampered", Gate: "none"}
	if got := sortedGatedRoutes(admin.GatedRoutesForTest(apiA)); !reflect.DeepEqual(got, want) {
		t.Errorf("A gated routes changed through the accessor's slice: %+v", got)
	}
}

// TestNewAdminAPI_EmptyBackupDirKeepsDefault: without SetupOptions.BackupDir
// the handlers keep the historical default, data/backups, resolved to an
// absolute path against the working directory when the API is built.
func TestNewAdminAPI_EmptyBackupDirKeepsDefault(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	if w := doRequest(t, handler, http.MethodPost, "/backup", token, nil); w.Code != http.StatusOK {
		t.Fatalf("POST /backup = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	want := filepath.Join(tmpDir, "data", "backups")
	if got := listBackupFiles(t, want); len(got) != 1 {
		t.Errorf("default backup dir %s holds %v, want the one backup", want, got)
	}

	// The default is absolute, so a later chdir cannot move it.
	if got := admin.ResolveBackupDir(""); !filepath.IsAbs(got) || filepath.Base(got) != "backups" ||
		filepath.Base(filepath.Dir(got)) != "data" {
		t.Errorf("ResolveBackupDir(\"\") = %q, want an absolute .../data/backups", got)
	}
	if got := admin.ResolveBackupDir("custom"); !filepath.IsAbs(got) || filepath.Base(got) != "custom" {
		t.Errorf("ResolveBackupDir(\"custom\") = %q, want an absolute path ending in custom", got)
	}
}
