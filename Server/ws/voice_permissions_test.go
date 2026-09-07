package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

func voicePermissionSFU(t *testing.T) (*LiveKitClient, <-chan *livekit.UpdateParticipantRequest, *atomic.Bool) {
	t.Helper()
	updates := make(chan *livekit.UpdateParticipantRequest, 16)
	var failing atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/UpdateParticipant") {
			body, err := io.ReadAll(r.Body)
			req := &livekit.UpdateParticipantRequest{}
			if err != nil || proto.Unmarshal(body, req) != nil {
				t.Error("invalid UpdateParticipant request")
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			updates <- req
			if failing.Load() {
				http.Error(w, "temporarily offline", http.StatusServiceUnavailable)
				return
			}
		} else if !strings.HasSuffix(r.URL.Path, "/GetParticipant") {
			t.Errorf("unexpected SFU request: %s", r.URL.Path)
			http.Error(w, "unexpected RPC", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return reconciliationLiveKit(t, srv.URL), updates, &failing
}

func assertVoicePermissionSources(t *testing.T, req *livekit.UpdateParticipantRequest, want ...livekit.TrackSource) {
	t.Helper()
	if req.Permission == nil || !slices.Equal(req.Permission.CanPublishSources, want) {
		t.Fatalf("source permissions = %v, want %v", req.Permission, want)
	}
	if req.Permission.CanPublish != (len(want) > 0) || !req.Permission.CanSubscribe {
		t.Fatalf("publishing/subscription permissions = %v", req.Permission)
	}
}

// Reconciliation changes active SFU source permissions even when CONNECT_VOICE
// remains granted. UI state and future-token checks alone cannot do this.
func TestVoicePermissions_SweepReconcilesCurrentRole(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	base := permissions.ReadMessages | permissions.ConnectVoice
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, base|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen)
	lk, updates, _ := voicePermissionSFU(t)
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	c := NewTestClient(h, 1, make(chan []byte, 8))
	c.setVoiceState(100, state.JoinedAt)
	h.clients[1] = c
	for _, tc := range []struct {
		role int64
		want []livekit.TrackSource
	}{
		{base | permissions.SpeakVoice, []livekit.TrackSource{livekit.TrackSource_MICROPHONE}},
		{base | permissions.UseVideo, []livekit.TrackSource{livekit.TrackSource_CAMERA}},
		{base, nil},
	} {
		seedVoiceOnlyRole(t, database, voiceOnlyRoleID, tc.role)
		h.sweepStaleVoiceEvictRevoked(ctx)
		select {
		case req := <-updates:
			assertVoicePermissionSources(t, req, tc.want...)
			if req.Identity != participantIdentity(1, state.JoinedAt) || req.Room != RoomName(100) {
				t.Fatalf("incorrect update identity: %v", req)
			}
		default:
			t.Fatal("no active SFU permission update")
		}
		if c.getVoiceChID() != 100 {
			t.Fatal("media source revocation must preserve allowed room membership")
		}
	}
}

func TestVoicePermissions_RejectsStaleMembershipAndReadErrors(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	lk, updates, _ := voicePermissionSFU(t)
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	if err := h.voice.Join(ctx, 1, 100, 0); err != nil {
		t.Fatal(err)
	}
	if err := h.syncVoiceParticipantPermissions(ctx, 1, 100, state.JoinedAt); err == nil {
		t.Fatal("a stale reconciliation must not follow a same-room rejoin")
	}
	current, err := h.voice.State(ctx, 1)
	if err != nil || current == nil {
		t.Fatalf("current state: %v", err)
	}
	if _, err := database.ExecContext(ctx, `ALTER TABLE roles RENAME TO roles_offline`); err != nil {
		t.Fatal(err)
	}
	if err := h.syncVoiceParticipantPermissions(ctx, 1, 100, current.JoinedAt); err == nil {
		t.Fatal("unreadable authorization must not issue an SFU grant update")
	}
	select {
	case req := <-updates:
		t.Fatalf("unsafe permission update: %v", req)
	default:
	}
}

func TestVoicePermissions_SelfControlsPreservePublishing(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen)
	lk, updates, _ := voicePermissionSFU(t)
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	if _, err := database.ExecContext(ctx, `UPDATE voice_states SET muted = 1, deafened = 1 WHERE user_id = 1`); err != nil {
		t.Fatal(err)
	}
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	if err := h.syncVoiceParticipantPermissions(ctx, 1, 100, state.JoinedAt); err != nil {
		t.Fatal(err)
	}
	assertVoicePermissionSources(t, <-updates, livekit.TrackSource_MICROPHONE, livekit.TrackSource_CAMERA,
		livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
}

func TestVoicePermissions_SweepSkipsConcurrentModeration(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	lk, updates, _ := voicePermissionSFU(t)
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	state, err := h.voice.State(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("state: %v", err)
	}
	c := NewTestClient(h, 1, make(chan []byte, 8))
	c.setVoiceState(100, state.JoinedAt)
	h.clients[1] = c
	unlock := h.voiceMod.lock(1)
	finished := make(chan struct{})
	go func() {
		h.sweepStaleVoiceEvictRevoked(ctx)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		unlock()
		<-finished
		t.Fatal("periodic reconciliation queued behind active moderation")
	}
	unlock()
	select {
	case req := <-updates:
		t.Fatalf("reconciliation raced active moderation: %v", req)
	default:
	}
	// The skipped user remains eligible on the next pass; no lock entry leaks.
	h.sweepStaleVoiceEvictRevoked(ctx)
	select {
	case req := <-updates:
		assertVoicePermissionSources(t, req)
	default:
		t.Fatal("the next sweep did not reconcile the now-idle user")
	}
}

func TestVoicePermissions_ModerationFailureRetainsDesiredStateForRetry(t *testing.T) {
	for _, deafen := range []bool{false, true} {
		t.Run(map[bool]string{false: "mute", true: "deafen"}[deafen], func(t *testing.T) {
			ctx := context.Background()
			deps, database := tokenRefreshDeps(t)
			seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen)
			actorID := seedDeafenRaceUser(t, database, "moderator", 2)
			lk, updates, failing := voicePermissionSFU(t)
			h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
			initial, err := h.voice.State(ctx, 1)
			if err != nil || initial == nil {
				t.Fatalf("initial state: %v", err)
			}
			send := make(chan []byte, 8)
			c := NewTestClient(h, 1, send)
			c.setVoiceState(100, initial.JoinedAt)
			h.clients[1] = c
			go h.Run()
			t.Cleanup(h.Stop)
			deps.Mod = h
			failing.Store(true)
			moderate := func() Result {
				if deafen {
					return handleVoiceModDeafenV2(ctx, VoiceModDeafenCmd{userID: actorID, channelID: 100, targetID: 1, deafened: true}, ClientInfo{UserID: actorID}, deps)
				}
				return handleVoiceModMuteV2(ctx, VoiceModMuteCmd{userID: actorID, channelID: 100, targetID: 1, muted: true}, ClientInfo{UserID: actorID}, deps)
			}
			result := moderate()
			var clientErr ClientError
			if !errors.As(result.Error, &clientErr) || !strings.Contains(clientErr.Message, "media update failed") {
				t.Fatalf("failed SFU enforcement must be reported: %v", result.Error)
			}
			action := map[bool]string{false: "voice_mod_mute", true: "voice_mod_deafen"}[deafen]
			audits, err := database.GetAuditLog(ctx, 10, 0)
			if err != nil || len(audits) != 1 || audits[0].Action != action ||
				audits[0].ActorID != actorID || audits[0].TargetID != 1 || !strings.Contains(audits[0].Detail, "media update pending") {
				t.Fatalf("persisted moderation needs exactly one pending-enforcement audit: audits=%v err=%v", audits, err)
			}
			assertVoicePermissionSources(t, <-updates, livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
			state, err := h.voice.State(ctx, 1)
			if err != nil || state == nil || !state.ServerMuted || state.ServerDeafened != deafen {
				t.Fatalf("desired moderation state was lost: state=%v err=%v", state, err)
			}
			select {
			case raw := <-send:
				var event struct {
					Type    string `json:"type"`
					Payload struct {
						ServerMuted    bool `json:"server_muted"`
						ServerDeafened bool `json:"server_deafened"`
					} `json:"payload"`
				}
				if err := json.Unmarshal(raw, &event); err != nil || event.Type != MsgTypeVoiceState ||
					!event.Payload.ServerMuted || event.Payload.ServerDeafened != deafen {
					t.Fatalf("saved desired state was not delivered after partial failure: %s", raw)
				}
			case <-time.After(time.Second):
				t.Fatal("saved desired state was not delivered after partial failure")
			}
			failing.Store(false)
			h.sweepStaleVoiceEvictRevoked(ctx)
			assertVoicePermissionSources(t, <-updates, livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
			if result := moderate(); result.Error != nil {
				t.Fatalf("moderator retry after recovery: %v", result.Error)
			}
			audits, err = database.GetAuditLog(ctx, 10, 0)
			if err != nil || len(audits) != 2 || audits[0].Action != action || strings.Contains(audits[0].Detail, "pending") {
				t.Fatalf("successful retry needs exactly one additional audit: audits=%v err=%v", audits, err)
			}
		})
	}
}
