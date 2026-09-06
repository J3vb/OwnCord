package ws

// Internal (package ws) because moderationAudience is unexported. Builds a
// real Hub over a migrated database (migration 048 already grants
// MODERATE_MEMBERS to the seeded Moderator role, id 3) so CanModerate's
// verdict comes from the same resolution path production traffic uses.

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

func waitClientRegistered(t *testing.T, h *Hub, uid int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.GetClient(uid) != nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("client %d never registered", uid)
}

func TestModerationAudience_OnlyBitHoldersOrAdmin(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	ctx := context.Background()
	ownerID, err := database.CreateUser(ctx, "mq-owner", "hash", 1) // Owner: Administrator
	if err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	modID, err := database.CreateUser(ctx, "mq-mod", "hash", 3) // Moderator: MODERATE_MEMBERS since migration 048
	if err != nil {
		t.Fatalf("CreateUser(mod): %v", err)
	}
	memberID, err := database.CreateUser(ctx, "mq-member", "hash", 4) // Member: no bit
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHub(t, database, limiter, svc)
	go hub.Run()
	defer hub.Stop()

	ownerSend := make(chan []byte, 4)
	modSend := make(chan []byte, 4)
	memberSend := make(chan []byte, 4)
	hub.Register(NewTestClient(hub, ownerID, ownerSend))
	hub.Register(NewTestClient(hub, modID, modSend))
	hub.Register(NewTestClient(hub, memberID, memberSend))
	waitClientRegistered(t, hub, ownerID)
	waitClientRegistered(t, hub, modID)
	waitClientRegistered(t, hub, memberID)

	audience := hub.moderationAudience(ctx)
	got := map[int64]bool{}
	for _, uid := range audience {
		got[uid] = true
	}
	if !got[ownerID] {
		t.Error("owner (Administrator) missing from the moderation audience")
	}
	if !got[modID] {
		t.Error("moderator (MODERATE_MEMBERS) missing from the moderation audience")
	}
	if got[memberID] {
		t.Error("plain member must not be in the moderation audience")
	}
	if len(audience) != 2 {
		t.Errorf("audience = %v, want exactly the owner and the moderator", audience)
	}

	hub.BroadcastModQueue(ctx, 42, "assigned")

	select {
	case msg := <-ownerSend:
		if !containsBytes(msg, "mod_queue") || !containsBytes(msg, `"report_id":42`) {
			t.Errorf("owner frame = %s", msg)
		}
	case <-time.After(time.Second):
		t.Error("owner never received the mod_queue frame")
	}
	select {
	case msg := <-modSend:
		if !containsBytes(msg, "mod_queue") {
			t.Errorf("moderator frame = %s", msg)
		}
	case <-time.After(time.Second):
		t.Error("moderator never received the mod_queue frame")
	}
	select {
	case <-memberSend:
		t.Error("plain member received the mod_queue frame")
	case <-time.After(100 * time.Millisecond):
	}
}

func containsBytes(b []byte, sub string) bool {
	s := string(b)
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
