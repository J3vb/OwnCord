package ws

// oc_0453_voice_leave_livekit_async_test.go — regression test for OC-0453.
//
// handleVoiceLeave called LiveKit's RemoveParticipant on the client's read
// loop. A client leave also closes its own LiveKit session, and LiveKit
// answers a removal for that closing participant only after its 3 s routing
// timeout, so a voice_join sent straight after the leave queued behind it:
// a quick rejoin stalled 3-6 s. The removal must still happen, for the exact
// participant, but must not hold up the caller.

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
	"github.com/J3vb/OwnCord/Server/db"
)

func TestHandleVoiceLeave_DoesNotWaitOnLiveKitRemoval(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "quick-rejoin")
	chID := mustCreateVoiceChannel(t, database, "voice-rejoin")

	// Fake LiveKit server: records the removed identity, then holds the
	// response until the test releases it — a LiveKit that is slow to answer.
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
	// Runs before lkSrv.Close, which waits for the held handler.
	defer close(proceed)

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + lkSrv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})

	c := NewTestClient(h, uid, make(chan []byte, 8))
	c.user = &db.User{ID: uid, Username: "quick-rejoin"}
	c.setVoiceState(chID, "tok-leave")

	left := make(chan struct{})
	go func() {
		h.handleVoiceLeave(context.Background(), c)
		close(left)
	}()
	select {
	case <-left:
	case <-time.After(2 * time.Second):
		t.Fatal("handleVoiceLeave is still waiting on LiveKit's RemoveParticipant — a voice_join sent after the leave would queue behind it")
	}

	want := RoomName(chID) + "/" + participantIdentity(uid, "tok-leave")
	select {
	case got := <-removed:
		if got != want {
			t.Errorf("LiveKit removal = %q, want the leaver's exact participant %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handleVoiceLeave never removed the participant from LiveKit")
	}
}
