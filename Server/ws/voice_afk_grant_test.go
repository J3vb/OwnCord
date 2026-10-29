package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

// afkHarnessSecret is the API secret healthyTestLiveKit signs with.
const afkHarnessSecret = "harness-secret-0123456789abcdef"

func afkTokenGrant(t *testing.T, reply []byte, secret string) *lkauth.VideoGrant {
	t.Helper()
	var msg struct {
		Payload voiceTokenPayload `json:"payload"`
	}
	if err := json.Unmarshal(reply, &msg); err != nil {
		t.Fatal(err)
	}
	v, err := lkauth.ParseAPIToken(msg.Payload.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, claims, err := v.Verify(secret)
	if err != nil {
		t.Fatal(err)
	}
	return claims.Video
}

func requirePublishSources(t *testing.T, grant *lkauth.VideoGrant, want bool, label string) {
	t.Helper()
	for _, source := range []livekit.TrackSource{
		livekit.TrackSource_MICROPHONE,
		livekit.TrackSource_CAMERA,
		livekit.TrackSource_SCREEN_SHARE,
		livekit.TrackSource_SCREEN_SHARE_AUDIO,
	} {
		if got := grant.GetCanPublishSource(source); got != want {
			t.Errorf("%s: signed JWT permits %s = %v, want %v", label, source, got, want)
		}
	}
	if !grant.GetCanSubscribe() {
		t.Errorf("%s: the token must stay subscribe-capable so the member can listen", label)
	}
}

// joinAndReadToken drives a real voice_join and returns the signed voice_token.
func joinAndReadToken(t *testing.T, h *Hub, c *Client, send chan []byte, channelID int64) []byte {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"channel_id": channelID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload), "")
	for _, m := range drainChan(send, 200*time.Millisecond) {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "voice_token" {
			return m
		}
	}
	t.Fatalf("no voice_token reached the client for channel %d", channelID)
	return nil
}

// The AFK channel is listen-only: a member whose role allows speaking, video
// and screen share still gets a token with no publish source there, while the
// same member in an ordinary voice channel keeps all of them.
func TestVoiceJoin_AFKChannelGrantsNoPublish(t *testing.T) {
	database := newHarvestVoiceDB(t)
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = ? WHERE id = ?`,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen,
		harvestVoiceRoleID); err != nil {
		t.Fatal(err)
	}
	uid := seedHarvestVoiceUser(t, database, "afk-joiner")
	normal := mustCreateVoiceChannel(t, database, "voice-normal")
	afk := mustCreateVoiceChannel(t, database, "voice-afk")
	if _, err := database.SetAFKChannel(context.Background(), &afk); err != nil {
		t.Fatal(err)
	}

	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: healthyTestLiveKit(t)})
	send := make(chan []byte, 32)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "afk-joiner"}
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()

	requirePublishSources(t, afkTokenGrant(t, joinAndReadToken(t, h, c, send, normal), afkHarnessSecret), true, "ordinary channel")
	requirePublishSources(t, afkTokenGrant(t, joinAndReadToken(t, h, c, send, afk), afkHarnessSecret), false, "afk channel")
}

// A refresh inside the AFK channel must not hand the microphone back, and it
// must leave the moderator mute on the voice_states row alone.
func TestVoiceTokenRefresh_AFKChannelGrantsNoPublish(t *testing.T) {
	ctx := context.Background()
	deps, database := tokenRefreshDeps(t)
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen)
	state, err := database.GetVoiceState(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("voice state: %v", err)
	}
	lk := moderationTokenClient(t)
	deps.TokenGen = lk
	refresh := func() *lkauth.VideoGrant {
		deps.Limiter = auth.NewRateLimiter() // one refresh per minute otherwise
		result := handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, ClientInfo{
			UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: state.JoinedAt,
		}, deps)
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		return afkTokenGrant(t, result.Reply, moderationTokenSecret)
	}

	requirePublishSources(t, refresh(), true, "before the flag")

	afk := int64(100)
	if _, err := database.SetAFKChannel(ctx, &afk); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE voice_states SET server_muted = 1 WHERE user_id = 1`); err != nil {
		t.Fatal(err)
	}
	requirePublishSources(t, refresh(), false, "afk channel")

	after, err := database.GetVoiceState(ctx, 1)
	if err != nil || after == nil || !after.ServerMuted {
		t.Fatalf("the moderator mute must survive a refresh in the AFK channel: state=%+v err=%v", after, err)
	}
}
