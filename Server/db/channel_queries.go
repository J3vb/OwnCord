package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// channelFields carries the 14 columns shared by GetChannelRow and
// ListChannelsRow; both generated row types are structurally identical, so a
// single mapper narrows either to the domain Channel model.
type channelFields struct {
	ID              int64
	Name            string
	Type            string
	Category        string
	Topic           string
	Position        int64
	SlowMode        int64
	Archived        int64
	CreatedAt       string
	VoiceMaxUsers   int64
	VoiceQuality    *string
	MixingThreshold *int64
	VoiceMaxVideo   int64
	// Nsfw keeps sqlc's spelling, not the domain model's NSFW: the two
	// generated row types are narrowed by a direct struct conversion, which
	// requires identical field names.
	Nsfw int64
}

func channelFromFields(f channelFields) Channel {
	return Channel{
		ID:              f.ID,
		Name:            f.Name,
		Type:            f.Type,
		Category:        f.Category,
		Topic:           f.Topic,
		Position:        int(f.Position),
		SlowMode:        int(f.SlowMode),
		Archived:        f.Archived != 0,
		CreatedAt:       f.CreatedAt,
		VoiceMaxUsers:   int(f.VoiceMaxUsers),
		VoiceQuality:    f.VoiceQuality,
		MixingThreshold: ptrI64toI(f.MixingThreshold),
		VoiceMaxVideo:   int(f.VoiceMaxVideo),
		NSFW:            f.Nsfw != 0,
	}
}

// ListChannels returns all channels ordered by position.
func (d *DB) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := d.q.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListChannels: %w", err)
	}
	channels := make([]Channel, 0, len(rows))
	for i := range rows {
		channels = append(channels, channelFromFields(channelFields(rows[i])))
	}
	return channels, nil
}

// GetChannel returns the channel with the given id, or nil if not found.
func (d *DB) GetChannel(ctx context.Context, id int64) (*Channel, error) {
	r, err := d.q.GetChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetChannel: %w", err)
	}
	ch := channelFromFields(channelFields(r))
	return &ch, nil
}

// CreateChannel inserts a new channel and returns the assigned ID.
func (d *DB) CreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error) {
	res, err := d.q.CreateChannel(ctx, dbgen.CreateChannelParams{
		Name:     name,
		Type:     chanType,
		Category: strToNullPtr(category),
		Topic:    strToNullPtr(topic),
		Position: int64(position),
	})
	if err != nil {
		return 0, fmt.Errorf("CreateChannel: %w", err)
	}
	return res.LastInsertId()
}

// UpdateChannel modifies name, topic, and slow_mode for the given channel.
func (d *DB) UpdateChannel(ctx context.Context, id int64, name, topic string, slowMode int) error {
	if err := d.q.UpdateChannel(ctx, dbgen.UpdateChannelParams{
		Name:     name,
		Topic:    strToNullPtr(topic),
		SlowMode: int64(slowMode),
		ID:       id,
	}); err != nil {
		return fmt.Errorf("UpdateChannel: %w", err)
	}
	return nil
}

// SetChannelSlowMode updates only the slow_mode field for the given channel.
func (d *DB) SetChannelSlowMode(ctx context.Context, id int64, slowMode int) error {
	if err := d.q.SetChannelSlowMode(ctx, dbgen.SetChannelSlowModeParams{
		SlowMode: int64(slowMode),
		ID:       id,
	}); err != nil {
		return fmt.Errorf("SetChannelSlowMode: %w", err)
	}
	return nil
}

// SetChannelVoiceMaxUsers updates the voice_max_users field for the given channel.
func (d *DB) SetChannelVoiceMaxUsers(ctx context.Context, id int64, maxUsers int) error {
	if err := d.q.SetChannelVoiceMaxUsers(ctx, dbgen.SetChannelVoiceMaxUsersParams{
		VoiceMaxUsers: int64(maxUsers),
		ID:            id,
	}); err != nil {
		return fmt.Errorf("SetChannelVoiceMaxUsers: %w", err)
	}
	return nil
}

// DeleteChannel removes the channel row (cascades to messages, overrides, etc.).
func (d *DB) DeleteChannel(ctx context.Context, id int64) error {
	if err := d.q.DeleteChannel(ctx, id); err != nil {
		return fmt.Errorf("DeleteChannel: %w", err)
	}
	return nil
}

