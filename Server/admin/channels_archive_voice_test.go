package admin_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/db"
)

// Archiving a voice channel hides it from every client the same way deleting
// it does, so live voice participants must be evicted the same way
// handleDeleteChannel evicts them (v036) — otherwise they keep their
// voice_states row, VoiceTopic subscription and LiveKit session in a room
// nothing shows any more.
func TestAdminAPI_PatchChannel_ArchiveCleansVoice(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
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
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))
	token := createAdminUser(t, database)

	chID, _ := database.AdminCreateChannel(context.Background(), "unarchive-voice", "voice", "", "", 0)
	if err := database.AdminUpdateChannel(context.Background(), chID, db.ChannelUpdate{Archived: true}); err != nil {
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
