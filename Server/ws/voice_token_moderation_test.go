package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

const moderationTokenSecret = "test-moderation-token-secret-long-enough"

func moderationTokenClient(t *testing.T) *LiveKitClient {
	t.Helper()
	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-moderation-token-key",
		LiveKitAPISecret: moderationTokenSecret,
		LiveKitURL:       "ws://127.0.0.1:1", // Token signing is local.
	})
	if err != nil {
		t.Fatal(err)
	}
	return lk
}

func moderationTokenGrant(t *testing.T, reply []byte) *auth.VideoGrant {
	t.Helper()
	var msg struct {
		Payload voiceTokenPayload `json:"payload"`
	}
	if err := json.Unmarshal(reply, &msg); err != nil {
		t.Fatal(err)
	}
	v, err := auth.ParseAPIToken(msg.Payload.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, claims, err := v.Verify(moderationTokenSecret)
	if err != nil {
		t.Fatal(err)
	}
	return claims.Video
}

// Inspect the signed credential accepted by LiveKit, not just OwnCord's
// voice_state or a token generator mock. A moderator mute must restrict future
// microphone publications while independent camera/stream permissions survive.
func TestVoiceToken_ModerationRestrictsMicrophoneGrant(t *testing.T) {
	allSources := permissions.SpeakVoice | permissions.UseVideo | permissions.ShareScreen
	for _, route := range []string{"join", "refresh"} {
		for _, tc := range []struct {
			name              string
			roleSources       int64
			muted, deafened   bool
			microphone, video bool
			screenShare       bool
		}{
			{name: "unmoderated", roleSources: allSources, microphone: true, video: true, screenShare: true},
			{name: "server_muted", roleSources: allSources, muted: true, video: true, screenShare: true},
			{name: "server_deafened", roleSources: allSources, deafened: true, video: true, screenShare: true},
			{name: "muted_audio_only", roleSources: permissions.SpeakVoice, muted: true},
			{name: "camera_without_speak", roleSources: permissions.UseVideo, video: true},
		} {
			t.Run(route+"/"+tc.name, func(t *testing.T) {
				ctx := context.Background()
				deps, database := tokenRefreshDeps(t)
				seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice|tc.roleSources)
				if _, err := database.ExecContext(ctx,
					`UPDATE voice_states SET server_muted = ?, server_deafened = ? WHERE user_id = 1`, tc.muted, tc.deafened); err != nil {
					t.Fatal(err)
				}
				state, err := database.GetVoiceState(ctx, 1)
				if err != nil || state == nil {
					t.Fatalf("voice state: %v", err)
				}
				lk := moderationTokenClient(t)
				var reply []byte
				if route == "refresh" {
					deps.TokenGen = lk
					result := handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, ClientInfo{
						UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: state.JoinedAt,
					}, deps)
					if result.Error != nil {
						t.Fatal(result.Error)
					}
					reply = result.Reply
				} else {
					h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
					send := make(chan []byte, 8)
					c := NewTestClient(h, 1, send)
					c.user = &db.User{ID: 1, Username: "alice"}
					c.setVoiceState(100, state.JoinedAt)
					if !h.voiceJoinGrantToken(ctx, c, 100, state) {
						t.Fatal("initial token mint refused")
					}
					reply = <-send
				}
				grant := moderationTokenGrant(t, reply)
				for source, want := range map[livekit.TrackSource]bool{
					livekit.TrackSource_MICROPHONE:         tc.microphone,
					livekit.TrackSource_CAMERA:             tc.video,
					livekit.TrackSource_SCREEN_SHARE:       tc.screenShare,
					livekit.TrackSource_SCREEN_SHARE_AUDIO: tc.screenShare,
				} {
					if got := grant.GetCanPublishSource(source); got != want {
						t.Errorf("signed JWT permits %s = %v, want %v", source, got, want)
					}
				}
				if !grant.GetCanSubscribe() {
					t.Error("deafen must preserve subscriptions for independent stream playback")
				}
			})
		}
	}
}

func TestVoiceTokenRefresh_CachedTokenRequiresReadableMembership(t *testing.T) {
	for _, fault := range []string{"missing_state", "read_error", "different_channel"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			deps, database := tokenRefreshDeps(t)
			state, err := database.GetVoiceState(ctx, 1)
			if err != nil || state == nil {
				t.Fatalf("voice state: %v", err)
			}
			var statement string
			switch fault {
			case "missing_state":
				statement = `DELETE FROM voice_states WHERE user_id = 1`
			case "read_error":
				statement = `ALTER TABLE voice_states RENAME TO voice_states_offline`
			case "different_channel":
				if _, err := database.ExecContext(ctx, `INSERT INTO channels (id, name, type, position) VALUES (101, 'other', 'voice', 1)`); err != nil {
					t.Fatal(err)
				}
				statement = `UPDATE voice_states SET channel_id = 101 WHERE user_id = 1`
			}
			if _, err := database.ExecContext(ctx, statement); err != nil {
				t.Fatal(err)
			}
			deps.TokenGen = moderationTokenClient(t)
			result := handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, ClientInfo{
				UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: state.JoinedAt,
			}, deps)
			if result.Error == nil || result.Reply != nil {
				t.Fatal("refresh minted a credential without readable matching voice membership")
			}
		})
	}
}
