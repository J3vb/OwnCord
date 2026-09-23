package ws

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// Count database work rather than setting a flaky wall-clock performance gate.
// The real member/permission-cache fixture also prevents an admin-only test
// from hiding Subject's per-recipient timeout lookup behind its admin bypass.
func TestVoiceAudience_DoesNotQueryRecipientTimeouts(t *testing.T) {
	h, database, store, clients, ch := operationalHub(t)
	ctx := context.Background()
	for _, c := range clients[:25] {
		for range 2 { // one leave and one join audience per churn participant
			if got := len(h.voiceEventAudience(ctx, ch, c.userID)); got != 100 {
				t.Fatalf("voice audience=%d, want 100", got)
			}
		}
	}
	if got := store.timeoutReads.Load(); got != 0 {
		t.Fatalf("voice visibility did %d irrelevant timeout queries", got)
	}

	t.Run("override without hub database", func(t *testing.T) {
		uid := clients[0].userID
		if err := database.UpsertChannelUserOverride(ctx, ch, uid, 0, permissions.ReadMessages); err != nil {
			t.Fatal(err)
		}
		h.perms.InvalidateUser(uid)
		// The service can resolve permissions even in a hub without a direct
		// database handle. It must still receive the requested channel ID.
		h.db = nil
		audience := h.channelReadAudience(ctx, ch)
		if len(audience) != 99 {
			t.Fatalf("audience=%d, want 99", len(audience))
		}
		for _, recipient := range audience {
			if recipient == uid {
				t.Fatal("per-user deny was lost without a hub database")
			}
		}
	})
}
