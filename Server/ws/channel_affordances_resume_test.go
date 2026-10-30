package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// An override edit that lands while the user is offline misses the targeted
// channel_create. The visibility watermark forces their resume onto a full
// ready, and that ready computes can_pin from the current overrides. This is
// the second edge case of 3A-13.
func TestResume_AcrossOverrideChange_FullReadyCarriesNewPin(t *testing.T) {
	t.Parallel()
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "resume-pin-user", "hash", 4) // Member
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "resume-pin-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	role, err := database.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleForUser: %v", err)
	}
	if permissions.HasPerm(role.Permissions, permissions.ManageMessages) {
		t.Fatal("fixture precondition: the Member role must not hold MANAGE_MESSAGES")
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHub(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(hub.Stop)

	// Anchor a last_seq the ring buffer could replay, so the full ready is
	// provably forced by the watermark and not by a ring-buffer miss.
	rb := hub.ReplayBuffer()
	for seq := uint64(98); seq <= 100; seq++ {
		rb.Push(seq, chID, []byte(`{"seq":`+itoaTest(int64(seq))+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"x"}}`))
	}
	hub.SeedSeq(100)

	// The edit lands while the user is offline: the targeted send reaches
	// nobody, but the fan-out still moves the watermark.
	if err := database.UpsertChannelUserOverride(ctx, chID, userID, permissions.ManageMessages, 0); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	svc.Permissions.InvalidateChannel(chID)
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	hub.RefreshChannelVisibility(ch)

	var canPin, canDelete *bool
	for _, evt := range dialAndResume(t, hub, token, 99) {
		var frame struct {
			Type    string `json:"type"`
			Payload struct {
				Channels []struct {
					ID              int64 `json:"id"`
					CanPin          *bool `json:"can_pin"`
					CanDeleteOthers *bool `json:"can_delete_others"`
				} `json:"channels"`
			} `json:"payload"`
		}
		if json.Unmarshal(evt, &frame) != nil || frame.Type != MsgTypeReady {
			continue
		}
		for _, c := range frame.Payload.Channels {
			if c.ID == chID {
				canPin, canDelete = c.CanPin, c.CanDeleteOthers
			}
		}
	}
	if canPin == nil || canDelete == nil {
		t.Fatal("resume past an override edit did not deliver a full ready carrying the channel's can_pin and can_delete_others")
	}
	if !*canPin || !*canDelete {
		t.Fatalf("ready can_pin/can_delete_others = %v/%v, want true/true after the user allow of MANAGE_MESSAGES", *canPin, *canDelete)
	}
}
