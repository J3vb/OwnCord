package ws

// voice_leave_before_sfu_test.go — what the support bundle's burst of
// "RemoveParticipant failed (may already be gone)" warnings is made of.
//
// A voice_leave for a join whose client never reached the SFU (it left while
// still joining/securing) runs finishVoiceLeave, which removes that join's
// exact LiveKit identity. LiveKit answers not_found, so every such leave logs
// the warning once. Nothing on the server retries or loops: one client
// voice_join/voice_leave pair is one removal, so a burst of them every 0.3 s
// is a client sending join/leave pairs that fast.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	lkproto "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

func TestVoiceLeaveBeforeSFU_OneRemovalPerJoinLeavePair(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "pre-sfu-leaver")
	chID := mustCreateVoiceChannel(t, database, "voice-pre-sfu")

	// Fake LiveKit with no participants: rooms list empty (the join's health
	// probe passes) and every removal is not_found, as for a client that left
	// before connecting.
	var mu sync.Mutex
	var removed []string
	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/RemoveParticipant") {
			body, _ := io.ReadAll(r.Body)
			var req lkproto.RoomParticipantIdentity
			_ = proto.Unmarshal(body, &req)
			mu.Lock()
			removed = append(removed, req.GetIdentity())
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"not_found","msg":"participant not found"}`))
			return
		}
		out, _ := proto.Marshal(&lkproto.ListRoomsResponse{})
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	}))
	defer lkSrv.Close()

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + lkSrv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	c := NewTestClient(h, uid, make(chan []byte, 256))
	c.user = &db.User{ID: uid, Username: "pre-sfu-leaver"}

	// The removal warning is logged by a goroutine, so the capture is locked.
	var logMu sync.Mutex
	var logBuf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(lockedWriter{&logMu, &logBuf}, nil)))
	defer slog.SetDefault(prev)
	warnings := func() int {
		logMu.Lock()
		defer logMu.Unlock()
		return strings.Count(logBuf.String(), "RemoveParticipant failed (may already be gone)")
	}

	const pairs = 3
	for i := 1; i <= pairs; i++ {
		h.handleVoiceJoin(ctx, c, json.RawMessage(fmt.Sprintf(`{"channel_id": %d}`, chID)), "")
		if c.getVoiceChID() != chID {
			t.Fatalf("pair %d: voice_join did not complete", i)
		}
		h.handleVoiceLeave(ctx, c, voiceLeaveReasonClient)
		deadline := time.Now().Add(5 * time.Second)
		for warnings() < i && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
	}
	// Anything extra (a retry, a second removal) would land within this window.
	time.Sleep(100 * time.Millisecond)
	if got := warnings(); got != pairs {
		t.Errorf("removal warnings = %d, want one per pre-SFU leave (%d)", got, pairs)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(removed) != pairs {
		t.Fatalf("LiveKit removals = %d, want exactly one per join/leave pair (%d)", len(removed), pairs)
	}
	seen := map[string]bool{}
	for _, id := range removed {
		if seen[id] {
			t.Errorf("identity %q removed twice: the server repeated a removal", id)
		}
		seen[id] = true
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
