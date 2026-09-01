package admin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

// Archiving a voice channel hides it from every client the same way deleting
// it does, so live voice participants must be evicted the same way
// handleDeleteChannel evicts them (v036) — otherwise they keep their
// voice_states row, VoiceTopic subscription and LiveKit session in a room
// nothing shows any more.
func TestAdminAPI_PatchChannel_ArchiveCleansVoice(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "archive-voice", "voice", "", "", 0)

	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, map[string]any{
		"archived": true,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	if len(hub.voiceCleanupIDs) != 1 || hub.voiceCleanupIDs[0] != chID {
		t.Fatalf("CleanupVoiceForChannel calls = %v, want exactly [%d]", hub.voiceCleanupIDs, chID)
	}
	if len(hub.visibilityRefreshes) != 1 {
		t.Fatalf("RefreshChannelVisibility calls = %d, want 1", len(hub.visibilityRefreshes))
	}
}

// Unarchiving must not run the voice cleanup — only the true->true and
// false->true transition (going *into* archived) evicts anyone; a channel
// coming back out of the archive has no live participants to evict and
// should not falsely report a cleanup call.
func TestAdminAPI_PatchChannel_UnarchiveDoesNotCleanVoice(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "unarchive-voice", "voice", "", "", 0)
	// AdminUpdateChannel replaces the full row, so the seed must carry the
	// name along with Archived: true — leaving it zero-valued would blank the
	// channel's name directly at the DB layer, bypassing the handler's own
	// validation and leaving the row in a state the HTTP surface never allows.
	if err := database.AdminUpdateChannel(context.Background(), chID, db.ChannelUpdate{Name: "unarchive-voice", Archived: true}); err != nil {
		t.Fatalf("seed archived channel: %v", err)
	}

	w := doRequest(t, handler, http.MethodPatch, "/channels/"+itoa(chID), token, map[string]any{
		"archived": false,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	if len(hub.voiceCleanupIDs) != 0 {
		t.Fatalf("CleanupVoiceForChannel calls = %v, want none on unarchive", hub.voiceCleanupIDs)
	}
}

// OC-0158: handlePatchChannel commits AdminUpdateChannel (which can set
// archived=1) and only afterwards re-reads the row with
// database.GetChannel(r.Context(), id). That read is still bound to the
// admin's own request context, so a caller cancellation arriving right after
// the commit (tab close, network blip) makes the re-read fail and the
// handler return early — never calling hub.CleanupVoiceForChannel nor
// hub.RefreshChannelVisibility, even though the archive already committed.
// Live voice participants of an archived voice channel are then stuck with a
// voice_states row, a VoiceTopic subscription and a LiveKit session in a room
// nothing shows any more, and no sweep recovers them.
//
// This reproduces the race deterministically by cancelling the request
// context from a hook that fires synchronously right after the
// AdminUpdateChannel commit — exactly the window the repro describes a
// browser abort landing in — instead of relying on wall-clock timing.
func TestAdminAPI_PatchChannel_ArchiveSurvivesContextCancelAfterCommit(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "archive-cancel-race", "voice", "", "", 0)

	ctx, cancel := context.WithCancel(context.Background())
	restore := admin.SetPatchChannelPostCommitHook(func() {
		cancel()
	})
	defer restore()

	body, _ := json.Marshal(map[string]any{"archived": true})
	req := httptest.NewRequest(http.MethodPatch, "/channels/"+itoa(chID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (patch must survive a caller cancellation that arrives after the archive already committed); body: %s", w.Code, w.Body.String())
	}

	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch == nil || !ch.Archived {
		t.Fatalf("channel %d must be archived after a reported-successful patch: %+v", chID, ch)
	}

	if len(hub.voiceCleanupIDs) != 1 || hub.voiceCleanupIDs[0] != chID {
		t.Errorf("CleanupVoiceForChannel calls = %v, want exactly [%d]", hub.voiceCleanupIDs, chID)
	}
	if len(hub.visibilityRefreshes) != 1 {
		t.Errorf("RefreshChannelVisibility calls = %d, want 1", len(hub.visibilityRefreshes))
	}
}

// OC-0158, create side: handleCreateChannel commits AdminCreateChannel and
// only afterwards re-reads the row to broadcast it. A caller cancellation
// landing in that window (tab close, network blip) failed the re-read and
// 500ed the request, leaving a durably created channel no connected client
// was ever told about — the same shape already fixed in the PATCH and DELETE
// siblings. The hook fires synchronously right after the commit so the window
// is hit deterministically instead of by wall-clock timing.
func TestAdminAPI_CreateChannel_SurvivesContextCancelAfterCommit(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	ctx, cancel := context.WithCancel(context.Background())
	restore := admin.SetCreateChannelPostCommitHook(func() {
		cancel()
	})
	defer restore()

	body, _ := json.Marshal(map[string]any{"name": "create-cancel-race", "type": "text"})
	req := httptest.NewRequest(http.MethodPost, "/channels", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (create must survive a caller cancellation that arrives after the row already committed); body: %s", w.Code, w.Body.String())
	}
	if len(hub.channelCreates) != 1 {
		t.Fatalf("BroadcastChannelCreate called %d times, want 1 — the row committed, so connected clients must be told", len(hub.channelCreates))
	}
	if hub.channelCreates[0].Name != "create-cancel-race" {
		t.Errorf("broadcast channel name = %q, want create-cancel-race", hub.channelCreates[0].Name)
	}
}
