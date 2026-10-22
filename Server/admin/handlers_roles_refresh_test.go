package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── Role fan-out (WP 4.4b) ──────────────────────────────────────────────────

// probeInvalidator records invalidations in one shared log (with the hub's
// enqueues) and can run a hook on each, e.g. to cancel the request.
type probeInvalidator struct {
	log  *[]string
	hook func()
}

func (p *probeInvalidator) InvalidateUser(int64) {
	*p.log = append(*p.log, "invalidate")
	if p.hook != nil {
		p.hook()
	}
}

func (p *probeInvalidator) InvalidateAll() {
	*p.log = append(*p.log, "invalidate")
	if p.hook != nil {
		p.hook()
	}
}

// roleMutations are the four routes that invalidate and then enqueue, as
// (name, method, path, body, setup) rows.
type roleMutation struct {
	name, method, path string
	body               any
	status             int  // expected response status
	invalidates        bool // the route invalidates the permission cache
	revokes            int  // users released before the request answers
}

func roleMutations(t *testing.T, database *db.DB) []roleMutation {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), "fanout-target", "$2a$12$placeholder", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// A role with one holder, for the delete row.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'fanout-del', 0, 10, 0)`); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	if _, err := database.CreateUser(context.Background(), "fanout-deleted", "$2a$12$placeholder", 9); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// A holder that stays in role 3, so the role edit has someone to invalidate.
	if _, err := database.CreateUser(context.Background(), "fanout-holder", "$2a$12$placeholder", 3); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return []roleMutation{
		{"user role change", http.MethodPatch, "/users/" + itoa(uid), map[string]any{"role_id": 2}, http.StatusOK, true, 1},
		{"role permission edit", http.MethodPatch, "/roles/3", map[string]any{"permissions": permissions.ReadMessages}, http.StatusOK, true, 0},
		{"role reorder", http.MethodPatch, "/roles/reorder", map[string]any{"role_ids": []int64{2, 3, 9}}, http.StatusOK, true, 0},
		{"role create", http.MethodPost, "/roles", map[string]any{"name": "Fanout-New", "position": 30}, http.StatusCreated, false, 0},
		{"role delete", http.MethodDelete, "/roles/9", nil, http.StatusNoContent, true, 1},
	}
}

// The permission cache is invalidated before the single enqueue, on every route
// that changes a role.
func TestAdminAPI_RoleChange_InvalidatesBeforeEnqueue(t *testing.T) {
	database := openAdminTestDB(t)
	token := createAdminUser(t, database)
	for _, m := range roleMutations(t, database) {
		t.Run(m.name, func(t *testing.T) {
			var log []string
			hub := &mockHub{onEnqueue: func(ws.RoleRefresh) { log = append(log, "enqueue") }}
			inv := &probeInvalidator{log: &log}
			handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv, newTestServicesFor(database, hub, inv))
			if w := doRequest(t, handler, m.method, m.path, token, m.body); w.Code != m.status {
				t.Fatalf("status = %d, want %d; body: %s", w.Code, m.status, w.Body.String())
			}
			if len(hub.roleRefreshes) != 1 {
				t.Fatalf("enqueues = %d, want exactly one", len(hub.roleRefreshes))
			}
			if len(hub.revokedIDs) != m.revokes {
				t.Errorf("users released before answering = %v, want %d", hub.revokedIDs, m.revokes)
			}
			if !m.invalidates {
				return
			}
			if n := len(log); n < 2 || log[n-1] != "enqueue" || !slices.Contains(log[:n-1], "invalidate") {
				t.Errorf("order = %v, want the invalidation(s) first and the enqueue last", log)
			}
			if i := slices.Index(log, "enqueue"); slices.Contains(log[i:], "invalidate") {
				t.Errorf("order = %v: an invalidation came after the enqueue", log)
			}
		})
	}
}

// Nothing after the commit reads the request context: an aborted request still
// enqueues the whole fan-out (OC-0170's intent, now that the worker re-reads
// the role list).
func TestAdminAPI_RoleRoutes_FanOutSurvivesRequestCancel(t *testing.T) {
	database := openAdminTestDB(t)
	token := createAdminUser(t, database)
	for _, m := range roleMutations(t, database) {
		if !m.invalidates {
			continue // nothing runs after the commit to abort the request at
		}
		t.Run(m.name, func(t *testing.T) {
			var log []string
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			hub := &mockHub{}
			// The invalidation runs after the commit: abort the request there.
			inv := &probeInvalidator{log: &log, hook: cancel}
			handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv, newTestServicesFor(database, hub, inv))
			body, err := json.Marshal(m.body)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			req := httptest.NewRequest(m.method, m.path, bytes.NewReader(body)).WithContext(ctx)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(httptest.NewRecorder(), req)

			if ctx.Err() == nil {
				t.Fatal("the request was never aborted; the hook did not run")
			}
			if len(hub.roleRefreshes) != 1 {
				t.Fatalf("enqueues after an aborted request = %d, want 1", len(hub.roleRefreshes))
			}
		})
	}
}

