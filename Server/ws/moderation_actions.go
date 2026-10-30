package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// modActionPayload is the mod_action payload: targeted, unsequenced, not replayed.
// expires_at is nil for a warning and a lifted timeout.
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

// NotifyModAction delivers a live mod_action frame to userID
// (service.ModActionNotifier), targeted and unsequenced (SendToUserLow): a
// disconnected target sees a warning on next connect (ready's notices) or the
// timeout on their next send, so a missed frame costs nothing. A timeout issued or
// lifted also re-publishes the member_timeouts view and re-sends the target's
// per-channel can_send (RefreshUserChannels); an issued one schedules the same
// refresh just after it expires, since nothing else announces a natural expiry.
// The timer re-resolves live, so one outliving a lift or superseding timeout only
// re-sends current verdicts.
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

// scheduleTimeoutExpiryRefresh runs RefreshUserChannels for userID just after
// expiresAt; a second of slack covers expires_at's whole-second storage. The timer
// is in-memory and lost on restart; RearmTimeoutExpiries re-arms active timeouts
// at startup.
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

// expiryCtx is the bounded context an expiry timer's voice work runs under, derived
// from the hub's lifecycle context so Stop interrupts it (Background for a hub
// built without NewHub).
func (h *Hub) expiryCtx() (context.Context, context.CancelFunc) {
	parent := h.life
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, timeoutExpiryVoiceBudget)
}

// timeoutExpiryVoiceBudget bounds one expiry timer's voice unmute (a DB read plus the SFU call).
const timeoutExpiryVoiceBudget = 10 * time.Second

// liftExpiredTimeoutMute lifts the voice server-mute a timeout left on userID's
// live session once it ran out, without waiting up to fifteen minutes for the
// orphan reconcile tick. Only a mute stamped with a moderation action id is a
// timeout's (a moderator's own carries NULL and is never touched), and it is cleared
// only when userID has no active timeout left: a newer timeout that superseded the
// expired one took the mute's ownership. UnmuteForTimeout clears by owner, so a
// tick or lift that already cleared it makes this a no-op.
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

// RearmTimeoutExpiries schedules the expiry refresh for every active timeout,
// replacing timers a previous process lost. Called once at startup (no context), so
// the list is read against Background.
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

// timeoutExpiryRefreshSlack is how long after expires_at the scheduled refresh runs,
// so Subject.TimedOut already reads as expired.
const timeoutExpiryRefreshSlack = time.Second

// RefreshUserChannels re-sends userID's live client a channel_create for every
// visible non-DM channel with its current channelAffordances:
// RefreshChannelVisibility's per-recipient send, for a change moving only this
// user's verdicts (a timeout issued, lifted or expiring; Subject.TimedOut).
// Visibility cannot move on such a change, so hidden channels are skipped rather
// than sent a channel_delete that would disclose their IDs; DM payloads carry no
// can_send. It bumps the visibility watermark so a user offline or mid-reconnect
// resumes onto a fresh ready instead of replaying past the change.
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
		// Re-resolved per send, like RefreshChannelVisibility: a reconnect can replace a
		// client during the lookups above; every device gets it.
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

// MuteForTimeout applies the voice half of a timeout on userID's current voice
// connection through the mechanism voice_mod_mute uses (VoiceStore.MuteForTimeoutSession
// plus the SFU mute) (service.TimeoutVoiceMuter). channelID and joinedAt are the
// exact session the caller authorized against
// (ModerationService.actorCanModerateVoiceFor); the write binds to it rather than
// re-resolving the target's state, which could by then be an unauthorized
// channel or a rejoin.
//
// The DB transition and SFU call run under the per-user lock (voiceMod) shared
// with UnmuteForTimeout and the manual voice-mod-mute endpoint, so a late unmute
// racing this call runs both its steps before the other starts either. If the SFU
// call fails after a genuine DB transition, the DB is rolled back under the same
// lock via UnmuteForTimeout's clear scoped to this actionID, so the two never
// disagree and applied/owned both report false.
//
// applied: the mute is in effect (already muted counts) or the SFU accepted a
// fresh one; an SFU failure is not applied. owned: this call caused the
// unmuted-to-muted transition; false means someone else already muted, so the
// caller must not treat this action as responsible for clearing it.
//
// supersededIDs transfers ownership from those superseded ledger ids onto
// actionID inside this call's lock hold and the same DB transaction as the mute.
// TimeoutUser does not transfer on its own: a transfer landing between another
// action's DB write and its SFU call (a bare DB write outside any lock) could
// move ownership out from under that action's rollback-on-SFU-failure, which
// scopes its clear to its own actionID and would find nothing to undo.
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
		// The target already left this exact session between authorization and this call.
		return false, false
	}
	if !transitioned {
		// Already muted (by someone else; this action's own mute reclaimed from an
		// inactive owner counts as transitioned=true): nothing for the SFU, and not this
		// call's mute to own.
		return true, false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, true); err != nil {
		// An SFU failure means the client never hears the effect, so this is not applied:
		// roll the DB transition back under the same lock so the two do not disagree.
		slog.Warn("ws MuteForTimeout MuteParticipant failed, rolling back", "err", err, "user_id", userID, "channel_id", channelID)
		if _, _, _, rbErr := h.voice.ClearServerMuteOwnedBy(ctx, userID, []int64{actionID}); rbErr != nil {
			slog.Error("ws MuteForTimeout rollback failed", "err", rbErr, "user_id", userID, "action_id", actionID)
		}
		return false, false
	}
	h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, true)
	return true, true
}

// UnmuteForTimeout clears the mute currently owned by any of actionIDs (a lift's
// action id or its supersede chain) (service.TimeoutVoiceMuter). Session-bound: an
// ended session has no row to match, and a rejoin starts a fresh row with
// server_muted_by NULL, so an old action id cannot clear an unrelated new mute.
// Runs under the same per-user lock as MuteForTimeout and the manual mute endpoint.
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
		// Nothing owned by any of actionIDs (ended/restarted session, a manual mute that
		// took over, or already cleared): a no-op.
		return false
	}
	if err := h.MuteParticipant(ctx, channelID, userID, joinedAt, false); err != nil {
		// The DB already reflects "unmuted"; the SFU is best-effort, as for voice_mod_mute's unmute.
		slog.Warn("ws UnmuteForTimeout MuteParticipant failed", "err", err, "user_id", userID, "channel_id", channelID)
	}
	h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, false)
	return true
}

// broadcastVoiceMuteState re-reads userID's voice state and, if it still matches
// the exact session (channelID, joinedAt) this write applied to, broadcasts it with
// ServerMuted set to muted; otherwise a channel switch racing this write would
// show a stale mute flag on the wrong room.
func (h *Hub) broadcastVoiceMuteState(ctx context.Context, userID, channelID int64, joinedAt string, muted bool) {
	state, err := h.voice.State(ctx, userID)
	if err != nil || state == nil || state.ChannelID != channelID || state.JoinedAt != joinedAt {
		return
	}
	state.ServerMuted = muted
	h.broadcastVoiceEvent(ctx, channelID, userID, buildVoiceState(*state))
}
