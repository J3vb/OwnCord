package ws_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/ws"
)

// LiveKitClient.ListParticipants, CountVideoTracks and HealthCheck had no
// coverage — CountVideoTracks in particular gates MaxVideo enforcement, so a
// miscount silently changes who is allowed to turn a camera on.
//
// The room service client speaks Twirp over HTTP, so these tests stand up an
// httptest server that replies with real protobuf-encoded responses.

// twirpServer returns an httptest server that answers every Twirp RPC with the
// supplied protobuf message, and a client pointed at it.
func twirpServer(t *testing.T, status int, reply proto.Message) *ws.LiveKitClient {
	t.Helper()

	var body []byte
	if reply != nil {
		var err error
		body, err = proto.Marshal(reply)
		if err != nil {
			t.Fatalf("marshal reply: %v", err)
		}
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"code":"internal","msg":"boom"}`))
			return
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
	return client
}

func TestLiveKitClient_ListParticipants_Empty(t *testing.T) {
	client := twirpServer(t, http.StatusOK, &livekit.ListParticipantsResponse{})

	got, err := client.ListParticipants(42)
	if err != nil {
		t.Fatalf("ListParticipants: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("ListParticipants = %v, want empty", got)
	}
}

func TestLiveKitClient_ListParticipants_ReturnsParticipants(t *testing.T) {
	client := twirpServer(t, http.StatusOK, &livekit.ListParticipantsResponse{
		Participants: []*livekit.ParticipantInfo{
			{Identity: "user-1:tok"},
			{Identity: "user-2:tok"},
		},
	})

	got, err := client.ListParticipants(42)
	if err != nil {
		t.Fatalf("ListParticipants: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ListParticipants returned %d participants, want 2", len(got))
	}
	if got[0].Identity != "user-1:tok" {
		t.Errorf("participant[0].Identity = %q, want %q", got[0].Identity, "user-1:tok")
	}
}

func TestLiveKitClient_ListParticipants_ServerError(t *testing.T) {
	client := twirpServer(t, http.StatusInternalServerError, nil)

	if _, err := client.ListParticipants(42); err == nil {
		t.Error("ListParticipants against a failing server returned nil error")
	}
}

func TestLiveKitClient_CountVideoTracks(t *testing.T) {
	tests := []struct {
		name         string
		participants []*livekit.ParticipantInfo
		want         int
	}{
		{
			name: "no participants",
			want: 0,
		},
		{
			name: "audio only",
			participants: []*livekit.ParticipantInfo{
				{Tracks: []*livekit.TrackInfo{{Type: livekit.TrackType_AUDIO}}},
			},
			want: 0,
		},
		{
			name: "one video among audio",
			participants: []*livekit.ParticipantInfo{
				{Tracks: []*livekit.TrackInfo{
					{Type: livekit.TrackType_AUDIO},
					{Type: livekit.TrackType_VIDEO},
				}},
			},
			want: 1,
		},
		{
			name: "video counted across participants",
			participants: []*livekit.ParticipantInfo{
				{Tracks: []*livekit.TrackInfo{{Type: livekit.TrackType_VIDEO}}},
				{Tracks: []*livekit.TrackInfo{
					{Type: livekit.TrackType_VIDEO},
					{Type: livekit.TrackType_VIDEO},
				}},
				{Tracks: []*livekit.TrackInfo{{Type: livekit.TrackType_AUDIO}}},
			},
			want: 3,
		},
		{
			name: "participant with no tracks",
			participants: []*livekit.ParticipantInfo{
				{Identity: "user-1"},
				{Tracks: []*livekit.TrackInfo{{Type: livekit.TrackType_VIDEO}}},
			},
			want: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := twirpServer(t, http.StatusOK, &livekit.ListParticipantsResponse{
				Participants: tt.participants,
			})

			got, err := client.CountVideoTracks(7)
			if err != nil {
				t.Fatalf("CountVideoTracks: %v", err)
			}
			if got != tt.want {
				t.Errorf("CountVideoTracks = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestLiveKitClient_CountVideoTracks_PropagatesError(t *testing.T) {
	client := twirpServer(t, http.StatusInternalServerError, nil)

	got, err := client.CountVideoTracks(7)
	if err == nil {
		t.Fatal("CountVideoTracks against a failing server returned nil error")
	}
	if got != 0 {
		t.Errorf("count = %d on error, want 0", got)
	}
}

func TestLiveKitClient_HealthCheck_Success(t *testing.T) {
	client := twirpServer(t, http.StatusOK, &livekit.ListRoomsResponse{})

	ok, err := client.HealthCheck(context.Background())
	if err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	if !ok {
		t.Error("HealthCheck = false against a healthy server")
	}
}

func TestLiveKitClient_HealthCheck_ServerError(t *testing.T) {
	client := twirpServer(t, http.StatusInternalServerError, nil)

	ok, err := client.HealthCheck(context.Background())
	if err == nil {
		t.Fatal("HealthCheck against a failing server returned nil error")
	}
	if ok {
		t.Error("HealthCheck = true despite an error")
	}
}

func TestLiveKitClient_HealthCheck_Unreachable(t *testing.T) {
	client, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://127.0.0.1:1",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	ok, err := client.HealthCheck(context.Background())
	if err == nil {
		t.Fatal("HealthCheck against an unreachable server returned nil error")
	}
	if ok {
		t.Error("HealthCheck = true against an unreachable server")
	}
}
