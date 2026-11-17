package admin_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws/hubsettings"
)

// dbSettingReader reads settings rows straight from the database, as the hub's reader does. Once armed,
// its next server_name read reports on entered and then waits for release, holding a refresh in flight.
type dbSettingReader struct {
	database *db.DB
	armed    atomic.Bool
	entered  chan struct{}
	release  chan struct{}
}

func (r *dbSettingReader) Setting(ctx context.Context, key string) (string, error) {
	v, err := r.database.GetSetting(ctx, key)
	if key == "server_name" && r.armed.CompareAndSwap(true, false) {
		r.entered <- struct{}{}
		select {
		case <-r.release:
		case <-ctx.Done():
		}
	}
	return v, err
}

// cacheHub is a mockHub that carries the hub's real settings cache, so a test can read what the next
// auth_ok would carry after an admin write.
type cacheHub struct {
	*mockHub
	reader *dbSettingReader
	cache  hubsettings.Cache
}

func newCacheHub(database *db.DB) *cacheHub {
	reader := &dbSettingReader{database: database, entered: make(chan struct{}), release: make(chan struct{})}
	return &cacheHub{mockHub: &mockHub{}, reader: reader, cache: hubsettings.New(reader, nil, hubsettings.UploadPolicy{})}
}

func (h *cacheHub) ExpireSettingsCache() {
	h.cache.Expire()
}

// A rename in the admin panel reaches the next sign-in, not one up to the cache's lifetime later.
func TestPatchSettings_ServerNameAndMotd_ReachNextSignIn(t *testing.T) {
	ctx := t.Context()
	database := openAdminTestDB(t)
	hub := newCacheHub(database)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "renamer")

	// A sign-in before the rename fills the cache with the old values.
	oldName, _ := hub.cache.Get(ctx)

	w := doRequest(t, handler, http.MethodPatch, "/settings", token, map[string]string{"server_name": "Renamed Place", "motd": "New welcome"})
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH server_name = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	name, motd := hub.cache.Get(ctx)
	if name != "Renamed Place" || motd != "New welcome" {
		t.Errorf("next sign-in got (%q, %q), want (Renamed Place, New welcome); was %q before", name, motd, oldName)
	}

	// The motd alone expires the cache too.
	if w := doRequest(t, handler, http.MethodPatch, "/settings", token, map[string]string{"motd": "Second welcome"}); w.Code != http.StatusOK {
		t.Fatalf("PATCH motd = %d; body: %s", w.Code, w.Body.String())
	}
	if _, motd := hub.cache.Get(ctx); motd != "Second welcome" {
		t.Errorf("motd after a motd-only save = %q, want Second welcome", motd)
	}
}

// A refused save expires nothing: the next sign-in still gets the cached name, even though the row
// changed behind the cache, because nothing was saved.
func TestPatchSettings_RefusedSave_KeepsCache(t *testing.T) {
	ctx := t.Context()
	database := openAdminTestDB(t)
	hub := newCacheHub(database)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "refused")

	cached, _ := hub.cache.Get(ctx)
	if err := database.SetSetting(ctx, "server_name", "Behind The Cache"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	if w := doRequest(t, handler, http.MethodPatch, "/settings", token, map[string]string{"server_name": "   "}); w.Code != http.StatusBadRequest {
		t.Fatalf("PATCH a blank server_name = %d, want 400; body: %s", w.Code, w.Body.String())
	}
	if name, _ := hub.cache.Get(ctx); name != cached {
		t.Errorf("sign-in after a refused save got %q, want the cached %q", name, cached)
	}
}

// A sign-in racing a rename: its refresh read the old name before the save committed and is still in
// flight. Once the PATCH has answered, the next sign-in must see the new name, not the racing refresh's.
func TestPatchSettings_RenameRacingSignIn(t *testing.T) {
	ctx := t.Context()
	database := openAdminTestDB(t)
	hub := newCacheHub(database)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	_, token := createRoleUser(t, database, 20, "ServerAdmin", permissions.ManageServer, 50, "racer")

	// The racing sign-in: its refresh reads the old name, then stalls holding the cache.
	hub.reader.armed.Store(true)
	hub.cache.Expire()
	signedIn := make(chan string, 1)
	go func(ctx context.Context) {
		name, _ := hub.cache.Get(ctx)
		signedIn <- name
	}(ctx)
	<-hub.reader.entered

	// The rename commits, then waits on the cache the stalled refresh holds.
	patched := make(chan int, 1)
	go func(ctx context.Context) {
		req := httptest.NewRequestWithContext(ctx, http.MethodPatch, "/settings", strings.NewReader(`{"server_name":"Raced Place"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		patched <- w.Code
	}(ctx)
	// Wait for the commit. A PATCH that answers first failed before committing (or never waited on the
	// cache); either way its code ends the wait.
	code, answered := 0, false
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
wait:
	for {
		select {
		case code = <-patched:
			answered = true
			if code != http.StatusOK {
				t.Fatalf("PATCH server_name = %d before committing, want 200", code)
			}
			break wait
		case <-deadline:
			t.Fatal("the rename never committed")
		case <-tick.C:
			if v, err := database.GetSetting(ctx, "server_name"); err == nil && v == "Raced Place" {
				break wait
			}
		}
	}

	close(hub.reader.release)
	<-signedIn // whichever name the racing sign-in got, it must not outlive the rename
	if !answered {
		code = <-patched
	}
	if code != http.StatusOK {
		t.Fatalf("PATCH server_name = %d, want 200", code)
	}
	if name, _ := hub.cache.Get(ctx); name != "Raced Place" {
		t.Errorf("sign-in after the rename answered got %q, want Raced Place", name)
	}
}

// The setup wizard's server name and motd reach the owner's first sign-in.
func TestSetupWizard_ServerName_ReachesFirstSignIn(t *testing.T) {
	ctx := t.Context()
	database := openAdminTestDB(t)
	hub := newCacheHub(database)
	t.Cleanup(admin.ResetRestartState)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{})

	// The hub fills its cache when it is built, before setup runs.
	hub.cache.Refresh(ctx)

	rr := doRequest(t, handler, http.MethodPost, "/setup", "", map[string]any{
		"username": "owner",
		"password": "SecurePass123!",
		"wizard":   map[string]any{"server_name": "First Run Place", "motd": "Hello from setup"},
	})
	requireStatus(t, rr, http.StatusCreated)

	name, motd := hub.cache.Get(ctx)
	if name != "First Run Place" || motd != "Hello from setup" {
		t.Errorf("first sign-in got (%q, %q), want (First Run Place, Hello from setup)", name, motd)
	}
}
