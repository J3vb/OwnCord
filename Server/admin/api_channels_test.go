package admin_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
)

// ─── GET /admin/api/channels ──────────────────────────────────────────────────

func TestAdminAPI_ListChannels_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	_, _ = database.AdminCreateChannel(context.Background(), "general", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodGet, "/channels", token, nil)

	expectStatus(t, w, http.StatusOK)

	channels := decodeBody[[]any](t, w)
	if len(channels) != 1 {
		t.Errorf("expected 1 channel, got %d", len(channels))
	}
}

// ─── POST /admin/api/channels ─────────────────────────────────────────────────

func TestAdminAPI_CreateChannel_OK(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]any{
		"name":     "new-channel",
		"type":     "text",
		"category": "General",
		"topic":    "Discussion",
		"position": float64(1),
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	expectStatus(t, w, http.StatusCreated)

	resp := decodeBody[map[string]any](t, w)
	if _, ok := resp["id"]; !ok {
		t.Error("response missing 'id'")
	}
}

func TestAdminAPI_CreateChannel_MissingName(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]any{
		"type": "text",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	expectStatus(t, w, http.StatusBadRequest)
}

// ─── PATCH /admin/api/channels/{id} ──────────────────────────────────────────

func TestAdminAPI_UpdateChannel_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "old", "text", "", "", 0)

	body := map[string]any{
		"name":      "updated",
		"topic":     "new topic",
		"slow_mode": float64(10),
		"position":  float64(2),
		"archived":  false,
	}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	expectStatus(t, w, http.StatusOK)
}

