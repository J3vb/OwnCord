package ws

// oc_cleanup_voice_async_test.go — CleanupVoiceForChannel must not block its
// caller (admin archive/delete) on per-participant LiveKit removals.
//
// finishVoiceLeave already moved RemoveParticipant off the request path via
// removeLiveKitParticipantAsync after OC-0453 measured 3-6 s stalls for a
// client closing its own session; CleanupVoiceForChannel was the one path left
// calling h.livekit.RemoveParticipant synchronously, bounded only by
// lkTimeout (5 s) against context.Background(), so archiving or deleting a
// populated channel held the admin request for 5 s per participant.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	lkproto "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
)

func TestCleanupVoiceForChannel_DoesNotWaitOnLiveKitRemoval(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "cleanup-slow-lk")
	chID := mustCreateVoiceChannel(t, database, "voice-cleanup-slow")
	if err := database.JoinVoiceChannel(context.Background(), uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Slow LiveKit: records the removed identity, then holds the response
	// until the test releases it.
	removed := make(chan string, 1)
	proceed := make(chan struct{})
	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req lkproto.RoomParticipantIdentity
		_ = proto.Unmarshal(body, &req)
		removed <- req.GetRoom() + "/" + req.GetIdentity()
		<-proceed
		out, _ := proto.Marshal(&lkproto.RemoveParticipantResponse{})
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	}))
	defer lkSrv.Close()
	defer close(proceed) // unblocks the held handler before lkSrv.Close waits

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + lkSrv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})

	returned := make(chan struct{})
	go func() {
		h.CleanupVoiceForChannel(chID)
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("CleanupVoiceForChannel is still waiting on LiveKit's RemoveParticipant — an admin archive/delete would block per participant")
	}
	select {
	case <-removed:
	case <-time.After(5 * time.Second):
		t.Fatal("CleanupVoiceForChannel never removed the participant from LiveKit")
	}
}
