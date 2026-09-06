package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// ErrVoiceChannelFull is returned by Join when the channel's voice_max_users
// cap is already met. The store reports this as db.ErrChannelFull; the
// service re-states it so a caller can branch on the refusal without
// depending on the persistence layer's sentinel.
var ErrVoiceChannelFull = errors.New("voice channel is full")

// VoiceService owns the voice_states table: who is in which voice channel,
// since when, and the self- and moderator-imposed flags on that membership.
//
// The B3-8 voice family moved these decisions off the hub. The hub keeps
// everything that is genuinely transport — the SFU round trips, the pub/sub
// topics, key-holder election and the broadcasts — and asks this service for
// the row. The split matters because a voice membership is written from four
// goroutines that never see each other (the member's own read pump, a
// moderator's read pump, the stale sweep, and the LiveKit webhook), so the
// rules about WHICH row a write may touch have to live in one place:
//
//   - every write that follows an authorization decision is scoped to the
//     channel that was authorized, so a target who switches channels
//     mid-request is never followed onto a channel nobody checked;
//   - the compensating writes (rollback, restore) run on a context detached
//     from the request, because the cancellation that triggered them must not
//     also abort them.
type VoiceService struct {
	st Store
}

// NewVoiceService creates a VoiceService.
func NewVoiceService(st Store) *VoiceService {
	return &VoiceService{st: st}
}

// ── Reads ───────────────────────────────────────────────────────────────────

// State returns the user's current voice membership, or (nil, nil) when they
// are not in a voice channel.
func (s *VoiceService) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	return s.st.GetVoiceState(ctx, userID)
}

// ChannelStates returns every membership in one voice channel.
func (s *VoiceService) ChannelStates(ctx context.Context, channelID int64) ([]db.VoiceState, error) {
	return s.st.GetChannelVoiceStates(ctx, channelID)
}

// AllStates returns every voice membership on the server — the stale sweep's
// input, reconciled against the hub's live client map.
func (s *VoiceService) AllStates(ctx context.Context) ([]db.VoiceState, error) {
	return s.st.GetAllVoiceStates(ctx)
}

// CountInChannel reports how many users are currently in a voice channel.
// Advisory only: it answers "is there room right now", which a concurrent
// join can invalidate before the caller acts on it. Join's capacity branch is
// the atomic check.
func (s *VoiceService) CountInChannel(ctx context.Context, channelID int64) (int, error) {
	return s.st.CountChannelVoiceUsers(ctx, channelID)
}

// ── Membership ──────────────────────────────────────────────────────────────

// Join persists userID's membership of channelID. maxUsers is the channel's
// voice_max_users; a positive value takes the capacity-checked insert, which
// counts and inserts in one statement so two joins racing for the last slot
// cannot both win, and returns ErrVoiceChannelFull when the cap is met. Zero
// or negative means the channel is uncapped and takes the plain upsert.
//
// The two forms are one method because the choice belongs to the row, not to
// the caller: a handler that reads a cap and then picks the unchecked insert
// would silently defeat the limit.
func (s *VoiceService) Join(ctx context.Context, userID, channelID int64, maxUsers int) error {
	if maxUsers > 0 {
		err := s.st.JoinVoiceChannelIfCapacity(ctx, userID, channelID, maxUsers)
		if errors.Is(err, db.ErrChannelFull) {
			return fmt.Errorf("Join: %w", ErrVoiceChannelFull)
		}
		if err != nil {
			return fmt.Errorf("Join: %w", err)
		}
		return nil
	}
	if err := s.st.JoinVoiceChannel(ctx, userID, channelID); err != nil {
		return fmt.Errorf("Join: %w", err)
	}
	return nil
}

// LeaveIfMatch deletes the membership only while it still names channelID and
// the exact joinedAt instant the caller snapshotted, reporting whether a row
// went. Every delete in the server is this one: a user who rejoined or moved
// between the snapshot and the delete has a NEWER row, and an unconditional
// delete by user id would destroy it.
func (s *VoiceService) LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error) {
	return s.st.LeaveVoiceChannelIfMatch(ctx, userID, channelID, joinedAt)
}

