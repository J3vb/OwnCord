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

var ErrChannelFull = errors.New("voice channel is full")

var voiceJoinSeq uint64

func newVoiceJoinToken() string {
	seq := atomic.AddUint64(&voiceJoinSeq, 1)
	return fmt.Sprintf("%s-%020d", time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z"), seq)
}

// JoinVoiceChannel inserts or replaces the user's voice state, resetting muted,
// deafened and speaking. joined_at doubles as an opaque join-instance token so stale
// cleanup can target one session.
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

// JoinVoiceChannelIfCapacity inserts a voice state only if the channel has fewer
// than maxUsers participants, atomically; it returns ErrChannelFull at capacity.
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

// LeaveVoiceChannel removes the user's voice state; a no-op when not in voice.
func (d *DB) LeaveVoiceChannel(ctx context.Context, userID int64) error {
	if err := d.q.LeaveVoiceChannel(ctx, userID); err != nil {
		return fmt.Errorf("LeaveVoiceChannel: %w", err)
	}
	return nil
}

// LeaveVoiceChannelIfMatch removes the voice state only if the row still points
// at expectedChannelID with the expected join token; it reports whether a row was deleted.
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

// GetVoiceState returns the user's voice state, or nil when not in voice.
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

// GetChannelVoiceStates returns all voice states in the given voice channel.
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

// GetAllVoiceStates returns voice states across all channels in one query for the ready payload.
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

// UpdateVoiceMute sets the muted field for the user's voice state; a no-op when not in a channel.
func (d *DB) UpdateVoiceMute(ctx context.Context, userID int64, muted bool) error {
	if err := d.q.UpdateVoiceMute(ctx, dbgen.UpdateVoiceMuteParams{
		Muted:  b2i64(muted),
		UserID: userID,
	}); err != nil {
		return fmt.Errorf("UpdateVoiceMute: %w", err)
	}
	return nil
}

// UpdateVoiceDeafen sets the deafened field for the user's voice state; a no-op when not in a
// channel.
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
// the channelID the caller's authorization passed for. Applying also sets muted;
// clearing leaves it, so a user muted beforehand stays muted. matched=false
// means the row is no longer in channelID (a channel switch raced the
// moderator); it is left untouched so the write cannot land on another channel,
// including a DM call nobody authorized.
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

// MuteForTimeoutSession is the timeout voice half's mute, built on session
// ownership (migration 049, voice_states.server_muted_by). It matches the exact
// session (channelID and the joinedAt token JoinVoiceChannel mints). One
// conditional UPDATE (WHERE server_muted = 0) applies the mute and stamps
// actionID as owner on a genuine unmuted->muted transition, so a concurrent lift
// has no gap to race.
// ¶ matched=false covers "no such session" and "actionID is no longer an active
// timeout on this target" (a delayed call after its row was lifted or expired
// is refused, not a fresh mute). "Already muted by something else" is
// matched=true, transitioned=false.
// ¶ supersededIDs, when non-empty, first transfers ownership from those ledger
// ids onto actionID in this transaction. TimeoutUser cannot, because the
// transfer must happen under the ws per-target lock the caller
// (ws.Hub.MuteForTimeout) holds for the paired SFU call; outside it a failed
// caller's rollback could miss a re-pointed row.
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
	if err := tx.Commit(); err != nil {
		return false, false, fmt.Errorf("MuteForTimeoutSession commit: %w", err)
	}
	if active == 0 {
		return false, false, nil
	}
	return true, false, nil
}

// ClearServerMuteOwnedBy clears server_muted on the voice_states row naming one
// of actionIDs as server_muted_by and reports its channel and join token for the
// paired SFU call. It is session-bound: a rejoin starts with server_muted_by
// NULL, so an old action id cannot clear a later session's mute. It is also
// LiftTimeout's rollback path on an SFU mute failure.
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

// OrphanedVoiceMute is a voice_states row whose session still names ActionID as
// server_muted_by but that action is lifted or expired.
type OrphanedVoiceMute struct {
	UserID   int64
	ActionID int64
}

// FindOrphanedVoiceMutes lists every voice_states row whose server_muted_by names a
// lifted or expired timeout, for the reconcile sweep.
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

// SetVoiceServerDeafen applies or clears the moderator-imposed deafen with
// SetVoiceServerMute's matched semantics. Clearing also clears deafened; muted is left
// for the target to lift.
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

// ClearVoiceState is LeaveVoiceChannel under the name for the disconnect use.
func (d *DB) ClearVoiceState(ctx context.Context, userID int64) error {
	if err := d.q.ClearVoiceState(ctx, userID); err != nil {
		return fmt.Errorf("ClearVoiceState: %w", err)
	}
	return nil
}

// ClearAllVoiceStates removes all rows at startup to clear stale state.
func (d *DB) ClearAllVoiceStates(ctx context.Context) error {
	if err := d.q.ClearAllVoiceStates(ctx); err != nil {
		return fmt.Errorf("ClearAllVoiceStates: %w", err)
	}
	return nil
}

// CountActiveCameras returns the users with camera enabled in the channel, from the DB
// (serialized) rather than LiveKit.
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

// EnableCameraIfUnderLimit enables the camera atomically only if fewer than maxVideo
// are active; it returns whether it did.
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

// EnableScreenshareIfUnderLimit enables screenshare atomically only if fewer than
// maxVideo video streams are active (camera and screenshare share voice_max_video); it
// returns whether it did.
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

// CountChannelVoiceUsers returns the number of users in the voice channel.
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