// GetChannelPermissions returns the allow/deny override bits for a role on a
// channel. Returns (0, 0, nil) when no override exists.
func (d *DB) GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error) {
	r, scanErr := d.q.GetChannelPermission(ctx, dbgen.GetChannelPermissionParams{
		ChannelID: channelID,
		RoleID:    roleID,
	})
	if errors.Is(scanErr, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if scanErr != nil {
		return 0, 0, fmt.Errorf("GetChannelPermissions: %w", scanErr)
	}
	return r.Allow, r.Deny, nil
}

// ChannelOverride holds the resolved override layers for a single channel.
// Allow/Deny are the ROLE layer (channel_overrides); UserAllow/UserDeny are the
// per-member layer (channel_user_overrides) applied on top of it. See
// permissions.EffectiveChannelPerms for the resolution order.
type ChannelOverride struct {
	Allow     int64
	Deny      int64
	UserAllow int64
	UserDeny  int64
}

// GetAllChannelPermissionsForRole returns all channel permission overrides for
// a role in a single query, keyed by channel ID. Eliminates N+1 queries when
// filtering channels by permission.
func (d *DB) GetAllChannelPermissionsForRole(ctx context.Context, roleID int64) (map[int64]ChannelOverride, error) {
	rows, err := d.q.GetRoleChannelPermissions(ctx, roleID)
	if err != nil {
		return nil, fmt.Errorf("GetAllChannelPermissionsForRole: %w", err)
	}
	result := make(map[int64]ChannelOverride, len(rows))
	for _, r := range rows {
		result[r.ChannelID] = ChannelOverride{Allow: r.Allow, Deny: r.Deny}
	}
	return result, nil
}

// UpsertChannelOverride inserts or updates the allow/deny permission override
// for a role on a channel.
func (d *DB) UpsertChannelOverride(ctx context.Context, channelID, roleID, allow, deny int64) error {
	if err := d.q.UpsertChannelPermission(ctx, dbgen.UpsertChannelPermissionParams{
		ChannelID: channelID,
		RoleID:    roleID,
		Allow:     allow,
		Deny:      deny,
	}); err != nil {
		return fmt.Errorf("UpsertChannelOverride: %w", err)
	}
	return nil
}

// DeleteChannelOverride removes the permission override for a role on a
// channel. Deleting a non-existent override is a no-op.
func (d *DB) DeleteChannelOverride(ctx context.Context, channelID, roleID int64) error {
	if err := d.q.DeleteChannelPermission(ctx, dbgen.DeleteChannelPermissionParams{
		ChannelID: channelID,
		RoleID:    roleID,
	}); err != nil {
		return fmt.Errorf("DeleteChannelOverride: %w", err)
	}
	return nil
}

// GetUserChannelPermissions returns the per-user allow/deny override bits for a
// user on a channel. Returns (0, 0, nil) when no override exists.
func (d *DB) GetUserChannelPermissions(ctx context.Context, channelID, userID int64) (allow, deny int64, err error) {
	r, scanErr := d.q.GetChannelUserPermission(ctx, dbgen.GetChannelUserPermissionParams{
		ChannelID: channelID,
		UserID:    userID,
	})
	if errors.Is(scanErr, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if scanErr != nil {
		return 0, 0, fmt.Errorf("GetUserChannelPermissions: %w", scanErr)
	}
	return r.Allow, r.Deny, nil
}

// GetAllChannelPermissionsForUser returns every per-user channel override the
// user carries, keyed by channel ID, in one query. The per-user layer is fetched
// exactly like the per-role one (GetAllChannelPermissionsForRole) so no call
// site pays an N+1 for the second layer.
func (d *DB) GetAllChannelPermissionsForUser(ctx context.Context, userID int64) (map[int64]ChannelOverride, error) {
	rows, err := d.q.GetUserChannelPermissions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetAllChannelPermissionsForUser: %w", err)
	}
	result := make(map[int64]ChannelOverride, len(rows))
	for _, r := range rows {
		result[r.ChannelID] = ChannelOverride{UserAllow: r.Allow, UserDeny: r.Deny}
	}
	return result, nil
}

// GetChannelOverridesFor returns the merged role + user override layers for one
// member, keyed by channel ID: two batch queries, never per channel. It is the
// single fetch every "what can this member do here" site uses, so the role and
// user layers can never be loaded by one site and forgotten by another.
func (d *DB) GetChannelOverridesFor(ctx context.Context, roleID, userID int64) (map[int64]ChannelOverride, error) {
	merged, err := d.GetAllChannelPermissionsForRole(ctx, roleID)
	if err != nil {
		return nil, err
	}
	userOv, err := d.GetAllChannelPermissionsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	for chID, o := range userOv {
		existing := merged[chID]
		existing.UserAllow = o.UserAllow
		existing.UserDeny = o.UserDeny
		merged[chID] = existing
	}
	return merged, nil
}

// UpsertChannelUserOverride inserts or updates the allow/deny permission
// override for a single user on a channel.
func (d *DB) UpsertChannelUserOverride(ctx context.Context, channelID, userID, allow, deny int64) error {
	if err := d.q.UpsertChannelUserPermission(ctx, dbgen.UpsertChannelUserPermissionParams{
		ChannelID: channelID,
		UserID:    userID,
		Allow:     allow,
		Deny:      deny,
	}); err != nil {
		return fmt.Errorf("UpsertChannelUserOverride: %w", err)
	}
	return nil
}

// DeleteChannelUserOverride removes a user's permission override on a channel.
// Deleting a non-existent override is a no-op.
func (d *DB) DeleteChannelUserOverride(ctx context.Context, channelID, userID int64) error {
	if err := d.q.DeleteChannelUserPermission(ctx, dbgen.DeleteChannelUserPermissionParams{
		ChannelID: channelID,
		UserID:    userID,
	}); err != nil {
		return fmt.Errorf("DeleteChannelUserOverride: %w", err)
	}
	return nil
}

// GetChannelUserOverrides returns every per-user override on a channel, keyed
// by user id. The per-user reverse (GetAllChannelPermissionsForUser) backs the
// permission cache; this direction backs the @everyone fan-out and the admin
// panel's override matrix, which need every member's verdict on one channel.
func (d *DB) GetChannelUserOverrides(ctx context.Context, channelID int64) (map[int64]ChannelOverride, error) {
	rows, err := d.q.GetChannelUserOverrides(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("GetChannelUserOverrides: %w", err)
	}
	result := make(map[int64]ChannelOverride, len(rows))
	for _, r := range rows {
		result[r.UserID] = ChannelOverride{UserAllow: r.Allow, UserDeny: r.Deny}
	}
	return result, nil
}

// ChannelUserOverride pairs a user with their allow/deny override on a specific
// channel. Unlike ChannelRoleOverride it lists only users who actually HAVE an
// override row — every member of a server is not a sensible list to ship.
type ChannelUserOverride struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	RoleID   int64  `json:"role_id"`
	Allow    int64  `json:"allow"`
	Deny     int64  `json:"deny"`
}

