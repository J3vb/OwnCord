package admin_test

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db/audittest"
)

type restartableHub struct {
	managedHub
	accept bool
	calls  *atomic.Int32
}

func (h restartableHub) RestartLiveKit() bool {
	h.calls.Add(1)
	return h.accept
}

// POST /system/livekit/restart wakes a supervisor that stopped restarting and
// audits the press; with nothing to restart, or an external LiveKit, it is 409
// and writes no audit row.
func TestAdminAPI_RestartLiveKit(t *testing.T) {
	database := openAdminTestDB(t)
	ownerToken := createAdminUser(t, database)
	rec := audittest.Install(t, database)

	serve := func(hub admin.HubBroadcaster) http.Handler {
		return admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database), admin.SetupOptions{})
	}

	var calls atomic.Int32
	accepted := serve(restartableHub{managedHub{&mockHub{}, true}, true, &calls})
	w := doRequest(t, accepted, http.MethodPost, "/system/livekit/restart", ownerToken, nil)
	if w.Code != http.StatusAccepted || !strings.Contains(w.Body.String(), `"restarting":true`) {
		t.Fatalf("gave up: %d %s, want 202 restarting", w.Code, w.Body.String())
	}
	if entry := rec.Wait(t, "voice_server_restart_requested"); entry.Detail != "manual" {
		t.Errorf("audit detail = %q, want manual", entry.Detail)
	}

	for name, hub := range map[string]admin.HubBroadcaster{
		"running":  restartableHub{managedHub{&mockHub{}, true}, false, &calls},
		"external": restartableHub{managedHub{&mockHub{}, false}, true, &calls},
		"no voice": &mockHub{},
	} {
		w := doRequest(t, serve(hub), http.MethodPost, "/system/livekit/restart", ownerToken, nil)
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "CONFLICT") {
			t.Errorf("%s: %d %s, want 409 CONFLICT", name, w.Code, w.Body.String())
		}
	}
	if n := calls.Load(); n != 2 {
		t.Errorf("RestartLiveKit called %d times, want 2 (an external LiveKit is never asked)", n)
	}
	audits := 0
	for _, e := range rec.Entries() {
		if e.Action == "voice_server_restart_requested" {
			audits++
		}
	}
	if audits != 1 {
		t.Errorf("%d restart audit rows, want 1", audits)
	}

	_, modToken := createRoleUser(t, database, 10, "Moderator", moderatorMask, 60, "lkrestartmod")
	if w := doRequest(t, accepted, http.MethodPost, "/system/livekit/restart", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator: %d, want 403", w.Code)
	}
}
