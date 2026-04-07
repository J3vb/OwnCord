// Phase C Step 9 — plugin slash-command dispatcher.
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
	"fmt"
	"log/slog"
	"strings"

	"github.com/owncord/server/permissions"
)

const MsgTypeChatCommand = "chat_command"

// maxCommandArgs is the maximum number of arguments accepted in a
// chat_command payload. This prevents a malicious client from flooding
// the plugin's allocate/dispatch ABI with thousands of strings.
const maxCommandArgs = 64

// chatCommandPayload is the client-supplied payload for a chat_command message.
type chatCommandPayload struct {
	ChannelID int64    `json:"channel_id"`
	Command   string   `json:"command"` // including leading slash, e.g. "/hello"
	Args      []string `json:"args"`
}

// registerPluginCommandHandler registers the chat_command V1 handler.
func registerPluginCommandHandler(r *HandlerRegistry) {
	r.Register(MsgTypeChatCommand, handlePluginCommand)
}

// handlePluginCommand dispatches a slash command to the owning plugin via
// hub.pluginRegistry. Returns an error to the client when:
//   - the payload is malformed,
//   - the command name is empty,
//   - too many arguments are supplied,
//   - no plugin owns the command (unknown command),
//   - the plugin returns an error reply.
func handlePluginCommand(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {
	var p chatCommandPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid chat_command payload"))
		return
	}

	cmd := strings.TrimSpace(p.Command)
	if cmd == "" {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "command must not be empty"))
		return
	}

	if len(p.Args) > maxCommandArgs {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, fmt.Sprintf("too many command arguments (max %d)", maxCommandArgs)))
		return
	}

	if h.pluginRegistry == nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, fmt.Sprintf("unknown command: %s (no plugins loaded)", cmd)))
		return
	}

	result, handled := h.pluginRegistry.DispatchCommand(ctx, c.userID, p.ChannelID, cmd, p.Args)
	if !handled {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, fmt.Sprintf("unknown command: %s", cmd)))
		return
	}

	if result == nil {
		// Plugin acknowledged with no output.
		return
	}

	if result.Reply != "" {
		// Ephemeral reply — sent only to the invoking client.
		c.sendMsg(buildCommandReply(reqID, result.Reply))
	}

	if result.Broadcast != "" && p.ChannelID != 0 {
		// Verify the invoking client has permission to send to this channel
		// before broadcasting the plugin result to all channel members.
		if !h.requireChannelPerm(c, p.ChannelID, permissions.SendMessages, "SEND_MESSAGES") {
			return
		}
		// Channel broadcast — visible to everyone in the channel.
		msg := buildCommandBroadcast(p.ChannelID, c.userID, cmd, result.Broadcast)
		h.BroadcastToChannel(p.ChannelID, msg)
		slog.Info("plugin command broadcast", "cmd", cmd, "channel_id", p.ChannelID, "user_id", c.userID)
	}
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
