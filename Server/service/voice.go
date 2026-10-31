package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// ErrVoiceChannelFull is returned by Join when the channel's voice_max_users cap
// is met; re-stated from db.ErrChannelFull so callers need not depend on the
// persistence sentinel.
var ErrVoiceChannelFull = errors.New("voice channel is full")

// voiceStore is what VoiceService reads and writes. *db.DB satisfies it.
type voiceStore interface {
	db.Auditor
	JoinVoiceChannel(ctx context.Context, userID, channelID int64) error
	JoinVoiceChannelIfCapacity(ctx context.Context, userID, channelID int64, maxUsers int) error
	LeaveVoiceChannelIfMatch(ctx context.Context, userID, expectedChannelID int64, expectedJoinedAt string) (bool, error)
	GetVoiceState(ctx context.Context, userID int64) (*db.VoiceState, error)
	GetChannelVoiceStates(ctx context.Context, channelID int64) ([]db.VoiceState, error)
	GetAllVoiceStates(ctx context.Context) ([]db.VoiceState, error)
	UpdateVoiceMute(ctx context.Context, userID int64, muted bool) error
	UpdateVoiceDeafen(ctx context.Context, userID int64, deafened bool) error
	UpdateVoiceCamera(ctx context.Context, userID int64, camera bool) error
	EnableCameraIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	UpdateVoiceScreenshare(ctx context.Context, userID int64, screenshare bool) error
	EnableScreenshareIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	CountChannelVoiceUsers(ctx context.Context, channelID int64) (int, error)
	SetVoiceServerMute(ctx context.Context, userID, channelID int64, serverMuted bool) (matched bool, err error)
	SetVoiceServerDeafen(ctx context.Context, userID, channelID int64, serverDeafened bool) (matched bool, err error)
	// MuteForTimeoutSession is SetVoiceServerMute scoped to one exact session
	// (channelID, joinedAt), stamping actionID as owner (voice_states.server_muted_by)
	// atomically with the mute, only on a genuine unmuted-to-muted transition.
	// supersededIDs transfers ownership from just-superseded ledger ids onto actionID
	// in the same transaction; only the caller (ws.Hub, under its per-user lock) may
	// do that transfer (see TimeoutVoiceMuter.MuteForTimeout).
	MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (matched, transitioned bool, err error)
	// ClearServerMuteOwnedBy clears server_muted for the voice_states row naming one
	// of actionIDs as owner and reports its channel/join token for the paired SFU call.
	ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (channelID int64, joinedAt string, matched bool, err error)
}

// VoiceService owns the voice_states table: who is in which voice channel, since
// when, and the self- and moderator-imposed flags. The hub keeps the transport
// (SFU round trips, pub/sub topics, key-holder election, broadcasts) and asks
// this service for the row. A membership is written from four goroutines that
// never see each other (the member's pump, a moderator's pump, the stale sweep,
// the LiveKit webhook), so the rules about WHICH row a write may touch live here:
//
//   - every write after an authorization decision is scoped to the channel that
//     was authorized, so a target switching channels mid-request is not followed
//     onto a channel nobody checked;
//   - compensating writes (rollback, restore) run on a context detached from the
//     request, since the cancellation that triggered them must not abort them.
type VoiceService struct {
	st voiceStore
	// callLog is told about completed DM joins and voice row deletes to keep the call
	// log. Set by service.New; nil in a standalone service, where the notes do nothing.
	callLog *CallLogService
}

// NewVoiceService creates a VoiceService.
func NewVoiceService(st voiceStore) *VoiceService {
	return &VoiceService{st: st}
}

// SetCallLog installs the call log that join and leave notes go to.
func (s *VoiceService) SetCallLog(c *CallLogService) { s.callLog = c }

// NoteJoinCompleted tells the call log userID finished joining channelID. The hub
// calls it only after voiceJoinComplete succeeds, so a rolled-back join is never a
// participant. It never blocks.
func (s *VoiceService) NoteJoinCompleted(channelID, userID int64) {
	s.callLog.NoteJoin(channelID, userID, time.Now().UTC())
}

// State returns the user's current voice membership, or (nil, nil) when they
// are not in a voice channel.
func (s *VoiceService) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	return s.st.GetVoiceState(ctx, userID)
}

// ChannelStates returns every membership in one voice channel.
func (s *VoiceService) ChannelStates(ctx context.Context, channelID int64) ([]db.VoiceState, error) {
	return s.st.GetChannelVoiceStates(ctx, channelID)
}

// AllStates returns every voice membership: the stale sweep's input, reconciled
// against the hub's live client map.
func (s *VoiceService) AllStates(ctx context.Context) ([]db.VoiceState, error) {
	return s.st.GetAllVoiceStates(ctx)
}

// CountInChannel reports how many users are in a voice channel. Advisory: a
// concurrent join can invalidate it; Join's capacity branch is the atomic check.
func (s *VoiceService) CountInChannel(ctx context.Context, channelID int64) (int, error) {
	return s.st.CountChannelVoiceUsers(ctx, channelID)
}

// Join persists userID's membership of channelID. maxUsers is the cap for this
// joiner: the channel's voice_max_users, or 0 for a voice moderator there
// (ws.voiceJoinCapacity). Positive takes the capacity-checked insert (count and
// insert in one statement, so two joins racing for the last slot cannot both win)
// and returns ErrVoiceChannelFull when met; zero or negative takes the plain
// upsert. One method, so the only way past the cap is passing 0, the moderator
// decision made in one place.
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

