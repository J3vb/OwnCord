package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ErrChannelFull is returned when a voice channel is at capacity.
var ErrChannelFull = errors.New("voice channel is full")

var voiceJoinSeq uint64

func newVoiceJoinToken() string {
	seq := atomic.AddUint64(&voiceJoinSeq, 1)
	return fmt.Sprintf("%s-%020d", time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z"), seq)
}

// JoinVoiceChannel inserts or replaces the user's voice state for the given
// channel. If the user is already in a different channel, the old row is
// replaced. Muted, deafened, and speaking are reset to false on join.
//
// joined_at doubles as an opaque join-instance token so stale cleanup can
// target one specific voice session even if the user later rejoins the same
// channel.
func (d *DB) JoinVoiceChannel(ctx context.Context, userID, channelID int64) error {
	if err := d.q.JoinVoiceChannel(ctx, dbgen.JoinVoiceChannelParams{
		UserID:    userID,
		ChannelID: channelID,
		JoinedAt:  newVoiceJoinToken(),
	}); err != nil {
		return fmt.Errorf("JoinVoiceChannel: %w", err)
	}
	return nil
}

// JoinVoiceChannelIfCapacity atomically inserts a voice state only if the
// channel has fewer than maxUsers participants. Returns ErrChannelFull when
// the channel is at capacity. This prevents the TOCTOU race where two
// concurrent joins both observe capacity and both succeed.
func (d *DB) JoinVoiceChannelIfCapacity(ctx context.Context, userID, channelID int64, maxUsers int) error {
	res, err := d.q.JoinVoiceChannelIfCapacity(ctx, dbgen.JoinVoiceChannelIfCapacityParams{
		UserID:      userID,
		ChannelID:   channelID,
		JoinedAt:    newVoiceJoinToken(),
		ChannelID_2: channelID,
		UserID_2:    userID,
		ChannelID_3: int64(maxUsers),
	})
	if err != nil {
		return fmt.Errorf("JoinVoiceChannelIfCapacity: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrChannelFull
	}
	return nil
}

// LeaveVoiceChannel removes the user's voice state entirely.
// It is safe to call when the user is not in any voice channel.
func (d *DB) LeaveVoiceChannel(ctx context.Context, userID int64) error {
	if err := d.q.LeaveVoiceChannel(ctx, userID); err != nil {
		return fmt.Errorf("LeaveVoiceChannel: %w", err)
	}
	return nil
}

// LeaveVoiceChannelIfMatch removes the user's voice state only if the row
// still points at expectedChannelID and matches the expected join token.
// Returns true if a row was deleted.
func (d *DB) LeaveVoiceChannelIfMatch(ctx context.Context, userID, expectedChannelID int64, expectedJoinedAt string) (bool, error) {
	result, err := d.q.LeaveVoiceChannelIfMatch(ctx, dbgen.LeaveVoiceChannelIfMatchParams{
		UserID:    userID,
		ChannelID: expectedChannelID,
		JoinedAt:  expectedJoinedAt,
	})
	if err != nil {
		return false, fmt.Errorf("LeaveVoiceChannelIfMatch: %w", err)
	}
	n, _ := result.RowsAffected()
	return n > 0, nil
}

// GetVoiceState returns the current voice state for the given user,
// or nil if the user is not in any voice channel.
func (d *DB) GetVoiceState(ctx context.Context, userID int64) (*VoiceState, error) {
	r, err := d.q.GetUserVoiceState(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetVoiceState: %w", err)
	}
	vs := VoiceState{
		UserID:         r.UserID,
		ChannelID:      r.ChannelID,
		Username:       r.Username,
		Muted:          r.Muted != 0,
		Deafened:       r.Deafened != 0,
		Speaking:       r.Speaking != 0,
		Camera:         r.Camera != 0,
		Screenshare:    r.Screenshare != 0,
		ServerMuted:    r.ServerMuted != 0,
		ServerDeafened: r.ServerDeafened != 0,
		JoinedAt:       r.JoinedAt,
		ServerMutedBy:  r.ServerMutedBy,
	}
	return &vs, nil
}

// GetChannelVoiceStates returns all voice states for users currently in the
// given voice channel.
func (d *DB) GetChannelVoiceStates(ctx context.Context, channelID int64) ([]VoiceState, error) {
	rows, err := d.q.GetChannelVoiceStates(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("GetChannelVoiceStates: %w", err)
	}
	states := make([]VoiceState, 0, len(rows))
	for _, r := range rows {
		states = append(states, VoiceState{
			UserID:         r.UserID,
			ChannelID:      r.ChannelID,
			Username:       r.Username,
			Muted:          r.Muted != 0,
			Deafened:       r.Deafened != 0,
			Speaking:       r.Speaking != 0,
			Camera:         r.Camera != 0,
			Screenshare:    r.Screenshare != 0,
			ServerMuted:    r.ServerMuted != 0,
			ServerDeafened: r.ServerDeafened != 0,
			JoinedAt:       r.JoinedAt,
		})
	}
	return states, nil
}

// GetAllVoiceStates returns voice states across all voice channels in a single
// query. Used at startup to build the ready payload without N+1 per-channel queries.
func (d *DB) GetAllVoiceStates(ctx context.Context) ([]VoiceState, error) {
	rows, err := d.q.GetAllVoiceStates(ctx)
	if err != nil {
		return nil, fmt.Errorf("GetAllVoiceStates: %w", err)
	}
	states := make([]VoiceState, 0, len(rows))
	for _, r := range rows {
		states = append(states, VoiceState{
			UserID:         r.UserID,
			ChannelID:      r.ChannelID,
			Username:       r.Username,
			Muted:          r.Muted != 0,
			Deafened:       r.Deafened != 0,
			Speaking:       r.Speaking != 0,
			Camera:         r.Camera != 0,
			Screenshare:    r.Screenshare != 0,
			ServerMuted:    r.ServerMuted != 0,
			ServerDeafened: r.ServerDeafened != 0,
			JoinedAt:       r.JoinedAt,
		})
	}
	return states, nil
}

// UpdateVoiceMute sets the muted field for the given user's voice state.
// It is safe to call when the user is not in any channel (no-op).
func (d *DB) UpdateVoiceMute(ctx context.Context, userID int64, muted bool) error {
	if err := d.q.UpdateVoiceMute(ctx, dbgen.UpdateVoiceMuteParams{
		Muted:  b2i64(muted),
		UserID: userID,
	}); err != nil {
		return fmt.Errorf("UpdateVoiceMute: %w", err)
	}
	return nil
}

// UpdateVoiceDeafen sets the deafened field for the given user's voice state.
// It is safe to call when the user is not in any channel (no-op).
func (d *DB) UpdateVoiceDeafen(ctx context.Context, userID int64, deafened bool) error {
	if err := d.q.UpdateVoiceDeafen(ctx, dbgen.UpdateVoiceDeafenParams{
		Deafened: b2i64(deafened),
		UserID:   userID,
	}); err != nil {
		return fmt.Errorf("UpdateVoiceDeafen: %w", err)
	}
	return nil
}

// SetVoiceServerMute applies or clears the moderator-imposed mute, scoped to
// channelID -- the channel the caller's authorization check passed for.
// Applying it also sets muted so the client state matches immediately;
// clearing it leaves muted alone, so a user who was muted before the
// moderator acted stays muted until they unmute themselves.
//
// Reports matched=false when the target's voice_states row is no longer in
// channelID (OC-0005): a channel switch racing the moderator's DB round
// trips must not let this write land on whatever channel the target moved
// to, including a DM call nobody was authorized against. The row is left
// untouched in that case, same as if the write had never happened.
func (d *DB) SetVoiceServerMute(ctx context.Context, userID, channelID int64, serverMuted bool) (matched bool, err error) {
	var res sql.Result
	if serverMuted {
		res, err = d.q.ApplyVoiceServerMute(ctx, dbgen.ApplyVoiceServerMuteParams{UserID: userID, ChannelID: channelID})
	} else {
		res, err = d.q.ClearVoiceServerMute(ctx, dbgen.ClearVoiceServerMuteParams{UserID: userID, ChannelID: channelID})
	}
	if err != nil {
		return false, fmt.Errorf("SetVoiceServerMute: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MuteForTimeoutSession is the timeout voice half's mute (P1-3/P1-4 PARTIAL
// round 3; reworked round 4, Codex review, onto the session-ownership model
// — see migration 049's comment on voice_states.server_muted_by). Matched
// against the EXACT session — channelID and joinedAt, the join-instance
// token JoinVoiceChannel mints — the caller already authorized. A single
// conditional UPDATE (WHERE server_muted = 0) both applies the mute AND
// stamps actionID as owner, only on a genuine unmuted->muted transition, so
// there is no gap between "mute lands" and "ownership recorded" for a
// concurrent lift to race (round 3's Codex 16 is now structurally
// impossible, not merely guarded against).
//
// matched=false covers "no such session" (the target left/switched between
// authorization and this call, P1-3 PARTIAL) and "the incoming actionID is
// no longer an active timeout on this target" (round 5, Codex review P2: a
// delayed call, reaching the SFU/DB after its own row was already lifted or
// expired, must be refused, not treated as a fresh or reclaimed mute) —
// disambiguated from "already muted by someone/something else" (matched=
// true, transitioned=false, not this call's ownership to claim) only when
// the conditional UPDATE itself affects zero rows.
//
// supersededIDs, when non-empty, transfers ownership from those (just-
// superseded, round 4 Codex review) ledger ids onto actionID FIRST, inside
// this SAME transaction (round 5, Codex review P2): TimeoutUser no longer
// does this transfer itself, because it must happen under the ws-layer
// per-target lock the caller (ws.Hub.MuteForTimeout) already holds for the
// paired SFU call, not as a bare DB write racing that lock from outside it
// — a transfer landing between the lock's DB write and its SFU call is
// exactly the gap that let a failed caller's rollback miss the row a
// concurrent supersede had already re-pointed elsewhere.
func (d *DB) MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (matched, transitioned bool, err error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, false, fmt.Errorf("MuteForTimeoutSession begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := dbgen.New(tx)

	if len(supersededIDs) > 0 {
		if err := transferVoiceMuteOwnership(ctx, tx, supersededIDs, actionID); err != nil {
			return false, false, fmt.Errorf("MuteForTimeoutSession transfer: %w", err)
		}
	}

	res, err := q.MuteForSession(ctx, dbgen.MuteForSessionParams{
		ActionID: &actionID, UserID: userID, ChannelID: channelID, JoinedAt: joinedAt,
	})
	if err != nil {
		return false, false, fmt.Errorf("MuteForTimeoutSession: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		if err := tx.Commit(); err != nil {
			return false, false, fmt.Errorf("MuteForTimeoutSession commit: %w", err)
		}
		return true, true, nil
	}
	found, err := q.VoiceSessionExists(ctx, dbgen.VoiceSessionExistsParams{
		UserID: userID, ChannelID: channelID, JoinedAt: joinedAt,
	})
	if err != nil {
		return false, false, fmt.Errorf("MuteForTimeoutSession exists check: %w", err)
	}
	if found == 0 {
		if err := tx.Commit(); err != nil {
			return false, false, fmt.Errorf("MuteForTimeoutSession commit: %w", err)
		}
		return false, false, nil
	}
	active, err := q.TimeoutActionIsActiveForTarget(ctx, dbgen.TimeoutActionIsActiveForTargetParams{ID: actionID, TargetID: userID})
	if err != nil {
		return false, false, fmt.Errorf("MuteForTimeoutSession active check: %w", err)
	}
	// Nothing was written either way — no ownership to commit, but a plain
	// read inside this tx costs nothing to finish cleanly.
	if err := tx.Commit(); err != nil {
		return false, false, fmt.Errorf("MuteForTimeoutSession commit: %w", err)
	}
	if active == 0 {
		// The incoming action is no longer live (lifted or expired) — not
		// this call's mute to claim, regardless of the session's own state.
		return false, false, nil
	}
	return true, false, nil
}

// ClearServerMuteOwnedBy clears server_muted for whichever voice_states row
// (at most one — user_id is the table's primary key) currently names one of
// actionIDs as server_muted_by, and reports that row's channel/join-instance
// token for the caller's paired SFU call. Session-bound for free (round 4,
// Codex review, fixing round 3's Codex 13): an ended session has no row to
// match, and a rejoin starts a fresh row with server_muted_by NULL, so an
// old action id (a lift's own id, or its whole supersede chain) can never
// clear an unrelated NEW mute on a later session. Also LiftTimeout's
// rollback path for an SFU failure on mute (round 4, Codex 14) — same
// statement, called with only the one action id that just failed.
func (d *DB) ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (channelID int64, joinedAt string, matched bool, err error) {
	if len(actionIDs) == 0 {
		return 0, "", false, nil
	}
	placeholders := make([]string, len(actionIDs))
	args := make([]any, 0, len(actionIDs)+1)
	args = append(args, userID)
	for i, id := range actionIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	row := d.writer.QueryRowContext(ctx,
		"UPDATE voice_states SET server_muted = 0, server_muted_by = NULL"+ //nolint:gosec // placeholders are "?" repeated, not user input
			" WHERE user_id = ? AND server_muted_by IN ("+strings.Join(placeholders, ",")+")"+
			" RETURNING channel_id, joined_at",
		args...,
	)
	if err := row.Scan(&channelID, &joinedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, "", false, nil
		}
		return 0, "", false, fmt.Errorf("ClearServerMuteOwnedBy: %w", err)
	}
	return channelID, joinedAt, true, nil
}

// OrphanedVoiceMute is one voice_states row FindOrphanedVoiceMutes found:
// UserID's session still names ActionID as server_muted_by, but that action
// is now lifted or expired.
type OrphanedVoiceMute struct {
	UserID   int64
	ActionID int64
}

// FindOrphanedVoiceMutes lists every voice_states row whose server_muted_by
// points at a timeout that is now lifted or expired (round 4, B5-10
// addendum) — the maintenance-tick (and start-up) reconcile sweep's input.
func (d *DB) FindOrphanedVoiceMutes(ctx context.Context) ([]OrphanedVoiceMute, error) {
	rows, err := d.q.FindOrphanedVoiceMutes(ctx)
	if err != nil {
		return nil, fmt.Errorf("FindOrphanedVoiceMutes: %w", err)
	}
	out := make([]OrphanedVoiceMute, 0, len(rows))
	for _, r := range rows {
		if r.ActionID == nil {
			continue // WHERE server_muted_by IS NOT NULL guarantees this in practice.
		}
		out = append(out, OrphanedVoiceMute{UserID: r.UserID, ActionID: *r.ActionID})
	}
	return out, nil
}

// SetVoiceServerDeafen applies or clears the moderator-imposed deafen, scoped
// to channelID. Mirrors SetVoiceServerMute, including the asymmetric handling
// of deafened and the channel-scoped matched result.
func (d *DB) SetVoiceServerDeafen(ctx context.Context, userID, channelID int64, serverDeafened bool) (matched bool, err error) {
	var res sql.Result
	if serverDeafened {
		res, err = d.q.ApplyVoiceServerDeafen(ctx, dbgen.ApplyVoiceServerDeafenParams{UserID: userID, ChannelID: channelID})
	} else {
		res, err = d.q.ClearVoiceServerDeafen(ctx, dbgen.ClearVoiceServerDeafenParams{UserID: userID, ChannelID: channelID})
	}
	if err != nil {
		return false, fmt.Errorf("SetVoiceServerDeafen: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ClearVoiceState removes a user's voice state on disconnect.
// Equivalent to LeaveVoiceChannel but named to clarify the disconnect use case.
func (d *DB) ClearVoiceState(ctx context.Context, userID int64) error {
	if err := d.q.ClearVoiceState(ctx, userID); err != nil {
		return fmt.Errorf("ClearVoiceState: %w", err)
	}
	return nil
}

// ClearAllVoiceStates removes all voice state rows. Called on server startup
// to clear stale state from a previous run.
func (d *DB) ClearAllVoiceStates(ctx context.Context) error {
	if err := d.q.ClearAllVoiceStates(ctx); err != nil {
		return fmt.Errorf("ClearAllVoiceStates: %w", err)
	}
	return nil
}

// CountActiveCameras returns the number of users with camera enabled in the
// given voice channel. Uses the DB as source of truth (race-free via SQLite
// serialization) rather than querying LiveKit.
func (d *DB) CountActiveCameras(ctx context.Context, channelID int64) (int, error) {
	count, err := d.q.CountActiveCameras(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("CountActiveCameras: %w", err)
	}
	return int(count), nil
}

// UpdateVoiceCamera sets the camera field for the given user's voice state.
func (d *DB) UpdateVoiceCamera(ctx context.Context, userID int64, camera bool) error {
	if err := d.q.UpdateVoiceCamera(ctx, dbgen.UpdateVoiceCameraParams{
		Camera: b2i64(camera),
		UserID: userID,
	}); err != nil {
		return fmt.Errorf("UpdateVoiceCamera: %w", err)
	}
	return nil
}

// EnableCameraIfUnderLimit atomically enables a user's camera only if the
// channel has not yet reached maxVideo active cameras. Returns true if the
// camera was enabled, false if the limit was already reached.
func (d *DB) EnableCameraIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	res, err := d.q.EnableCameraIfUnderLimit(ctx, dbgen.EnableCameraIfUnderLimitParams{
		UserID:      userID,
		ChannelID:   channelID,
		ChannelID_2: channelID,
		MaxVideo:    int64(maxVideo),
	})
	if err != nil {
		return false, fmt.Errorf("EnableCameraIfUnderLimit: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("EnableCameraIfUnderLimit RowsAffected: %w", err)
	}
	return rows > 0, nil
}

// UpdateVoiceScreenshare sets the screenshare field for the given user's voice state.
func (d *DB) UpdateVoiceScreenshare(ctx context.Context, userID int64, screenshare bool) error {
	if err := d.q.UpdateVoiceScreenshare(ctx, dbgen.UpdateVoiceScreenshareParams{
		Screenshare: b2i64(screenshare),
		UserID:      userID,
	}); err != nil {
		return fmt.Errorf("UpdateVoiceScreenshare: %w", err)
	}
	return nil
}

// EnableScreenshareIfUnderLimit atomically enables a user's screenshare only
// if the channel has not yet reached maxVideo active video streams — camera
// and screenshare draw from the same voice_max_video budget (OC-0023).
// Returns true if the screenshare was enabled, false if the limit was
// already reached.
func (d *DB) EnableScreenshareIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
	res, err := d.q.EnableScreenshareIfUnderLimit(ctx, dbgen.EnableScreenshareIfUnderLimitParams{
		UserID:      userID,
		ChannelID:   channelID,
		ChannelID_2: channelID,
		MaxVideo:    int64(maxVideo),
	})
	if err != nil {
		return false, fmt.Errorf("EnableScreenshareIfUnderLimit: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("EnableScreenshareIfUnderLimit RowsAffected: %w", err)
	}
	return rows > 0, nil
}

// CountChannelVoiceUsers returns the number of users currently in the given
// voice channel.
func (d *DB) CountChannelVoiceUsers(ctx context.Context, channelID int64) (int, error) {
	var count int
	err := d.reader.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM voice_states WHERE channel_id = ?`,
		channelID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("CountChannelVoiceUsers: %w", err)
	}
	return count, nil
}
