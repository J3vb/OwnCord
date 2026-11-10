package ws

import (
	"context"
	"slices"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// dataGrant is what one written grant says, read back from the signed token
// or from the update sent to the media server.
type dataGrant struct {
	room, identity string
	data           bool
	sources        []livekit.TrackSource
}

func dataGrantSources(allowed func(livekit.TrackSource) bool) []livekit.TrackSource {
	var out []livekit.TrackSource
	for _, source := range []livekit.TrackSource{
		livekit.TrackSource_MICROPHONE, livekit.TrackSource_CAMERA,
		livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO,
	} {
		if allowed(source) {
			out = append(out, source)
		}
	}
	return out
}

// mintVoiceGrantReply runs the production route ("refresh", or the join hook
// for anything else) that signs a voice token for user 1 in channel 100 and
// returns the frame it sent.
func mintVoiceGrantReply(t *testing.T, route string, lk *LiveKitClient, database *db.DB, deps VoiceDeps, state *db.VoiceState) []byte {
	t.Helper()
	ctx := context.Background()
	if route == "refresh" {
		deps.TokenGen = lk
		deps.Limiter = auth.NewRateLimiter() // each refresh is the first one its limiter sees
		result := handleVoiceTokenRefreshV2(ctx, VoiceTokenRefreshCmd{userID: 1}, ClientInfo{
			UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: state.JoinedAt,
		}, deps)
		if result.Error != nil {
			t.Fatal(result.Error)
		}
		return result.Reply
	}
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	send := make(chan []byte, 8)
	c := NewTestClient(h, 1, send)
	c.user = &db.User{ID: 1, Username: "alice"}
	c.voice.setState(100, state.JoinedAt)
	if !h.voiceJoinGrantTokenTest(ctx, c, 100, state, "") {
		t.Fatal("initial token mint refused")
	}
	return <-send
}

// writeDataGrant runs one production route that writes a grant for user 1 in
// channel 100, with the setting on or off, and returns what it wrote.
func writeDataGrant(t *testing.T, route string, restrict bool, database *db.DB, deps VoiceDeps, state *db.VoiceState) dataGrant {
	t.Helper()
	ctx := context.Background()
	if route == "live_update" {
		lk, updates, _ := voicePermissionSFU(t)
		lk.restrictData = restrict
		h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
		if err := h.syncVoiceParticipantPermissions(ctx, 1, 100, state.JoinedAt); err != nil {
			t.Fatalf("live update: %v", err)
		}
		req := <-updates
		return dataGrant{
			room: req.Room, identity: req.Identity, data: req.Permission.GetCanPublishData(),
			sources: dataGrantSources(func(s livekit.TrackSource) bool {
				return req.Permission.GetCanPublish() && slices.Contains(req.Permission.GetCanPublishSources(), s)
			}),
		}
	}
	lk := moderationTokenClient(t)
	lk.restrictData = restrict
	grant := moderationTokenGrant(t, mintVoiceGrantReply(t, route, lk, database, deps, state))
	if grant.RoomAdmin || grant.RoomCreate || grant.RoomList || grant.RoomRecord || grant.IngressAdmin || grant.Hidden || grant.Recorder || grant.Agent {
		t.Fatalf("%s: the token carries a right beyond one room's media: %+v", route, grant)
	}
	if !grant.RoomJoin || !grant.GetCanSubscribe() {
		t.Fatalf("%s: the token cannot join and listen: %+v", route, grant)
	}
	return dataGrant{
		room: grant.Room, identity: participantIdentity(1, state.JoinedAt), data: grant.GetCanPublishData(),
		sources: dataGrantSources(grant.GetCanPublishSource),
	}
}

// One rule decides the data-packet grant on every route that writes a grant:
// the first token, a refreshed token and an update to a live participant.
// With voice.restrict_data_publishing off it follows the microphone grant;
// with it on nobody holds it, and room, identity and media sources are the
// same either way.
func TestVoiceGrant_DataPublishingFollowsTheSetting(t *testing.T) {
	everything := permissions.SpeakVoice | permissions.UseVideo | permissions.ShareScreen
	for _, tc := range []struct {
		name        string
		role        int64
		serverMuted bool
		afk         bool
		microphone  bool
	}{
		{name: "speaking", role: everything, microphone: true},
		{name: "server_muted", role: everything, serverMuted: true},
		{name: "camera_without_speak", role: permissions.UseVideo},
		{name: "afk_channel", role: everything, afk: true},
	} {
		for _, route := range []string{"join", "refresh", "live_update"} {
			if tc.afk && route == "join" {
				continue // the join hook takes the AFK flag from its caller; voice_afk_grant_test.go covers it
			}
			t.Run(tc.name+"/"+route, func(t *testing.T) {
				ctx := context.Background()
				deps, database := tokenRefreshDeps(t)
				seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice|tc.role)
				if _, err := database.ExecContext(ctx, `UPDATE voice_states SET server_muted = ? WHERE user_id = 1`, tc.serverMuted); err != nil {
					t.Fatal(err)
				}
				if tc.afk {
					room := int64(100)
					if _, err := database.SetAFKChannel(ctx, &room); err != nil {
						t.Fatal(err)
					}
				}
				state, err := database.GetVoiceState(ctx, 1)
				if err != nil || state == nil {
					t.Fatalf("voice state: %v", err)
				}

				open := writeDataGrant(t, route, false, database, deps, state)
				restricted := writeDataGrant(t, route, true, database, deps, state)

				if open.data != tc.microphone {
					t.Errorf("setting off: data grant = %v, want it to follow the microphone grant (%v)", open.data, tc.microphone)
				}
				if slices.Contains(open.sources, livekit.TrackSource_MICROPHONE) != tc.microphone {
					t.Errorf("setting off: sources = %v, want microphone = %v", open.sources, tc.microphone)
				}
				if restricted.data {
					t.Error("setting on: the grant carries data publishing")
				}
				if !slices.Equal(restricted.sources, open.sources) {
					t.Errorf("setting on: sources = %v, want the same as with it off (%v)", restricted.sources, open.sources)
				}
				if restricted.room != RoomName(100) || restricted.room != open.room || restricted.identity != open.identity {
					t.Errorf("setting on: room %q identity %q, want %q %q", restricted.room, restricted.identity, open.room, open.identity)
				}
			})
		}
	}
}
