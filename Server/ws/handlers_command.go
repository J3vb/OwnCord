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
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// maxCommandArgs is the maximum number of arguments accepted in a
// chat_command payload. This prevents a malicious client from flooding
// the plugin's allocate/dispatch ABI with thousands of strings.
const maxCommandArgs = 64

// pluginCommandRateLimit and pluginCommandWindow cap chat_command frames per
// user (OC-0091). Every other V2 handler is throttled; this one drove a WASM
// guest invocation once per frame with no cap at all. Tighter than chat send
// (10/s) because DispatchCommand does real work per call.
const (
	pluginCommandRateLimit = 5
	pluginCommandWindow    = time.Second
)

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

	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("plugin_cmd", cc.userID), pluginCommandRateLimit, pluginCommandWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many commands"}}
	}

	var reg CommandDispatcher
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
		if gate := canPluginBroadcast(ctx, d.MessageSvc, cc.userID, cc.channelID); gate != nil {
			return *gate
		}
		msg := buildCommandBroadcast(cc.channelID, cc.userID, cc.command, result.Broadcast)
		// B5-6 (Codex P1-2): a DM's plugin broadcast must reach the same
		// sender-aware audience chat/typing/reactions do, not the plain
		// per-channel-topic fan-out — channel_focus subscribes any DM
		// participant to the topic regardless of message-request trust.
		// A lookup failure fails closed to the DM shape (sender only),
		// never to the wider, untrusted-reaching plain broadcast.
		isDM, dmErr := d.MessageSvc.ChannelIsDM(ctx, cc.channelID)
		if dmErr != nil || isDM {
			var participantIDs []int64
			if dmErr == nil {
				participantIDs, _ = d.MessageSvc.DMAudience(ctx, cc.channelID, cc.userID)
			}
			if len(participantIDs) == 0 {
				participantIDs = []int64{cc.userID}
			}
			out.Events = append(out.Events, PluginBroadcastDMEvent{channelID: cc.channelID, participantIDs: participantIDs, payload: msg})
		} else {
			out.Events = append(out.Events, PluginBroadcastEvent{channelID: cc.channelID, payload: msg})
		}
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
func canPluginBroadcast(ctx context.Context, messageSvc *service.MessageService, userID, channelID int64) *Result {
	if messageSvc == nil {
		r := Result{Error: ClientError{Code: ErrCodeForbidden, Message: "broadcast gate unavailable"}}
		return &r
	}
	if err := messageSvc.CanPost(ctx, userID, channelID); err != nil {
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
		Type:    MsgTypeCommandReply,
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
		Type: MsgTypePluginBroadcast,
		Payload: payload{
			ChannelID: channelID,
			UserID:    userID,
			Command:   cmd,
			Text:      text,
		},
	})
	return raw
}