// ── Self flags ──────────────────────────────────────────────────────────────
//
// The user's own mute/deafen/camera/screenshare. Unlike the moderator flags
// these are not channel-scoped: they are the member's own preference and
// follow them across a channel switch.

// SetSelfMute records the user's own mute state.
func (s *VoiceService) SetSelfMute(ctx context.Context, userID int64, muted bool) error {
	return s.st.UpdateVoiceMute(ctx, userID, muted)
}

// SetSelfDeafen records the user's own deafen state.
func (s *VoiceService) SetSelfDeafen(ctx context.Context, userID int64, deafened bool) error {
	return s.st.UpdateVoiceDeafen(ctx, userID, deafened)
}

// SetCamera records the user's camera publish state.
func (s *VoiceService) SetCamera(ctx context.Context, userID int64, enabled bool) error {
	return s.st.UpdateVoiceCamera(ctx, userID, enabled)
}

// SetScreenshare records the user's screenshare publish state.
func (s *VoiceService) SetScreenshare(ctx context.Context, userID int64, enabled bool) error {
	return s.st.UpdateVoiceScreenshare(ctx, userID, enabled)
}

// ReserveCamera turns the camera on only while the channel is under its
// shared video budget, counting and setting in one statement. Reports false
// when the budget is already spent.
func (s *VoiceService) ReserveCamera(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	return s.st.EnableCameraIfUnderLimit(ctx, userID, channelID, maxVideo)
}

// ReserveScreenshare is ReserveCamera for the screenshare column. Both count
// `camera = 1 OR screenshare = 1` against the same per-channel cap (OC-0023),
// so neither publish kind can slip past the limit by ignoring the other.
func (s *VoiceService) ReserveScreenshare(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	return s.st.EnableScreenshareIfUnderLimit(ctx, userID, channelID, maxVideo)
}

// ── Moderator flags ─────────────────────────────────────────────────────────

// SetServerMute applies or lifts a moderator-imposed mute, scoped to the
// channel the caller authorized against. It reports whether a row matched:
// false means the target's membership moved off that channel between the
// authorization and this write, and the caller must refuse rather than let
// the write follow them (OC-0005).
func (s *VoiceService) SetServerMute(ctx context.Context, userID, channelID int64, muted bool) (bool, error) {
	return s.st.SetVoiceServerMute(ctx, userID, channelID, muted)
}

// MuteForTimeoutSession is SetServerMute scoped to one exact voice session
// (channelID, joinedAt) instead of channelID alone, stamping actionID as
// owner atomically with the mute (round 4): the timeout voice half's
// authorization and its SFU mute must bind to the SAME session, not a
// channel a separate, later read could resolve differently if the target
// moved on in between.
func (s *VoiceService) MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (matched, transitioned bool, err error) {
	return s.st.MuteForTimeoutSession(ctx, userID, channelID, actionID, joinedAt, supersededIDs)
}

// ClearServerMuteOwnedBy clears the mute currently owned by any of
// actionIDs and reports its channel/join token for the paired SFU call
// (round 4) — see db.DB.ClearServerMuteOwnedBy.
func (s *VoiceService) ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (channelID int64, joinedAt string, matched bool, err error) {
	return s.st.ClearServerMuteOwnedBy(ctx, userID, actionIDs)
}

// SetServerDeafen is SetServerMute for the server_deafened column, with the
// same channel scoping and the same meaning for a false result.
func (s *VoiceService) SetServerDeafen(ctx context.Context, userID, channelID int64, deafened bool) (bool, error) {
	return s.st.SetVoiceServerDeafen(ctx, userID, channelID, deafened)
}

