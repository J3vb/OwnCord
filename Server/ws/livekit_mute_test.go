package ws_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestLiveKitClient_MuteParticipantAudio_SkipsScreenShareAudio locks OC-0327:
// MuteParticipantAudio must mute the participant's microphone but leave their
// screen-share audio (Track.Source.ScreenShareAudio, published by
// Client/src/lib/screenShare.ts) alone — a moderator's server mute is scoped
// to the mic, and the client enforces the same exemption for self-mute/deafen
// (audioElements.ts). A regular audio track with an unset/UNKNOWN source must
// still be muted, so the guard has to name screen-share audio specifically
// rather than whitelist the microphone source.
func TestLiveKitClient_MuteParticipantAudio_SkipsScreenShareAudio(t *testing.T) {
	t.Parallel()

	participant := &livekit.ParticipantInfo{
		Identity: "user-1:tok",
		Tracks: []*livekit.TrackInfo{
			{Sid: "mic-track", Type: livekit.TrackType_AUDIO, Source: livekit.TrackSource_MICROPHONE},
			{Sid: "screenshare-audio-track", Type: livekit.TrackType_AUDIO, Source: livekit.TrackSource_SCREEN_SHARE_AUDIO},
			{Sid: "video-track", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_CAMERA},
		},
	}

	var mutedSids []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body []byte
		switch {
		case strings.HasSuffix(r.URL.Path, "/GetParticipant"):
			body, _ = proto.Marshal(participant)
		case strings.HasSuffix(r.URL.Path, "/MutePublishedTrack"):
			req := &livekit.MuteRoomTrackRequest{}
			if raw, err := io.ReadAll(r.Body); err == nil {
				_ = proto.Unmarshal(raw, req)
				mutedSids = append(mutedSids, req.TrackSid)
			}
			body, _ = proto.Marshal(&livekit.MuteRoomTrackResponse{Track: &livekit.TrackInfo{Sid: req.TrackSid, Muted: req.Muted}})
		default:
			t.Fatalf("unexpected RPC path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	client, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + srv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	if err := client.MuteParticipantAudio(context.Background(), 10, 1, "tok", true); err != nil {
		t.Fatalf("MuteParticipantAudio: %v", err)
	}

	if len(mutedSids) != 1 || mutedSids[0] != "mic-track" {
		t.Errorf("muted track SIDs = %v, want only [mic-track] — screen-share audio and video must not be muted", mutedSids)
	}
}