// LeaveIfMatch deletes the membership only while it still names channelID and the
// caller's snapshotted joinedAt, reporting whether a row went. Every delete is
// this one: a user who rejoined or moved has a NEWER row that an unconditional
// delete by user id would destroy.
func (s *VoiceService) LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error) {
	deleted, err := s.st.LeaveVoiceChannelIfMatch(ctx, userID, channelID, joinedAt)
	if deleted {
		s.callLog.NoteLeave(channelID, time.Now().UTC())
	}
	return deleted, err
}

// Self flags: the user's own mute/deafen/camera/screenshare. Unlike moderator
// flags they are not channel-scoped; they follow the member across a switch.

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

// ReserveCamera turns the camera on only while the channel is under its shared
// video budget, counting and setting in one statement; false when spent.
func (s *VoiceService) ReserveCamera(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	return s.st.EnableCameraIfUnderLimit(ctx, userID, channelID, maxVideo)
}

// ReserveScreenshare is ReserveCamera for screenshare. Both count
// `camera = 1 OR screenshare = 1` against one per-channel cap, so neither kind
// slips past by ignoring the other.
func (s *VoiceService) ReserveScreenshare(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	return s.st.EnableScreenshareIfUnderLimit(ctx, userID, channelID, maxVideo)
}

// SetServerMute applies or lifts a moderator mute, scoped to the channel the
// caller authorized against. false means the target's membership moved off that
// channel before this write; the caller must refuse rather than follow them.
func (s *VoiceService) SetServerMute(ctx context.Context, userID, channelID int64, muted bool) (bool, error) {
	return s.st.SetVoiceServerMute(ctx, userID, channelID, muted)
}

// MuteForTimeoutSession is SetServerMute scoped to one exact voice session
// (channelID, joinedAt), stamping actionID as owner atomically with the mute:
// the timeout voice half's authorization and SFU mute must bind to the SAME
// session, not one a later read could resolve differently.
func (s *VoiceService) MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (matched, transitioned bool, err error) {
	return s.st.MuteForTimeoutSession(ctx, userID, channelID, actionID, joinedAt, supersededIDs)
}

// ClearServerMuteOwnedBy clears the mute owned by any of actionIDs and reports its
// channel/join token for the paired SFU call (see db.DB.ClearServerMuteOwnedBy).
func (s *VoiceService) ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (channelID int64, joinedAt string, matched bool, err error) {
	return s.st.ClearServerMuteOwnedBy(ctx, userID, actionIDs)
}

// SetServerDeafen is SetServerMute for server_deafened, with the same scoping and
// meaning of false.
func (s *VoiceService) SetServerDeafen(ctx context.Context, userID, channelID int64, deafened bool) (bool, error) {
	return s.st.SetVoiceServerDeafen(ctx, userID, channelID, deafened)
}

// RestoreModFlags re-applies a moderator mute/deafen onto a just re-created
// membership: a channel switch deletes and re-inserts the row, so without this a
// member could clear a mute by hopping channels. It returns the re-read row so
// the broadcast carries the restored flags; nil means nothing to restore or the
// re-read failed. Every write is best-effort: a failure must not fail the join,
// and nothing is written when neither flag is set.
//
// serverMutedBy is the PRIOR session's owner. A timeout-owned mute carries that
// ownership onto the fresh session through MuteForTimeoutSession, which also
// refuses when the owner is no longer active (lifted or expired before the
// reconcile sweep): resurrecting a sanction with no owner left to clear it is
// worse than dropping it early. nil means a manual moderator mute (or none),
// restored ownerless.
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

// RollbackServerDeafen undoes a server_deafened write whose paired server_muted
// write failed. They are separate statements, and the pair never allowed to
// persist is deafened=1 with muted=0 (not muted at the SFU yet refusing the
// target's own undeafen). requestedDeafen is the ORIGINAL direction and decides
// the undo's channel:
//
//   - a deafen (true) rolls back by CLEARING, which cannot authorize anything, so
//     it follows the row to its current channel (a switch is the likeliest reason
//     the paired write missed);
//   - an undeafen (false) rolls back by RE-APPLYING, scoped to authorizedChannelID
//     so it never stamps a restriction onto a channel the actor was not
//     authorized against, and matches nothing if the target moved.
//
// Detached from ctx: the cancellation that likely caused the failure must not
// abort the undo.
func (s *VoiceService) RollbackServerDeafen(ctx context.Context, targetID, authorizedChannelID int64, requestedDeafen bool) {
	compCtx := context.WithoutCancel(ctx)
	cur, err := s.State(compCtx, targetID)
	if err != nil {
		slog.Error("voice: reading state for a server-deafen rollback", "err", err, "target_id", targetID)
		return
	}
	if cur == nil {
		// The target left voice; no row left to undo.
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

// WriteModAudit records one voice-moderation action on a detached ctx, so the
// row survives the moderator's connection dying right after the effect.
func (s *VoiceService) WriteModAudit(ctx context.Context, actorID int64, action string, targetID int64, detail string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, action, "user", targetID, detail)
}