// ListChannelUserOverrides returns the per-user overrides on a channel joined
// with the users' names, ordered by username.
func (d *DB) ListChannelUserOverrides(ctx context.Context, channelID int64) ([]ChannelUserOverride, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT u.id, u.username, u.role_id, o.allow, o.deny
		 FROM channel_user_overrides o
		 JOIN users u ON u.id = o.user_id
		 WHERE o.channel_id = ?
		 ORDER BY u.username COLLATE NOCASE ASC`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("ListChannelUserOverrides: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := []ChannelUserOverride{}
	for rows.Next() {
		var o ChannelUserOverride
		if scanErr := rows.Scan(&o.UserID, &o.Username, &o.RoleID, &o.Allow, &o.Deny); scanErr != nil {
			return nil, fmt.Errorf("ListChannelUserOverrides scan: %w", scanErr)
		}
		result = append(result, o)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListChannelUserOverrides rows: %w", rows.Err())
	}
	return result, nil
}

// ChannelRoleOverride pairs a role with its (possibly zero) permission
// override on a specific channel. Permissions carries the role's base bits so
// callers can tell which roles bypass overrides via Administrator.
type ChannelRoleOverride struct {
	RoleID      int64  `json:"role_id"`
	RoleName    string `json:"role_name"`
	Position    int    `json:"position"`
	Permissions int64  `json:"permissions"`
	Allow       int64  `json:"allow"`
	Deny        int64  `json:"deny"`
}

// ListChannelRoleOverrides returns every role together with its override bits
// on the given channel (zero allow/deny when no override row exists), ordered
// by role position descending.
func (d *DB) ListChannelRoleOverrides(ctx context.Context, channelID int64) ([]ChannelRoleOverride, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT r.id, r.name, r.position, r.permissions,
		        COALESCE(o.allow, 0), COALESCE(o.deny, 0)
		 FROM roles r
		 LEFT JOIN channel_overrides o ON o.role_id = r.id AND o.channel_id = ?
		 ORDER BY r.position DESC, r.id ASC`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("ListChannelRoleOverrides: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var result []ChannelRoleOverride
	for rows.Next() {
		var o ChannelRoleOverride
		if scanErr := rows.Scan(&o.RoleID, &o.RoleName, &o.Position, &o.Permissions, &o.Allow, &o.Deny); scanErr != nil {
			return nil, fmt.Errorf("ListChannelRoleOverrides scan: %w", scanErr)
		}
		result = append(result, o)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListChannelRoleOverrides rows: %w", rows.Err())
	}
	if result == nil {
		result = []ChannelRoleOverride{}
	}
	return result, nil
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// GetChannelTypes returns a map of channel ID → type string for the given IDs
// in a single query, avoiding N+1 lookups.
func (d *DB) GetChannelTypes(ctx context.Context, ids []int64) (map[int64]string, error) {
	if len(ids) == 0 {
		return map[int64]string{}, nil
	}

	// Build placeholders and args.
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`SELECT id, type FROM channels WHERE id IN (%s)`,
		strings.Join(placeholders, ","),
	)

	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("GetChannelTypes query: %w", err)
	}
	defer func() { _ = rows.Close() }()

	result := make(map[int64]string, len(ids))
	for rows.Next() {
		var id int64
		var chType string
		if err := rows.Scan(&id, &chType); err != nil {
			return nil, fmt.Errorf("GetChannelTypes scan: %w", err)
		}
		result[id] = chType
	}
	return result, rows.Err()
}
