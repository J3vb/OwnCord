package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// modActionPayload is the mod_action payload: targeted, unsequenced, not replayed. expires_at is nil for a
// warning and a lifted timeout.
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

// NotifyModAction delivers a live mod_action frame to userID (service.ModActionNotifier),
// targeted and unsequenced: a disconnected target sees a warning on next connect or the
// timeout on their next send. A timeout issued or lifted also re-publishes member_timeouts
// and re-sends per-channel can_send (RefreshUserChannels); an issued one schedules the same
// refresh just after expiry, since nothing else announces a natural expiry. The timer
// re-resolves live, so a stale one only re-sends current verdicts.
func (h *Hub) NotifyModAction(userID, actionID int64, kind, reason string, expiresAt *time.Time) {
	h.SendToUserLow(userID, buildModAction(actionID, kind, reason, expiresAt))
	if kind != "timeout" {
		return
	}
	h.publishMemberTimeouts(userID)
	h.RefreshUserChannels(userID)
	if expiresAt != nil {
		h.scheduleTimeoutExpiryRefresh(userID, *expiresAt)
	}
}

// scheduleTimeoutExpiryRefresh runs RefreshUserChannels for userID just after expiresAt (a
// second of slack for whole-second storage). The timer is in-memory; RearmTimeoutExpiries re-arms at startup.
func (h *Hub) scheduleTimeoutExpiryRefresh(userID int64, expiresAt time.Time) {
	time.AfterFunc(time.Until(expiresAt)+timeoutExpiryRefreshSlack, func() {
		select {
		case <-h.stop:
			return
		default:
		}
		h.publishMemberTimeouts(userID)
		h.RefreshUserChannels(userID)
		ctx, cancel := h.expiryCtx()
		defer cancel()
		h.liftExpiredTimeoutMute(ctx, userID)
	})
}

// expiryCtx is the bounded context an expiry timer's voice work runs under, derived from the
// hub's lifecycle context so Stop interrupts it (Background without NewHub).
func (h *Hub) expiryCtx() (context.Context, context.CancelFunc) {
	parent := h.lifecycle.ctx
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, timeoutExpiryVoiceBudget)
}

const timeoutExpiryVoiceBudget = 10 * time.Second

// liftExpiredTimeoutMute lifts the voice server-mute a timeout left on userID's live
// session once it expired, without waiting for the orphan reconcile tick. Only a mute with
// a moderation action id is a timeout's (a moderator's carries NULL), and only when no
// active timeout remains: a newer one took ownership. UnmuteForTimeout clears by owner, so
// an already-cleared mute makes this a no-op.
func (h *Hub) liftExpiredTimeoutMute(ctx context.Context, userID int64) {
	if h.voice == nil || h.readers.Dispatch == nil {
		return
	}
	state, err := h.voice.State(ctx, userID)
	if err != nil {
		slog.Warn("hub: timeout expiry could not read voice state", "err", err, "user_id", userID)
		return
	}
	if state == nil || !state.ServerMuted || state.ServerMutedBy == nil {
		return
	}
	active, err := h.readers.Dispatch.ListActiveTimeoutExpiries(ctx)
	if err != nil {
		slog.Warn("hub: timeout expiry could not list active timeouts", "err", err, "user_id", userID)
		return
	}
	for _, t := range active {
		if t.UserID == userID {
			return
		}
	}
	h.UnmuteForTimeout(ctx, userID, []int64{*state.ServerMutedBy})
}

// RearmTimeoutExpiries schedules the expiry refresh for every active timeout, replacing
// timers a previous process lost. Called once at startup, so the list is read against Background.
func (h *Hub) RearmTimeoutExpiries() {
	if h.db == nil {
		return
	}
	active, err := h.readers.Dispatch.ListActiveTimeoutExpiries(context.Background())
	if err != nil {
		slog.Warn("hub: RearmTimeoutExpiries could not list active timeouts", "err", err)
		return
	}
	for _, t := range active {
		h.scheduleTimeoutExpiryRefresh(t.UserID, t.ExpiresAt)
	}
}

const timeoutExpiryRefreshSlack = time.Second

// RefreshUserChannels re-sends userID's live client a channel_create for every visible
// non-DM channel with its current affordances (RefreshChannelVisibility's per-recipient
// send, for a change moving only this user's verdicts: Subject.TimedOut). Hidden channels
// are skipped, not sent a channel_delete that would disclose their IDs. It bumps the
// visibility watermark so an offline or mid-reconnect user resumes onto a fresh ready.
func (h *Hub) RefreshUserChannels(userID int64) {
	h.MarkVisibilityChanged()
	defer h.bumpVisibilityWatermark()
	if h.db == nil || !h.isConnected(userID) {
		return
	}
	ctx := context.Background()
	channels, err := h.readers.Visibility.ListChannels(ctx)
	if err != nil {
		slog.Warn("hub: RefreshUserChannels could not list channels", "user_id", userID, "err", err)
		return
	}
	privacy := h.privacySnapshot(ctx)
	for i := range channels {
		ch := &channels[i]
		if ch.Type == "dm" {
			continue
		}
		sub, err := h.subjectFor(ctx, userID, ch.ID)
		if err != nil {
			continue
		}
		sub.Channel = channelRef(ch)
		if permissions.CanViewChannel(sub) != nil {
			continue
		}
		// Re-resolved per send: a reconnect can replace a client during the lookups; every device gets it.
		conns := h.clientsOf(userID)
		if len(conns) == 0 {
			return
		}
		var frame []byte
		for _, live := range conns {
			if !live.sendsChannel(ch.Type) {
				continue
			}
			if frame == nil {
				frame = buildChannelCreateFor(ch, privacy.PrivateOf(ch), affordancesFor(sub))
			}
			live.sendMsg(frame)
		}
	}
}

