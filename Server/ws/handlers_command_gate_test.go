package ws

// handlers_command_gate_test.go — success path of the chat_command handler:
// the ephemeral reply, the MessageService.CanPost broadcast gate, and the
// plugin_broadcast fan-out. handlers_command_test.go (package ws_test) covers
// only the refusals, which it can reach through the hub; these need PluginDeps
// and the unexported command struct, so they live in-package.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
)

// stubDispatcher stands in for *plugin.Registry. A real registry is useless
// here: without the wazero build tag it has no runtime, so DispatchCommand can
// only ever return the "runtime is not built" Reply — never a Broadcast, and
// therefore never the CanPost gate below.
type stubDispatcher struct {
	result  *plugin.CommandResult
	handled bool
}

func (s stubDispatcher) DispatchCommand(_ context.Context, _, _ int64, _ string, _ []string) (*plugin.CommandResult, bool) {
	return s.result, s.handled
}

// newCommandTestDeps builds PluginDeps whose MessageSvc is the real service
// (the same CanPost a message send runs) over an in-memory DB, plus a
// dispatcher stub returning res. Returns the owner (all permissions), a user
// whose role carries none, and a text channel.
func newCommandTestDeps(t *testing.T, res *plugin.CommandResult) (deps PluginDeps, ownerID, mutedID, chID int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	ctx := context.Background()
	if ownerID, err = database.CreateUser(ctx, "cmd-owner", "hash", 1); err != nil { // Owner role
		t.Fatalf("CreateUser owner: %v", err)
	}
	role, err := database.CreateRole(ctx, "cmd-muted", nil, 0, 0) // no permission bits
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if mutedID, err = database.CreateUser(ctx, "cmd-muted-user", "hash", int(role.ID)); err != nil {
		t.Fatalf("CreateUser muted: %v", err)
	}
	if chID, err = database.CreateChannel(ctx, "cmd-chan", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	svc := service.New(database, auth.NewRateLimiter())
	deps = PluginDeps{
		Registry:   func() CommandDispatcher { return stubDispatcher{result: res, handled: true} },
		MessageSvc: svc.Messages,
	}
	return deps, ownerID, mutedID, chID
}

// A plugin Reply becomes an ephemeral command_reply envelope carrying the
// request's req_id, and reaches nobody else.
func TestHandleChatCommandV2_ReplyIsEphemeral(t *testing.T) {
	deps, ownerID, _, chID := newCommandTestDeps(t, &plugin.CommandResult{Reply: "pong"})
	cmd := ChatCommandCmd{userID: ownerID, channelID: chID, command: "/ping", reqID: "req-7"}

	result := handleChatCommandV2(context.Background(), cmd, ClientInfo{UserID: ownerID}, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if len(result.Events) != 0 {
		t.Fatalf("a reply-only command must not broadcast, got %d events", len(result.Events))
	}
	var env struct {
		Type    string `json:"type"`
		ReqID   string `json:"req_id"`
		Payload struct {
			Text string `json:"text"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(result.Reply, &env); err != nil {
		t.Fatalf("unmarshal reply %s: %v", result.Reply, err)
	}
	if env.Type != MsgTypeCommandReply {
		t.Errorf("type = %q, want %q", env.Type, MsgTypeCommandReply)
	}
	if env.ReqID != "req-7" {
		t.Errorf("req_id = %q, want req-7", env.ReqID)
	}
	if env.Payload.Text != "pong" {
		t.Errorf("text = %q, want pong", env.Payload.Text)
	}
}

// An authorized user's Broadcast fans out as a plugin_broadcast event on the
// invoking channel.
func TestHandleChatCommandV2_BroadcastFansOutWhenAllowed(t *testing.T) {
	deps, ownerID, _, chID := newCommandTestDeps(t, &plugin.CommandResult{Broadcast: "rolled a 6"})
	cmd := ChatCommandCmd{userID: ownerID, channelID: chID, command: "/roll", reqID: "req-8"}

	result := handleChatCommandV2(context.Background(), cmd, ClientInfo{UserID: ownerID}, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if len(result.Events) != 1 {
		t.Fatalf("expected 1 broadcast event, got %d", len(result.Events))
	}
	ev, ok := result.Events[0].(PluginBroadcastEvent)
	if !ok {
		t.Fatalf("expected PluginBroadcastEvent, got %T", result.Events[0])
	}
	if ev.ChannelID() != chID {
		t.Errorf("event channel = %d, want %d", ev.ChannelID(), chID)
	}
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			ChannelID int64  `json:"channel_id"`
			UserID    int64  `json:"user_id"`
			Command   string `json:"command"`
			Text      string `json:"text"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(ev.Payload(), &env); err != nil {
		t.Fatalf("unmarshal payload %s: %v", ev.Payload(), err)
	}
	if env.Type != MsgTypePluginBroadcast {
		t.Errorf("type = %q, want %q", env.Type, MsgTypePluginBroadcast)
	}
	if env.Payload.ChannelID != chID || env.Payload.UserID != ownerID {
		t.Errorf("payload ids = (%d,%d), want (%d,%d)", env.Payload.ChannelID, env.Payload.UserID, chID, ownerID)
	}
	if env.Payload.Command != "/roll" || env.Payload.Text != "rolled a 6" {
		t.Errorf("payload = %+v, want command=/roll text=rolled a 6", env.Payload)
	}
}

// The CanPost gate: a user whose role cannot post gets FORBIDDEN and nothing
// reaches the channel — even though the plugin returned a broadcast. The reply
// is dropped with it (the denial is the security signal; see handlers_command.go).
func TestHandleChatCommandV2_BroadcastDeniedWithoutPostPermission(t *testing.T) {
	deps, _, mutedID, chID := newCommandTestDeps(t, &plugin.CommandResult{Reply: "ok", Broadcast: "rolled a 6"})
	cmd := ChatCommandCmd{userID: mutedID, channelID: chID, command: "/roll", reqID: "req-9"}

	result := handleChatCommandV2(context.Background(), cmd, ClientInfo{UserID: mutedID}, deps)

	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T (%v)", result.Error, result.Error)
	}
	if ce.Code != ErrCodeForbidden {
		t.Errorf("code = %q, want %q", ce.Code, ErrCodeForbidden)
	}
	if len(result.Events) != 0 {
		t.Errorf("denied command must not broadcast, got %d events", len(result.Events))
	}
	if result.Reply != nil {
		t.Errorf("denied command must not also reply, got %s", result.Reply)
	}
}

// A broadcast aimed at a channel that does not exist is NOT_FOUND, not
// FORBIDDEN — CanPost's missing-channel branch.
func TestHandleChatCommandV2_BroadcastUnknownChannel(t *testing.T) {
	deps, ownerID, _, _ := newCommandTestDeps(t, &plugin.CommandResult{Broadcast: "hi"})
	cmd := ChatCommandCmd{userID: ownerID, channelID: 424242, command: "/roll"}

	result := handleChatCommandV2(context.Background(), cmd, ClientInfo{UserID: ownerID}, deps)

	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T (%v)", result.Error, result.Error)
	}
	if ce.Code != ErrCodeNotFound {
		t.Errorf("code = %q, want %q", ce.Code, ErrCodeNotFound)
	}
	if len(result.Events) != 0 {
		t.Errorf("expected no events, got %d", len(result.Events))
	}
}
