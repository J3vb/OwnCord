package db

import (
	"database/sql"
	"errors"
	"fmt"
)

// JoinVoiceChannel inserts or replaces the user's voice state for the given
// channel. If the user is already in a different channel, the old row is
// replaced. Muted, deafened, and speaking are reset to false on join.
func (d *DB) JoinVoiceChannel(userID, channelID int64) error {
	_, err := d.sqlDB.Exec(
		`INSERT INTO voice_states (user_id, channel_id, muted, deafened, speaking, camera, screenshare)
		 VALUES (?, ?, 0, 0, 0, 0, 0)
		 ON CONFLICT(user_id) DO UPDATE SET
		     channel_id  = excluded.channel_id,
		     muted       = 0,
		     deafened    = 0,
		     speaking    = 0,
		     camera      = 0,
		     screenshare = 0,
		     joined_at   = datetime('now')`,
		userID, channelID,
	)
	if err != nil {
		return fmt.Errorf("JoinVoiceChannel: %w", err)
	}
	return nil
}

// LeaveVoiceChannel removes the user's voice state entirely.
// It is safe to call when the user is not in any voice channel.
func (d *DB) LeaveVoiceChannel(userID int64) error {
	_, err := d.sqlDB.Exec(`DELETE FROM voice_states WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("LeaveVoiceChannel: %w", err)
	}
	return nil
}

// GetVoiceState returns the current voice state for the given user,
// or nil if the user is not in any voice channel.
func (d *DB) GetVoiceState(userID int64) (*VoiceState, error) {
	row := d.sqlDB.QueryRow(
		`SELECT vs.user_id, vs.channel_id, u.username,
		        vs.muted, vs.deafened, vs.speaking,
		        vs.camera, vs.screenshare
		 FROM voice_states vs
		 JOIN users u ON u.id = vs.user_id
		 WHERE vs.user_id = ?`,
		userID,
	)
	return scanVoiceState(row)
}

// GetChannelVoiceStates returns all voice states for users currently in the
// given voice channel.
func (d *DB) GetChannelVoiceStates(channelID int64) ([]VoiceState, error) {
	rows, err := d.sqlDB.Query(
		`SELECT vs.user_id, vs.channel_id, u.username,
		        vs.muted, vs.deafened, vs.speaking,
		        vs.camera, vs.screenshare
		 FROM voice_states vs
		 JOIN users u ON u.id = vs.user_id
		 WHERE vs.channel_id = ?
		 ORDER BY vs.joined_at ASC`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetChannelVoiceStates: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var states []VoiceState
	for rows.Next() {
		vs, scanErr := scanVoiceStateRow(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("GetChannelVoiceStates scan: %w", scanErr)
		}
		states = append(states, vs)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetChannelVoiceStates rows: %w", rows.Err())
	}
	if states == nil {
		states = []VoiceState{}
	}
	return states, nil
}

// UpdateVoiceMute sets the muted field for the given user's voice state.
// It is safe to call when the user is not in any channel (no-op).
func (d *DB) UpdateVoiceMute(userID int64, muted bool) error {
	muteInt := boolToInt(muted)
	_, err := d.sqlDB.Exec(
		`UPDATE voice_states SET muted = ? WHERE user_id = ?`,
		muteInt, userID,
	)
	if err != nil {
		return fmt.Errorf("UpdateVoiceMute: %w", err)
	}
	return nil
}

// UpdateVoiceDeafen sets the deafened field for the given user's voice state.
// It is safe to call when the user is not in any channel (no-op).
func (d *DB) UpdateVoiceDeafen(userID int64, deafened bool) error {
	deafenInt := boolToInt(deafened)
	_, err := d.sqlDB.Exec(
		`UPDATE voice_states SET deafened = ? WHERE user_id = ?`,
		deafenInt, userID,
	)
	if err != nil {
		return fmt.Errorf("UpdateVoiceDeafen: %w", err)
	}
	return nil
}

// ClearVoiceState removes a user's voice state on disconnect.
// Equivalent to LeaveVoiceChannel but named to clarify the disconnect use case.
func (d *DB) ClearVoiceState(userID int64) error {
	_, err := d.sqlDB.Exec(`DELETE FROM voice_states WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("ClearVoiceState: %w", err)
	}
	return nil
}

// ClearAllVoiceStates removes all voice state rows. Called on server startup
// to clear stale state from a previous run.
func (d *DB) ClearAllVoiceStates() error {
	_, err := d.sqlDB.Exec(`DELETE FROM voice_states`)
	if err != nil {
		return fmt.Errorf("ClearAllVoiceStates: %w", err)
	}
	return nil
}

// UpdateVoiceCamera sets the camera field for the given user's voice state.
func (d *DB) UpdateVoiceCamera(userID int64, camera bool) error {
	_, err := d.sqlDB.Exec(
		`UPDATE voice_states SET camera = ? WHERE user_id = ?`,
		boolToInt(camera), userID,
	)
	if err != nil {
		return fmt.Errorf("UpdateVoiceCamera: %w", err)
	}
	return nil
}

// UpdateVoiceScreenshare sets the screenshare field for the given user's voice state.
func (d *DB) UpdateVoiceScreenshare(userID int64, screenshare bool) error {
	_, err := d.sqlDB.Exec(
		`UPDATE voice_states SET screenshare = ? WHERE user_id = ?`,
		boolToInt(screenshare), userID,
	)
	if err != nil {
		return fmt.Errorf("UpdateVoiceScreenshare: %w", err)
	}
	return nil
}

// CountChannelVoiceUsers returns the number of users currently in the given
// voice channel.
func (d *DB) CountChannelVoiceUsers(channelID int64) (int, error) {
	var count int
	err := d.sqlDB.QueryRow(
		`SELECT COUNT(*) FROM voice_states WHERE channel_id = ?`,
		channelID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("CountChannelVoiceUsers: %w", err)
	}
	return count, nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// scanVoiceState scans a single *sql.Row into a VoiceState.
// Returns nil (not an error) when the row is not found.
func scanVoiceState(row *sql.Row) (*VoiceState, error) {
	vs := &VoiceState{}
	var muted, deafened, speaking, camera, screenshare int
	err := row.Scan(
		&vs.UserID, &vs.ChannelID, &vs.Username,
		&muted, &deafened, &speaking,
		&camera, &screenshare,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scanVoiceState: %w", err)
	}
	vs.Muted = muted != 0
	vs.Deafened = deafened != 0
	vs.Speaking = speaking != 0
	vs.Camera = camera != 0
	vs.Screenshare = screenshare != 0
	return vs, nil
}

// scanVoiceStateRow scans a single row from *sql.Rows into a VoiceState.
func scanVoiceStateRow(rows *sql.Rows) (VoiceState, error) {
	vs := VoiceState{}
	var muted, deafened, speaking, camera, screenshare int
	err := rows.Scan(
		&vs.UserID, &vs.ChannelID, &vs.Username,
		&muted, &deafened, &speaking,
		&camera, &screenshare,
	)
	if err != nil {
		return vs, fmt.Errorf("scanVoiceStateRow: %w", err)
	}
	vs.Muted = muted != 0
	vs.Deafened = deafened != 0
	vs.Speaking = speaking != 0
	vs.Camera = camera != 0
	vs.Screenshare = screenshare != 0
	return vs, nil
}

// boolToInt converts a bool to 0/1 for SQLite storage.
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
