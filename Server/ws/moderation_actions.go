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
// (VoiceStore.CompareAndSetServerMute plus the SFU mute) rather than a
// second path to the same effect (decision 6). Satisfies
// service.TimeoutVoiceMuter. channelID and joinedAt are the EXACT session
// the caller already authorized against (ModerationService.
// actorCanModerateVoiceFor, P1-3) — this method binds its write to that
// session rather than re-resolving the target's current voice state, which
// could by then be a different (unauthorized) channel or a leave-and-rejoin
// of the same one (P1-3 PARTIAL, Codex review round 3).
//
// Reports applied (the mute/unmute actually took effect, including at the
// SFU — an SFU failure is NOT applied, P3-14 PARTIAL: the DB half alone is
// not enough to call this "applied" when the mechanism the client actually
// hears is the SFU) and, for muted=true only, owned (this call caused the
// unmuted->muted transition — false means the target was already
// server-muted by someone/something else, so the caller must not record
// ownership of a mute it does not own, P1-4 PARTIAL). owned is meaningless
// for muted=false and always false there.
func (h *Hub) ApplyTimeoutMute(ctx context.Context, userID, channelID int64, joinedAt string, muted bool) (applied, owned bool) {
	if h.voice == nil {
		return false, false
	}
	matched, transitioned, err := h.voice.CompareAndSetServerMute(ctx, userID, channelID, joinedAt, muted)
	if err != nil {
		slog.Error("ws ApplyTimeoutMute CompareAndSetServerMute", "err", err, "user_id", userID)
		return false, false
	}
	if !matched {
		// The target already left this exact session (channel or join
		// instance) between authorization and this call — nothing to mute
		// there. The compare-and-mute above is the lock: its own atomic
		// read-then-write, not a separate read here racing the target's own
		// channel switch.
		return false, false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, muted); err != nil {
		// An SFU failure means the client never actually hears the effect,
		// so this is NOT applied (P3-14 PARTIAL) — unlike voice_mod_mute's
		// own tolerance of a LiveKit failure (its DB row is the whole of
		// that feature's contract), the timeout's ledger has a separate
		// voice_muted column whose entire purpose is "did the mute really
		// land", and a log line is not enough to answer that truthfully.
		slog.Warn("ws ApplyTimeoutMute MuteParticipant failed", "err", err, "user_id", userID, "channel_id", channelID)
		return false, false
	}
	if state, stateErr := h.voice.State(ctx, userID); stateErr == nil && state != nil &&
		state.ChannelID == channelID && state.JoinedAt == joinedAt {
		// Only broadcast against the same session the write applied to —
		// a state read that resolves a channel switch since the write above
		// would otherwise show a stale mute flag on the wrong room.
		state.ServerMuted = muted
		h.broadcastVoiceEvent(ctx, channelID, buildVoiceState(*state))
	}
	return true, muted && transitioned
}
