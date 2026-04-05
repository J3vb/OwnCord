package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/owncord/server/auth"
)

func TestPingV2_HappyPath_ReturnsPongReply(t *testing.T) {
	limiter := auth.NewRateLimiter()
	deps := PingDeps{Limiter: limiter}
	cmd := PingCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice"}

	result := handlePingV2(context.Background(), cmd, info, deps)

	if result.Reply == nil {
		t.Fatal("expected pong reply, got nil")
	}
	var reply map[string]any
	if err := json.Unmarshal(result.Reply, &reply); err != nil {
		t.Fatalf("failed to unmarshal reply: %v", err)
	}
	if reply["type"] != MsgTypePong {
		t.Errorf("expected type %q, got %q", MsgTypePong, reply["type"])
	}
}

func TestPingV2_RateLimited_ReturnsEmpty(t *testing.T) {
	limiter := auth.NewRateLimiter()
	deps := PingDeps{Limiter: limiter}
	cmd := PingCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice"}

	// Exhaust the rate limit (2 per second).
	_ = handlePingV2(context.Background(), cmd, info, deps)
	_ = handlePingV2(context.Background(), cmd, info, deps)

	// Third call should be rate limited.
	result := handlePingV2(context.Background(), cmd, info, deps)

	if result.Reply != nil {
		t.Errorf("expected nil reply when rate limited, got %s", result.Reply)
	}
	if result.Error != nil {
		t.Errorf("expected nil error when rate limited, got %v", result.Error)
	}
}

func TestPingV2_NoEvents(t *testing.T) {
	limiter := auth.NewRateLimiter()
	deps := PingDeps{Limiter: limiter}
	cmd := PingCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice"}

	result := handlePingV2(context.Background(), cmd, info, deps)

	if len(result.Events) != 0 {
		t.Errorf("expected no events, got %d", len(result.Events))
	}
}
