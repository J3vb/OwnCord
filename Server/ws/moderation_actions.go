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

// MuteForTimeout applies the voice half of a timeout on userID's current
// voice connection, through the exact mechanism voice_mod_mute uses
// (VoiceStore.MuteForTimeoutSession plus the SFU mute) rather than a second
// path to the same effect (decision 6). Satisfies service.TimeoutVoiceMuter.
// channelID and joinedAt are the EXACT session the caller already authorized
// against (ModerationService.actorCanModerateVoiceFor, P1-3) — this method
// binds its write to that session rather than re-resolving the target's
// current voice state, which could by then be a different (unauthorized)
// channel or a leave-and-rejoin of the same one (P1-3 PARTIAL).
//
// The DB transition and the SFU call run under the per-user lock
// (voiceMod, round 4 Part B) shared with UnmuteForTimeout and the manual
// voice-mod-mute endpoint: whichever of a late unmute (from a lift racing
// this call) or this mute takes the lock first runs both its own steps
// before the other can start either (Codex 12). If the SFU call fails after
// a genuine DB transition, the DB is rolled back under the SAME lock —
// reusing UnmuteForTimeout's own clear, scoped to just this actionID — so
// the two never disagree (Codex 14), and applied/owned both report false.
//
// Reports applied (the mute is genuinely in effect — already muted counts,
// nothing new for the SFU to do — or the SFU accepted a fresh one; an SFU
// failure is NOT applied, P3-14 PARTIAL) and owned (THIS call caused the
// unmuted->muted transition — false means the target was already
// server-muted by someone/something else, so the caller must not treat
// this action as responsible for later clearing it, P1-4 PARTIAL).
//
// supersededIDs transfers ownership from those just-superseded ledger ids
// onto actionID (round 4, Codex review) — but now, unlike round 4, INSIDE
// this call's own lock hold and the same DB transaction as the mute itself
// (round 5, Codex review P2): TimeoutUser no longer transfers ownership on
// its own, because a transfer landing between another action's DB write
// and its SFU call (both under ITS OWN lock hold, but the transfer was
// previously a bare DB write outside any lock) could move ownership out
// from under that action's rollback-on-SFU-failure, which scopes its
// clear to just its own actionID and would then find nothing to undo.
func (h *Hub) MuteForTimeout(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (applied, owned bool) {
	if h.voice == nil {
		return false, false
	}
	unlock := h.voiceMod.lock(userID)
	defer unlock()

	matched, transitioned, err := h.voice.MuteForTimeoutSession(ctx, userID, channelID, actionID, joinedAt, supersededIDs)
	if err != nil {
		slog.Error("ws MuteForTimeout MuteForTimeoutSession", "err", err, "user_id", userID)
		return false, false
	}
	if !matched {
		// The target already left this exact session (channel or join
		// instance) between authorization and this call — nothing to mute
		// there.
		return false, false
	}
	if !transitioned {
		// Already muted (by someone/something else, or this action's own
		// mute reclaimed from an inactive owner already counts as
		// transitioned=true) — nothing new for the SFU to do, and not this
		// call's mute to own.
		return true, false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, true); err != nil {
		// An SFU failure means the client never actually hears the effect,
		// so this is NOT applied (P3-14 PARTIAL) — roll the DB transition
		// back under the same lock so the two do not disagree (Codex 14).
		slog.Warn("ws MuteForTimeout MuteParticipant failed, rolling back", "err", err, "user_id", userID, "channel_id", channelID)
		if _, _, _, rbErr := h.voice.ClearServerMuteOwnedBy(ctx, userID, []int64{actionID}); rbErr != nil {
			slog.Error("ws MuteForTimeout rollback failed", "err", rbErr, "user_id", userID, "action_id", actionID)
		}
		return false, false
	}
	h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, true)
	return true, true
}

// UnmuteForTimeout clears the mute currently owned by any of actionIDs (a
// lift's own action id, or its whole supersede chain) — session-bound for
// free (round 4, fixing Codex 13): an ended session has no row to match, and
// a rejoin starts a fresh row with server_muted_by NULL, so an old action id
// can never clear an unrelated NEW mute. Satisfies service.TimeoutVoiceMuter.
// Runs under the same per-user lock as MuteForTimeout and the manual
// voice-mod-mute endpoint.
func (h *Hub) UnmuteForTimeout(ctx context.Context, userID int64, actionIDs []int64) bool {
	if h.voice == nil || len(actionIDs) == 0 {
		return false
	}
	unlock := h.voiceMod.lock(userID)
	defer unlock()

	channelID, joinedAt, matched, err := h.voice.ClearServerMuteOwnedBy(ctx, userID, actionIDs)
	if err != nil {
		slog.Error("ws UnmuteForTimeout ClearServerMuteOwnedBy", "err", err, "user_id", userID)
		return false
	}
	if !matched {
		// Nothing currently owned by any of actionIDs — an ended/restarted
		// session, a manual mute that has since taken over, or a mute that
		// was already cleared. Correctly a no-op either way.
		return false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, false); err != nil {
		// The DB already reflects "unmuted" -- best-effort at the SFU, the
		// same tolerance voice_mod_mute's own unmute has always had for its
		// DB row being the whole of that feature's contract.
		slog.Warn("ws UnmuteForTimeout MuteParticipant failed", "err", err, "user_id", userID, "channel_id", channelID)
	}
	h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, false)
	return true
}

// broadcastVoiceMuteState re-reads userID's current voice state and, if it
// still matches the exact session (channelID, joinedAt) this write applied
// to, broadcasts it with ServerMuted set to muted — a state read that
// resolves a channel switch racing this write would otherwise show a stale
// mute flag on the wrong room.
func (h *Hub) broadcastVoiceMuteState(ctx context.Context, userID, channelID int64, joinedAt string, muted bool) {
	state, err := h.voice.State(ctx, userID)
	if err != nil || state == nil || state.ChannelID != channelID || state.JoinedAt != joinedAt {
		return
	}
	state.ServerMuted = muted
	h.broadcastVoiceEvent(ctx, channelID, buildVoiceState(*state))
}