// RestoreModFlags re-applies a moderator-imposed mute/deafen onto a
// membership that has just been re-created — a channel switch deletes the row
// the flags lived in and re-inserts a plain one, so without this a member
// could clear a moderator's mute by hopping channels.
//
// It returns the re-read row so the caller's broadcast carries the restored
// flags rather than the insert defaults; nil means there was nothing to
// restore or the re-read failed, and the caller keeps the row it already had.
// Every write here is best-effort by design: a failure must not fail the join
// the member has already been admitted to. Nothing is written when neither
// flag is set, so an ordinary first join costs no round trips.
//
// serverMutedBy is the PRIOR session's owner (round 5, Codex review P2): a
// mute owned by a timeout must carry that SAME ownership onto the fresh
// session, through the exact conditional write a timeout's own mute uses
// (MuteForTimeoutSession) — which also refuses, leaving the fresh session
// unmuted, when that owner is no longer active (lifted, or expired in the
// gap between the switch and this restore, before the reconcile sweep next
// runs): resurrecting a sanction with no owner left to ever clear it is
// worse than dropping it early. nil means a manual moderator mute (or none
// at all), restored the old, ownerless way.
func (s *VoiceService) RestoreModFlags(ctx context.Context, userID, channelID int64, muted, deafened bool, serverMutedBy *int64) *db.VoiceState {
	if !muted && !deafened {
		return nil
	}
	if muted {
		if serverMutedBy != nil {
			if fresh, err := s.st.GetVoiceState(ctx, userID); err != nil || fresh == nil {
				slog.Error("voice: restoring an owned server mute after a channel switch", "err", err, "user_id", userID)
			} else if _, _, err := s.st.MuteForTimeoutSession(ctx, userID, channelID, *serverMutedBy, fresh.JoinedAt, nil); err != nil {
				slog.Error("voice: restoring an owned server mute after a channel switch", "err", err, "user_id", userID)
			}
		} else if _, err := s.SetServerMute(ctx, userID, channelID, true); err != nil {
			slog.Error("voice: restoring server mute after a channel switch", "err", err, "user_id", userID)
		}
	}
	if deafened {
		if _, err := s.SetServerDeafen(ctx, userID, channelID, true); err != nil {
			slog.Error("voice: restoring server deafen after a channel switch", "err", err, "user_id", userID)
		}
	}
	refreshed, err := s.State(ctx, userID)
	if err != nil || refreshed == nil {
		return nil
	}
	return refreshed
}

// RollbackServerDeafen undoes a server_deafened write whose paired
// server_muted write then failed to land. The two are separate statements —
// no transaction spans them — and the pair that is never allowed to persist is
// deafened=1 with muted=0: not muted at the SFU, yet still refusing the
// target's own undeafen, for a deafen nobody was told about.
//
// requestedDeafen is the direction of the ORIGINAL request, which decides
// which channel the undo may touch:
//
//   - a deafen (true) rolls back by CLEARING. Clearing a restriction cannot
//     authorize anything, so the undo follows the row to whatever channel it
//     is on now — which is the whole point, because a target switching
//     channels is the likeliest reason the paired write missed (OC-0034).
//   - an undeafen (false) rolls back by RE-APPLYING. Following the row there
//     would stamp a restriction onto a channel the actor was never authorized
//     against (OC-0036), so it is scoped to authorizedChannelID and simply
//     matches nothing if the target has moved.
//
// Detached from ctx: the cancellation that most likely caused the failure
// must not abort the undo as well.
func (s *VoiceService) RollbackServerDeafen(ctx context.Context, targetID, authorizedChannelID int64, requestedDeafen bool) {
	compCtx := context.WithoutCancel(ctx)
	cur, err := s.State(compCtx, targetID)
	if err != nil {
		slog.Error("voice: reading state for a server-deafen rollback", "err", err, "target_id", targetID)
		return
	}
	if cur == nil {
		// The target left voice entirely — there is no row left to undo.
		return
	}
	scope := authorizedChannelID
	if requestedDeafen {
		scope = cur.ChannelID
	}
	if _, err := s.SetServerDeafen(compCtx, targetID, scope, !requestedDeafen); err != nil {
		slog.Error("voice: rolling back a server deafen", "err", err, "target_id", targetID)
	}
}

// WriteModAudit records one voice-moderation action. Detached from ctx so the
// row survives a moderator's connection dying the instant after the effect
// landed — an unrecorded moderation action is worse than a late one.
func (s *VoiceService) WriteModAudit(ctx context.Context, actorID int64, action string, targetID int64, detail string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, action, "user", targetID, detail)
}
