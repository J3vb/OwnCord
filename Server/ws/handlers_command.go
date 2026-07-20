// Phase C Step 9 — plugin slash-command dispatcher (V2).
//
// chat_command routes a slash command from a WS client to a registered plugin.
// If no plugin owns the command, an error is returned to the sender. If the
// plugin returns a Reply, it is sent only to the invoking client (ephemeral).
// If the plugin returns a Broadcast string, it is broadcast to the channel
// only after verifying the invoking client holds SEND_MESSAGES permission.

package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/owncord/server/plugin"
	"github.com/owncord/server/service"
)

const MsgTypeChatCommand = "chat_command"

// maxCommandArgs is the maximum number of arguments accepted in a
// chat_command payload. This prevents a malicious client from flooding
// the plugin's allocate/dispatch ABI with thousands of strings.
const maxCommandArgs = 64

// handleChatCommandV2 dispatches a slash command to the owning plugin via the
// live plugin registry (wired post-construction). It returns:
//   - a ClientError when no plugin registry is wired, the command is unknown,
//     or the invoking user may not post the plugin's broadcast;
//   - Result.Reply for an ephemeral plugin reply (sender only);
//   - Result.Events with a PluginBroadcastEvent for a channel broadcast, gated
//     by MessageService.CanPost (same policy as a real message send).
func handleChatCommandV2(ctx context.Context, cmd Command, _ ClientInfo, deps any) Result {
	d := deps.(PluginDeps)
	cc := cmd.(ChatCommandCmd)

	var reg *plugin.Registry
	if d.Registry != nil {
		reg = d.Registry()
	}
	if reg == nil {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: fmt.Sprintf("unknown command: %s (no plugins loaded)", cc.command)}}
	}

	result, handled := reg.DispatchCommand(ctx, cc.userID, cc.channelID, cc.command, cc.args)
	if !handled {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: fmt.Sprintf("unknown command: %s", cc.command)}}
	}
	if result == nil {
		// Plugin acknowledged with no output.
		return Result{}
	}

	var out Result
	if result.Reply != "" {
		// Ephemeral reply — sent only to the invoking client.
		out.Reply = buildCommandReply(cc.reqID, result.Reply)
	}

	if result.Broadcast != "" && cc.channelID != 0 {
		// Verify the invoking client can post to this channel before broadcasting
		// (same gate a real send uses: channel role perms + DM membership/blocks).
		// ponytail: if the plugin returned both a reply and a broadcast and the
		// gate denies, the error wins and the ephemeral reply is dropped (Result
		// carries either an error or a reply, not both) — an untested edge; V1
		// sent both. Preserve the security signal (denial) over the ack.
		if gate := canPluginBroadcast(d.MessageSvc, cc.userID, cc.channelID); gate != nil {
			return *gate
		}
		msg := buildCommandBroadcast(cc.channelID, cc.userID, cc.command, result.Broadcast)
		out.Events = append(out.Events, PluginBroadcastEvent{channelID: cc.channelID, payload: msg})
		slog.Info("plugin command broadcast", "cmd", cc.command, "channel_id", cc.channelID, "user_id", cc.userID)
	}
	return out
}

// canPluginBroadcast reports whether userID may post to channelID by delegating
// to the SAME service-layer check a real message send runs (MessageService.CanPost:
// cached channel permissions; DM membership AND DM blocks). Returns nil when
// allowed, or a Result carrying the appropriate ClientError otherwise. A nil
// MessageSvc (bare test hub) fails closed rather than allowing an ungated
// broadcast.
func canPluginBroadcast(messageSvc *service.MessageService, userID, channelID int64) *Result {
	if messageSvc == nil {
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "broadcast gate unavailable"}}
		return &r
	}
	if err := messageSvc.CanPost(userID, channelID); err != nil {
		if errors.Is(err, service.ErrNotFound) {
			r := Result{Error: ClientError{Code: ErrCodeNotFound, Message: "channel not found"}}
			return &r
		}
		slog.Warn("ws plugin broadcast permission denied",
			"user_id", userID, "channel_id", channelID, "err", err)
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing permission to post in this channel"}}
		return &r
	}
	return nil
}

// buildCommandReply builds an ephemeral command_reply envelope.
func buildCommandReply(reqID, text string) []byte {
	type payload struct {
		Text string `json:"text"`
	}
	type envelope struct {
		Type    string  `json:"type"`
		ReqID   string  `json:"req_id,omitempty"`
		Payload payload `json:"payload"`
	}
	raw, _ := json.Marshal(envelope{
		Type:    "command_reply",
		ReqID:   reqID,
		Payload: payload{Text: text},
	})
	return raw
}

// buildCommandBroadcast builds a plugin_broadcast envelope sent to a channel.
func buildCommandBroadcast(channelID, userID int64, cmd, text string) []byte {
	type payload struct {
		ChannelID int64  `json:"channel_id"`
		UserID    int64  `json:"user_id"`
		Command   string `json:"command"`
		Text      string `json:"text"`
	}
	type envelope struct {
		Type    string  `json:"type"`
		Payload payload `json:"payload"`
	}
	raw, _ := json.Marshal(envelope{
		Type: "plugin_broadcast",
		Payload: payload{
			ChannelID: channelID,
			UserID:    userID,
			Command:   cmd,
			Text:      text,
		},
	})
	return raw
}