func TestAdminAPI_UpdateChannel_NotFound(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	body := map[string]any{"name": "x"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/99999", token, body)

	expectStatus(t, w, http.StatusNotFound)
}

// ─── DELETE /admin/api/channels/{id} ─────────────────────────────────────────

func TestAdminAPI_DeleteChannel_OK(t *testing.T) {
	database, handler, token := newAdminHarness(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-me", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	expectStatus(t, w, http.StatusNoContent)
}

// Deleting a channel must evict its voice participants BEFORE the DB row goes
// away: the voice_states FK cascade wipes the rows with the channel, after
// which neither CleanupVoiceForChannel nor the stale sweeper can see who was
// in the room — participants would keep their client voice state, voice-topic
// subscription, and LiveKit session forever, with no voice_leave broadcast.
func TestAdminAPI_DeleteChannel_CleansVoiceBeforeDBDelete(t *testing.T) {
	database, hub, handler, token := newAdminHarnessWithHub(t)

	// The minimal admin schema has no voice_states; create it with the real
	// FK cascade — the cascade IS the hazard: it wipes the rows the cleanup
	// needs if the delete runs first.
	if _, err := database.ExecContext(context.Background(), `
		CREATE TABLE voice_states (
			user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			muted      INTEGER NOT NULL DEFAULT 0,
			deafened   INTEGER NOT NULL DEFAULT 0,
			speaking   INTEGER NOT NULL DEFAULT 0,
			joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
			camera     INTEGER NOT NULL DEFAULT 0,
			screenshare INTEGER NOT NULL DEFAULT 0,
			server_muted INTEGER NOT NULL DEFAULT 0,
			server_deafened INTEGER NOT NULL DEFAULT 0
		)`); err != nil {
		t.Fatalf("create voice_states: %v", err)
	}

	chID, _ := database.AdminCreateChannel(context.Background(), "del-voice", "voice", "", "", 0)
	uid := mustCreateUser(t, database, "del-voice-user", "hash", 1)
	if err := database.JoinVoiceChannel(context.Background(), uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	rowsAtCleanup := -1
	hub.onVoiceCleanup = func(channelID int64) {
		states, err := database.GetChannelVoiceStates(context.Background(), channelID)
		if err != nil {
			t.Errorf("GetChannelVoiceStates during cleanup: %v", err)
		}
		rowsAtCleanup = len(states)
	}

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)
	requireStatus(t, w, http.StatusNoContent)

	if len(hub.voiceCleanupIDs) != 1 || hub.voiceCleanupIDs[0] != chID {
		t.Fatalf("CleanupVoiceForChannel calls = %v, want exactly [%d]", hub.voiceCleanupIDs, chID)
	}
	if rowsAtCleanup != 1 {
		t.Errorf("voice_states rows visible at cleanup time = %d, want 1 (cleanup must run before the delete cascade)", rowsAtCleanup)
	}
}

// A voice_join racing the delete window must be refused, not silently create
// a voice_states row the FK cascade then wipes out from under it (OC-0035):
// CleanupVoiceForChannel snapshots participants ONCE, up front, so a join
// that lands after that snapshot but before AdminDeleteChannel's cascade
// leaves the joiner's hub-side voice state and LiveKit session orphaned with
// nothing left to clean it up. handleDeleteChannel must close that window the
// same way the archive path does (handlePatchChannel): persist archived=true
// BEFORE evicting current participants, so voice_join's archived gate
// (ws/voice_join.go) refuses any concurrent join that reads the channel row
// during cleanup.
func TestAdminAPI_DeleteChannel_ArchivesBeforeVoiceCleanup(t *testing.T) {
	database, hub, handler, token := newAdminHarnessWithHub(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-race", "voice", "", "", 0)

	archivedAtCleanup := false
	hub.onVoiceCleanup = func(channelID int64) {
		ch, err := database.GetChannel(context.Background(), channelID)
		if err != nil || ch == nil {
			t.Fatalf("GetChannel during cleanup: %v", err)
		}
		archivedAtCleanup = ch.Archived
	}

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)
	requireStatus(t, w, http.StatusNoContent)

	if !archivedAtCleanup {
		t.Errorf("channel.Archived at CleanupVoiceForChannel time = false, want true — a concurrent voice_join would not be refused by the archived gate")
	}
}

func TestAdminAPI_DeleteChannel_NotFound(t *testing.T) {
	_, handler, token := newAdminHarness(t)

	w := doRequest(t, handler, http.MethodDelete, "/channels/99999", token, nil)

	expectStatus(t, w, http.StatusNotFound)
}

func TestAdminAPI_CreateChannel_BroadcastsChannelCreate(t *testing.T) {
	_, hub, handler, token := newAdminHarnessWithHub(t)

	body := map[string]any{
		"name": "broadcast-test",
		"type": "text",
	}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	requireStatus(t, w, http.StatusCreated)
	if len(hub.channelCreates) != 1 {
		t.Fatalf("BroadcastChannelCreate called %d times, want 1", len(hub.channelCreates))
	}
	if hub.channelCreates[0].Name != "broadcast-test" {
		t.Errorf("broadcast channel name = %q, want broadcast-test", hub.channelCreates[0].Name)
	}
}

func TestAdminAPI_CreateChannel_NilHubDoesNotPanic(t *testing.T) {
	database := openAdminTestDB(t)
	// nil hub: handler must not panic
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	body := map[string]any{"name": "safe-channel", "type": "text"}
	w := doRequest(t, handler, http.MethodPost, "/channels", token, body)

	expectStatus(t, w, http.StatusCreated)
}

func TestAdminAPI_UpdateChannel_BroadcastsChannelUpdate(t *testing.T) {
	database, hub, handler, token := newAdminHarnessWithHub(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "before", "text", "", "", 0)

	body := map[string]any{"name": "after"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	requireStatus(t, w, http.StatusOK)
	if len(hub.channelUpdates) != 1 {
		t.Fatalf("BroadcastChannelUpdate called %d times, want 1", len(hub.channelUpdates))
	}
	if hub.channelUpdates[0].Name != "after" {
		t.Errorf("broadcast channel name = %q, want after", hub.channelUpdates[0].Name)
	}
}

func TestAdminAPI_UpdateChannel_NilHubDoesNotPanic(t *testing.T) {
	database, handler, token := newAdminHarnessNoHub(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "patchme", "text", "", "", 0)
	body := map[string]any{"name": "patched"}
	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, body)

	expectStatus(t, w, http.StatusOK)
}

func TestAdminAPI_DeleteChannel_BroadcastsChannelDelete(t *testing.T) {
	database, hub, handler, token := newAdminHarnessWithHub(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "delete-me", "text", "", "", 0)

	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	requireStatus(t, w, http.StatusNoContent)
	if len(hub.channelDeleteIDs) != 1 {
		t.Fatalf("BroadcastChannelDelete called %d times, want 1", len(hub.channelDeleteIDs))
	}
	if hub.channelDeleteIDs[0] != chID {
		t.Errorf("broadcast channel id = %d, want %d", hub.channelDeleteIDs[0], chID)
	}
}

func TestAdminAPI_DeleteChannel_NilHubDoesNotPanic(t *testing.T) {
	database, handler, token := newAdminHarnessNoHub(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-no-hub", "text", "", "", 0)
	w := doRequest(t, handler, http.MethodDelete, "/channels/"+itoa(chID), token, nil)

	expectStatus(t, w, http.StatusNoContent)
}

// OC-0010: handleDeleteChannel commits archived=1 as its own transaction and
// evicts voice participants BEFORE calling AdminDeleteChannel — all on
// r.Context(). If the admin's browser aborts the request in that window (tab
// close, navigation, network blip), r.Context() is canceled and the final
// AdminDeleteChannel call fails with context.Canceled: the handler 500s, but
// the archive and the voice eviction already committed. Nothing reverts the
// archive, nothing broadcasts it, and no audit row is written — the channel
// is left silently archived (writes refused, channel_focus 403s) while every
// connected client still shows it live in the sidebar.
//
// This reproduces the race deterministically by canceling the request
// context from inside CleanupVoiceForChannel — exactly the call the repro
// says the real-world cancellation lands during — instead of relying on
// timing. The fix must make the delete tolerate a caller cancellation that
// arrives after the archive has already committed.
func TestAdminAPI_DeleteChannel_SurvivesContextCancelAfterArchiveCommits(t *testing.T) {
	database, hub, handler, token := newAdminHarnessWithHub(t)

	chID, _ := database.AdminCreateChannel(context.Background(), "del-cancel-race", "text", "", "", 0)

	ctx, cancel := context.WithCancel(context.Background())
	// Fires synchronously inside handleDeleteChannel, after the archive
	// commit but before the final AdminDeleteChannel call — the same window
	// the repro describes a browser abort landing in.
	hub.onVoiceCleanup = func(int64) {
		cancel()
	}

	req := httptest.NewRequest(http.MethodDelete, "/channels/"+itoa(chID), nil)
	req = req.WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	requireStatus(t, w, http.StatusNoContent)

	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch != nil {
		t.Errorf("channel %d still exists after a reported-successful delete: %+v", chID, ch)
	}

	if len(hub.channelDeleteIDs) != 1 || hub.channelDeleteIDs[0] != chID {
		t.Errorf("BroadcastChannelDelete calls = %v, want exactly [%d]", hub.channelDeleteIDs, chID)
	}
}