// MuteForTimeout applies the voice half of a timeout on userID's current voice connection
// through voice_mod_mute's mechanism (service.TimeoutVoiceMuter). channelID and joinedAt are
// the exact session the caller authorized (ModerationService.actorCanModerateVoiceFor); the
// write binds to it rather than re-resolving the target's state, which may be an
// unauthorized channel or a rejoin. The DB transition and SFU call run under the per-user
// lock (voiceHub.mod) shared with UnmuteForTimeout and the manual mute endpoint, so a late unmute
// racing this call runs both of its steps before the other starts either. If the SFU
// call fails after a genuine DB transition the DB is rolled back under the same lock via
// UnmuteForTimeout scoped to this actionID, so applied/owned both report false.
// applied: the mute is in effect (already muted counts) or the SFU accepted a fresh one.
// owned: this call caused the unmuted-to-muted transition; false means someone else already
// muted. supersededIDs transfers ownership onto actionID inside this lock hold and the same
// DB transaction as the mute. TimeoutUser does not transfer on its own: a transfer landing between
// another action's DB write and SFU call could move ownership out from under its
// rollback-on-SFU-failure, which scopes to its own actionID and would find nothing to undo.
func (h *Hub) MuteForTimeout(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (applied, owned bool) {
	if h.voice == nil {
		return false, false
	}
	unlock := h.voiceHub.mod.Lock(userID)
	defer unlock()

	matched, transitioned, err := h.voice.MuteForTimeoutSession(ctx, userID, channelID, actionID, joinedAt, supersededIDs)
	if err != nil {
		slog.Error("ws MuteForTimeout MuteForTimeoutSession", "err", err, "user_id", userID)
		return false, false
	}
	if !matched {
		return false, false
	}
	if !transitioned {
		// Already muted (this action's own reclaimed mute counts as transitioned): nothing for the SFU, not
		// this call's to own.
		return true, false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, true); err != nil {
		// An SFU failure means the client never hears the effect: not applied; roll the DB back under the
		// same lock.
		slog.Warn("ws MuteForTimeout MuteParticipant failed, rolling back", "err", err, "user_id", userID, "channel_id", channelID)
		if _, _, _, rbErr := h.voice.ClearServerMuteOwnedBy(ctx, userID, []int64{actionID}); rbErr != nil {
			slog.Error("ws MuteForTimeout rollback failed", "err", rbErr, "user_id", userID, "action_id", actionID)
		}
		return false, false
	}
	h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, true)
	return true, true
}

// UnmuteForTimeout clears the mute owned by any of actionIDs (a lift's id or its supersede
// chain) (service.TimeoutVoiceMuter). Session-bound: a rejoin starts a fresh row with
// server_muted_by NULL, so an old id cannot clear an unrelated mute. Runs under the same
// per-user lock as MuteForTimeout and the manual mute endpoint.
func (h *Hub) UnmuteForTimeout(ctx context.Context, userID int64, actionIDs []int64) bool {
	if h.voice == nil || len(actionIDs) == 0 {
		return false
	}
	unlock := h.voiceHub.mod.Lock(userID)
	defer unlock()

	channelID, joinedAt, matched, err := h.voice.ClearServerMuteOwnedBy(ctx, userID, actionIDs)
	if err != nil {
		slog.Error("ws UnmuteForTimeout ClearServerMuteOwnedBy", "err", err, "user_id", userID)
		return false
	}
	if !matched {
		// Nothing owned by any of actionIDs (ended session, manual takeover, already cleared): no-op.
		return false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, false); err != nil {
		slog.Warn("ws UnmuteForTimeout MuteParticipant failed", "err", err, "user_id", userID, "channel_id", channelID)
	}
	h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, false)
	return true
}

// broadcastVoiceMuteState re-reads userID's voice state and broadcasts it with ServerMuted
// set only if it still matches the exact session this write applied to; otherwise a racing
// channel switch would show a stale mute flag on the wrong room.
func (h *Hub) broadcastVoiceMuteState(ctx context.Context, userID, channelID int64, joinedAt string, muted bool) {
	state, err := h.voice.State(ctx, userID)
	if err != nil || state == nil || state.ChannelID != channelID || state.JoinedAt != joinedAt {
		return
	}
	state.ServerMuted = muted
	h.broadcastVoiceEvent(ctx, channelID, userID, buildVoiceState(*state))
}
