package db

import (
	"database/sql"
	"errors"
	"fmt"
)

// ListChannels returns all channels ordered by position.
func (d *DB) ListChannels() ([]Channel, error) {
	rows, err := d.sqlDB.Query(
		`SELECT id, name, type, COALESCE(category,''), COALESCE(topic,''),
		        position, slow_mode, archived, created_at,
		        COALESCE(voice_max_users, 0),
		        voice_quality,
		        mixing_threshold,
		        COALESCE(voice_max_video, 0)
		 FROM channels ORDER BY position ASC, id ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListChannels: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var channels []Channel
	for rows.Next() {
		ch, scanErr := scanChannel(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("ListChannels scan: %w", scanErr)
		}
		channels = append(channels, ch)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListChannels rows: %w", rows.Err())
	}
	if channels == nil {
		channels = []Channel{}
	}
	return channels, nil
}

// GetChannel returns the channel with the given id, or nil if not found.
func (d *DB) GetChannel(id int64) (*Channel, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, name, type, COALESCE(category,''), COALESCE(topic,''),
		        position, slow_mode, archived, created_at,
		        COALESCE(voice_max_users, 0),
		        voice_quality,
		        mixing_threshold,
		        COALESCE(voice_max_video, 0)
		 FROM channels WHERE id = ?`,
		id,
	)
	ch := &Channel{}
	var archived int
	err := row.Scan(
		&ch.ID, &ch.Name, &ch.Type, &ch.Category, &ch.Topic,
		&ch.Position, &ch.SlowMode, &archived, &ch.CreatedAt,
		&ch.VoiceMaxUsers, &ch.VoiceQuality, &ch.MixingThreshold, &ch.VoiceMaxVideo,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetChannel: %w", err)
	}
	ch.Archived = archived != 0
	return ch, nil
}

// CreateChannel inserts a new channel and returns the assigned ID.
func (d *DB) CreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	res, err := d.sqlDB.Exec(
		`INSERT INTO channels (name, type, category, topic, position) VALUES (?, ?, ?, ?, ?)`,
		name, chanType, nullableString(category), nullableString(topic), position,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateChannel: %w", err)
	}
	return res.LastInsertId()
}

// UpdateChannel modifies name, topic, and slow_mode for the given channel.
func (d *DB) UpdateChannel(id int64, name, topic string, slowMode int) error {
	_, err := d.sqlDB.Exec(
		`UPDATE channels SET name = ?, topic = ?, slow_mode = ? WHERE id = ?`,
		name, nullableString(topic), slowMode, id,
	)
	if err != nil {
		return fmt.Errorf("UpdateChannel: %w", err)
	}
	return nil
}

// SetChannelSlowMode updates only the slow_mode field for the given channel.
func (d *DB) SetChannelSlowMode(id int64, slowMode int) error {
	_, err := d.sqlDB.Exec(
		`UPDATE channels SET slow_mode = ? WHERE id = ?`,
		slowMode, id,
	)
	if err != nil {
		return fmt.Errorf("SetChannelSlowMode: %w", err)
	}
	return nil
}

// SetChannelVoiceMaxUsers updates the voice_max_users field for the given channel.
func (d *DB) SetChannelVoiceMaxUsers(id int64, maxUsers int) error {
	_, err := d.sqlDB.Exec(`UPDATE channels SET voice_max_users = ? WHERE id = ?`, maxUsers, id)
	if err != nil {
		return fmt.Errorf("SetChannelVoiceMaxUsers: %w", err)
	}
	return nil
}

// DeleteChannel removes the channel row (cascades to messages, overrides, etc.).
func (d *DB) DeleteChannel(id int64) error {
	_, err := d.sqlDB.Exec(`DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("DeleteChannel: %w", err)
	}
	return nil
}

// GetChannelPermissions returns the allow/deny override bits for a role on a
// channel. Returns (0, 0, nil) when no override exists.
func (d *DB) GetChannelPermissions(channelID, roleID int64) (allow, deny int64, err error) {
	row := d.sqlDB.QueryRow(
		`SELECT allow, deny FROM channel_overrides WHERE channel_id = ? AND role_id = ?`,
		channelID, roleID,
	)
	scanErr := row.Scan(&allow, &deny)
	if errors.Is(scanErr, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if scanErr != nil {
		return 0, 0, fmt.Errorf("GetChannelPermissions: %w", scanErr)
	}
	return allow, deny, nil
}

// ChannelOverride holds the allow/deny permission bits for a single channel.
type ChannelOverride struct {
	Allow int64
	Deny  int64
}

// GetAllChannelPermissionsForRole returns all channel permission overrides for
// a role in a single query, keyed by channel ID. Eliminates N+1 queries when
// filtering channels by permission.
func (d *DB) GetAllChannelPermissionsForRole(roleID int64) (map[int64]ChannelOverride, error) {
	rows, err := d.sqlDB.Query(
		`SELECT channel_id, allow, deny FROM channel_overrides WHERE role_id = ?`,
		roleID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetAllChannelPermissionsForRole: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64]ChannelOverride)
	for rows.Next() {
		var chID int64
		var o ChannelOverride
		if scanErr := rows.Scan(&chID, &o.Allow, &o.Deny); scanErr != nil {
			return nil, fmt.Errorf("GetAllChannelPermissionsForRole scan: %w", scanErr)
		}
		result[chID] = o
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetAllChannelPermissionsForRole rows: %w", rows.Err())
	}
	return result, nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// scanChannel scans a single channel row from *sql.Rows.
// The query must select the 13 columns: id, name, type, category, topic,
// position, slow_mode, archived, created_at, voice_max_users,
// voice_quality, mixing_threshold, voice_max_video.
func scanChannel(rows *sql.Rows) (Channel, error) {
	var ch Channel
	var archived int
	err := rows.Scan(
		&ch.ID, &ch.Name, &ch.Type, &ch.Category, &ch.Topic,
		&ch.Position, &ch.SlowMode, &archived, &ch.CreatedAt,
		&ch.VoiceMaxUsers, &ch.VoiceQuality, &ch.MixingThreshold, &ch.VoiceMaxVideo,
	)
	if err != nil {
		return Channel{}, err
	}
	ch.Archived = archived != 0
	return ch, nil
}

// nullableString returns nil when s is empty, otherwise a pointer to s.
// Used so empty strings are stored as NULL in optional TEXT columns.
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
