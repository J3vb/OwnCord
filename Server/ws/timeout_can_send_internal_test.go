package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// timeoutCanSendFixture is a migrated database with one text channel, an
// Owner-role moderator and a Member-role target whose live client is
// registered on a hub wired as the ModerationService's notifier.
type timeoutCanSendFixture struct {
	database *db.DB
	hub      *Hub
	mod      *service.ModerationService
	chID     int64
	actorID  int64
	targetID int64
	send     chan []byte
}

func newTimeoutCanSendFixture(t *testing.T) *timeoutCanSendFixture {
	t.Helper()
	database, _ := applyTimeoutMuteTestDB(t)
	ctx := context.Background()
	chID, err := database.CreateChannel(ctx, "timeout-text", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	actorID, err := database.CreateUser(ctx, "timeout-mod", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser actor: %v", err)
	}
	targetID, err := database.CreateUser(ctx, "timeout-target", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser target: %v", err)
	}
	h := newTestHub(t, database, nil, nil)
	send := registerEmitTestClient(h, targetID, 0)
	mod := service.NewModerationService(database, service.NewPermissionService(database, permissions.NewChecker(database)))
	mod.SetNotifier(h)
	return &timeoutCanSendFixture{database, h, mod, chID, actorID, targetID, send}
}

// waitCanSend waits for a channel_create for chID and returns its can_send.
func waitCanSend(t *testing.T, send chan []byte, chID int64, within time.Duration) bool {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case raw := <-send:
			var msg struct {
				Type    string `json:"type"`
				Payload struct {
					ID      int64 `json:"id"`
					CanSend *bool `json:"can_send"`
				} `json:"payload"`
			}
			if json.Unmarshal(raw, &msg) != nil || msg.Type != "channel_create" || msg.Payload.ID != chID {
				continue
			}
			if msg.Payload.CanSend == nil {
				t.Fatalf("channel_create for %d carries no can_send: %s", chID, raw)
			}
			return *msg.Payload.CanSend
		case <-deadline:
			t.Fatalf("no channel_create for channel %d within %v", chID, within)
			return false
		}
	}
}

// Issuing and then lifting a timeout re-sends the target's can_send each
// time, without a reconnect.
func TestTimeout_IssueAndLiftPushCanSend(t *testing.T) {
	f := newTimeoutCanSendFixture(t)
	ctx := context.Background()

	if _, err := f.mod.Timeout(ctx, f.actorID, f.targetID, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	if waitCanSend(t, f.send, f.chID, time.Second) {
		t.Fatal("can_send = true after a timeout was issued, want false")
	}

	if err := f.mod.LiftTimeout(ctx, f.actorID, f.targetID); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if !waitCanSend(t, f.send, f.chID, time.Second) {
		t.Fatal("can_send = false after the timeout was lifted, want true")
	}
}

// A timeout that simply runs out is announced too: nothing lifts it, so the
// refresh NotifyModAction scheduled at issue time is what re-sends can_send.
func TestTimeout_ExpiryPushesCanSend(t *testing.T) {
	f := newTimeoutCanSendFixture(t)
	ctx := context.Background()

	// Below Timeout's 1-minute floor, so written straight to the ledger and
	// announced the way Timeout announces it.
	expires := time.Now().Add(2 * time.Second)
	id, _, err := f.database.TimeoutUser(ctx, f.targetID, f.actorID, nil, "brief", expires)
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	f.hub.NotifyModAction(f.targetID, id, "timeout", "brief", &expires)
	if waitCanSend(t, f.send, f.chID, time.Second) {
		t.Fatal("can_send = true while the timeout is active, want false")
	}
	if !waitCanSend(t, f.send, f.chID, 5*time.Second) {
		t.Fatal("can_send = false after the timeout expired, want true")
	}
}