// erroringMembersStore fails exactly the role-member lookup.
type erroringMembersStore struct{ service.Store }

func (erroringMembersStore) ListUserIDsByRole(context.Context, int64) ([]int64, error) {
	return nil, context.DeadlineExceeded
}

// When the holder list cannot be read, a permission edit enqueues an
// all-connected refresh (and the cache is dropped wholesale); nothing names
// holders it does not know.
func TestAdminAPI_PatchRole_UnreadableHoldersRefreshesAllConnected(t *testing.T) {
	database := openAdminTestDB(t)
	createUserWithRole(t, database, "holder", 3)
	hub := &mockHub{}
	inv := &mockPermInvalidator{}
	roles := service.NewRoleService(erroringMembersStore{Store: database},
		observeInvalidations(service.NewPermissionService(database, permissions.NewChecker(database)), inv))
	roles.SetPermissionNotifier(hub)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv, svcWithRoles(database, roles))
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"permissions": permissions.ReadMessages, "name": "Renamed",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}
	if inv.invalidateAllN == 0 {
		t.Error("the unreadable holder list must drop every cached mask")
	}
	if len(hub.roleRefreshes) != 1 {
		t.Fatalf("enqueues = %d, want 1", len(hub.roleRefreshes))
	}
	got := hub.roleRefreshes[0]
	if !got.AllConnected || len(got.Visibility) != 0 || len(got.MemberUpdate) != 0 || !got.Roles {
		t.Errorf("enqueue = %+v, want AllConnected and Roles with no named users", got)
	}
}

// The core of 4.4b: the handler commits and answers while the worker has not
// finished (here: is held at the start of its round); the round runs once it is
// released, and Stop joins it.
func TestAdminAPI_PatchUserRole_HandlerReturnsBeforeFanOut(t *testing.T) {
	database := openAdminTestDB(t)
	hub, err := ws.NewHub(ws.HubOptions{
		DB: database, Limiter: auth.NewRateLimiter(),
		Settings:       service.NewSettingsService(database),
		Readers:        ws.DBReaders(database),
		Voice:          service.NewVoiceService(database),
		Presence:       service.NewUserService(database),
		ChannelPrivacy: service.NewChannelPrivacyService(database),
		Auth:           service.NewSessionService(database),
	})
	if err != nil {
		t.Fatalf("ws.NewHub: %v", err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	rounds := 0
	hub.SetRoleRefreshGateForTest(func() {
		rounds++
		close(entered)
		<-release
	})
	go hub.Run()
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		hub.Stop()
		<-hub.Done()
	})
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServicesFor(database, hub, nil))
	token := createAdminUser(t, database)
	uid, err := database.CreateUser(context.Background(), "gated-target", "$2a$12$placeholder", 3)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(uid), token, map[string]any{"role_id": 2})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}
	// The response is out while the round has not completed.
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the worker never started the round the handler enqueued")
	}
	select {
	case <-hub.Done():
		t.Fatal("hub finished while the fan-out was still held")
	default:
	}
	user, err := database.GetUserByID(context.Background(), uid)
	if err != nil || user == nil || user.RoleID != 2 {
		t.Fatalf("role change not committed when the handler returned: %+v %v", user, err)
	}
	close(release)
	hub.Stop()
	select {
	case <-hub.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("Stop did not join the released worker")
	}
	if rounds != 1 {
		t.Errorf("rounds = %d, want 1", rounds)
	}
}

// A role delete with many holders releases the first 32 directly and enqueues
// every holder for the worker.
func TestAdminAPI_DeleteRole_ManyHoldersReleasesFirst32(t *testing.T) {
	database := openAdminTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx,
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (9, 'many-holders', 0, 10, 0)`); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	const holders = 40
	for i := range holders {
		if _, err := database.CreateUser(ctx, "many-holder-"+itoa(int64(i)), "$2a$12$placeholder", 9); err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
	}
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, &mockPermInvalidator{}, newTestServicesFor(database, hub, &mockPermInvalidator{}))
	token := createAdminUser(t, database)

	if w := doRequest(t, handler, http.MethodDelete, "/roles/9", token, nil); w.Code != http.StatusNoContent {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}
	if len(hub.revokedIDs) != 32 {
		t.Errorf("members released directly = %d, want exactly 32", len(hub.revokedIDs))
	}
	if len(hub.roleRefreshes) != 1 {
		t.Fatalf("enqueues = %d, want 1", len(hub.roleRefreshes))
	}
	got := hub.roleRefreshes[0]
	if len(got.Visibility) != holders || len(got.MemberUpdate) != holders {
		t.Errorf("enqueue names %d/%d members, want all %d", len(got.Visibility), len(got.MemberUpdate), holders)
	}
	for _, id := range hub.revokedIDs {
		if !slices.Contains(got.Visibility, id) {
			t.Errorf("member %d was released directly but not enqueued", id)
		}
	}
}
