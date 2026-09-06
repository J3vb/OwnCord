package ws

import (
	"context"
	"log/slog"
	"time"
)

// modActionPayload is the mod_action frame's payload (B5-9): targeted,
// unsequenced, not replayed. expires_at is nil for a warning and for a
// lifted timeout; non-nil for an active timeout.
type modActionPayload struct {
	ID        int64   `json:"id"`
	Kind      string  `json:"kind"`
	Reason    string  `json:"reason"`
	ExpiresAt *string `json:"expires_at"`
}

func buildModAction(id int64, kind, reason string, expiresAt *time.Time) []byte {
	var expiresStr *string
	if expiresAt != nil {
		s := expiresAt.UTC().Format(time.RFC3339)
		expiresStr = &s
	}
	return buildJSON(wsMsg{Type: MsgTypeModAction, Payload: modActionPayload{
		ID: id, Kind: kind, Reason: reason, ExpiresAt: expiresStr,
	}})
}

// NotifyModAction delivers a live mod_action frame to userID, satisfying
// service.ModActionNotifier. Targeted and unsequenced (SendToUserLow,
// mirroring BroadcastModQueue): a disconnected target simply sees the
// warning on next connect (ready's notices) or the timeout on their next
// attempted send (the predicates), so a missed frame here costs nothing.
func (h *Hub) NotifyModAction(userID, actionID int64, kind, reason string, expiresAt *time.Time) {
	h.SendToUserLow(userID, buildModAction(actionID, kind, reason, expiresAt))
}

// ApplyTimeoutMute applies or lifts the voice half of a timeout on userID's
// current voice connection, through the exact mechanism voice_mod_mute uses
// (VoiceStore.SetServerMute plus the SFU mute) rather than a second path to
// the same effect (decision 6). Satisfies service.TimeoutVoiceMuter. Reports
// whether the mute was actually applied — false covers every no-op path (no
// voice store, no live connection, a channel-switch race that leaves
// SetServerMute unmatched), so the caller's "voice": "applied"/"skipped"
// outcome reflects what really happened (P3-14, Codex review) rather than
// merely that the call was attempted. Whether the caller is even eligible to
// attempt this is decided separately, before this is ever called
// (ModerationService.actorCanModerateVoiceFor, P1-3) — this method performs
// no authorization of its own.
func (h *Hub) ApplyTimeoutMute(ctx context.Context, userID int64, muted bool) bool {
	if h.voice == nil {
		return false
	}
	state, err := h.voice.State(ctx, userID)
	if err != nil {
		slog.Error("ws ApplyTimeoutMute State", "err", err, "user_id", userID)
		return false
	}
	if state == nil {
		return false
	}
	matched, err := h.voice.SetServerMute(ctx, userID, state.ChannelID, muted)
	if err != nil {
		slog.Error("ws ApplyTimeoutMute SetServerMute", "err", err, "user_id", userID)
		return false
	}
	if !matched {
		// The target left (or switched channels) between State and the
		// write above — nothing to mute in the channel that was read.
		return false
	}
	if err := h.MuteParticipant(ctx, state.ChannelID, userID, state.JoinedAt, muted); err != nil {
		slog.Warn("ws ApplyTimeoutMute MuteParticipant failed", "err", err, "user_id", userID, "channel_id", state.ChannelID)
	}
	// state was read before the write above; reflect it locally so the
	// broadcast carries the mute this call just applied, not the stale one.
	state.ServerMuted = muted
	h.broadcastVoiceEvent(ctx, state.ChannelID, buildVoiceState(*state))
	return true
}
