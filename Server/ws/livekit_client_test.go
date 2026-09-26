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

// LiveKitClient.HealthCheck had no coverage.
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
