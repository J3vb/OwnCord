package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// UserCount returns the total number of registered users.
func (d *DB) UserCount(ctx context.Context) (int64, error) {
	count, err := d.q.UserCount(ctx)
	if err != nil {
		return 0, fmt.Errorf("UserCount: %w", err)
	}
	return count, nil
}

// GetServerStats returns aggregate counts for the admin dashboard.
func (d *DB) GetServerStats(ctx context.Context) (*ServerStats, error) {
	stats := &ServerStats{}
	var err error

	if stats.UserCount, err = d.q.CountUsers(ctx); err != nil {
		return nil, fmt.Errorf("GetServerStats users: %w", err)
	}
	if stats.MessageCount, err = d.activeMessagesCache.Get(statsCacheTTL, func() (int64, error) {
		return d.q.CountActiveMessages(ctx)
	}); err != nil {
		return nil, fmt.Errorf("GetServerStats messages: %w", err)
	}
	if stats.ChannelCount, err = d.q.CountChannels(ctx); err != nil {
		return nil, fmt.Errorf("GetServerStats channels: %w", err)
	}
	if stats.InviteCount, err = d.q.CountActiveInvites(ctx); err != nil {
		return nil, fmt.Errorf("GetServerStats invites: %w", err)
	}

	// page_count * page_size gives the size in bytes. PRAGMAs are not sqlc queries and
	// both values are DB-wide, so the reader is fine.
	var pageCount, pageSize int64
	if err := d.reader.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pageCount); err != nil {
		return nil, fmt.Errorf("GetServerStats page_count: %w", err)
	}
	if err := d.reader.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return nil, fmt.Errorf("GetServerStats page_size: %w", err)
	}
	stats.DBSizeBytes = pageCount * pageSize

	return stats, nil
}

// UserListFilter narrows ListAllUsers for the admin Members page; the zero value lists everyone.
type UserListFilter struct {
	// Query is a case-insensitive substring of the username or nickname; empty matches all.
	Query string
	// RoleID keeps one role; 0 means any role.
	RoleID int64
	// BannedOnly keeps only effectively banned users (a lapsed temporary ban does not count).
	BannedOnly bool
}

// ListAllUsers returns active users matching f with role, ordered by ID; limit=0 returns none.
func (d *DB) ListAllUsers(ctx context.Context, f UserListFilter, limit, offset int) ([]UserWithRole, error) {
	var bannedOnly int64
	if f.BannedOnly {
		bannedOnly = 1
	}
	rows, err := d.q.ListAllUsers(ctx, dbgen.ListAllUsersParams{
		Query:      f.Query,
		RoleID:     f.RoleID,
		BannedOnly: bannedOnly,
		Limit:      int64(limit),
		Offset:     int64(offset),
	})
	if err != nil {
		return nil, fmt.Errorf("ListAllUsers: %w", err)
	}
	userIDs := make([]int64, len(rows))
	for i := range rows {
		userIDs[i] = rows[i].ID
	}
	byUser := make(map[int64][]int64, len(rows))
	if len(userIDs) > 0 {
		held, err := d.q.ListUserRoleIDsForUsers(ctx, userIDs)
		if err != nil {
			return nil, fmt.Errorf("ListAllUsers role ids: %w", err)
		}
		for _, h := range held {
			byUser[h.UserID] = append(byUser[h.UserID], h.RoleID)
		}
	}
	result := make([]UserWithRole, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		result = append(result, UserWithRole{
			ID:           r.ID,
			Username:     r.Username,
			DisplayName:  r.DisplayName,
			Avatar:       r.Avatar,
			RoleID:       r.RoleID,
			Status:       r.Status,
			CreatedAt:    r.CreatedAt,
			LastSeen:     r.LastSeen,
			Banned:       r.Banned != 0,
			BanReason:    r.BanReason,
			BanExpires:   r.BanExpires,
			RoleName:     r.RoleName,
			RolePosition: int(r.RolePosition),
			RoleIDs:      memberRoleIDs(byUser[r.ID]),
		})
	}
	return result, nil
}

// UpdateUserRole replaces every role userID holds with roleID and re-mirrors
// users.role_id in one writer transaction so the two never disagree. Unknown users are
// a no-op.
func (d *DB) UpdateUserRole(ctx context.Context, userID, roleID int64) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("UpdateUserRole begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	q := d.q.WithTx(tx)
	if err := q.ClearUserRoles(ctx, userID); err != nil {
		return fmt.Errorf("UpdateUserRole clear: %w", err)
	}
	if err := q.AddUserRoleForExistingUser(ctx, dbgen.AddUserRoleForExistingUserParams{UserID: userID, RoleID: roleID}); err != nil {
		return fmt.Errorf("UpdateUserRole grant: %w", err)
	}
	if err := syncTopRoleTx(ctx, q, userID); err != nil {
		return fmt.Errorf("UpdateUserRole: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("UpdateUserRole commit: %w", err)
	}
	return nil
}

// ForceLogoutUser deletes all sessions for the given user ID.
func (d *DB) ForceLogoutUser(ctx context.Context, userID int64) error {
	if err := d.q.ForceLogoutUser(ctx, userID); err != nil {
		return fmt.Errorf("ForceLogoutUser: %w", err)
	}
	return nil
}

// GetUserSessions returns all active sessions for the given user ID.
func (d *DB) GetUserSessions(ctx context.Context, userID int64) ([]Session, error) {
	rows, err := d.q.GetUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetUserSessions: %w", err)
	}
	sessions := make([]Session, 0, len(rows))
	for _, s := range rows {
		sessions = append(sessions, sessionFromColumns(s.ID, s.UserID, s.Token, s.Device, s.IpAddress, s.CreatedAt, s.LastUsed, s.ExpiresAt, s.Unseen))
	}
	return sessions, nil
}

// AdminCreateChannel creates a channel with full field control. A non-empty category
// is resolved by name (case-insensitive) and created when missing, in the insert's
// transaction.
func (d *DB) AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error) {
	return d.CreateChannelIn(ctx, NewChannel{
		Name:         name,
		Type:         chanType,
		CategoryName: category,
		Topic:        topic,
		Position:     position,
	})
}

// ChannelUpdate is the full set of mutable channel fields an admin edit writes,
// unconditionally, so callers start from the channel's current values to keep a
// partial PATCH safe.
type ChannelUpdate struct {
	Name  string
	Topic string
	// CategoryID is the category the channel ends up in, 0 for none; it must exist
	// (ErrNotFound otherwise). A non-nil CategoryName overrides it: resolved ignoring
	// case, created when missing, in the update's transaction.
	CategoryID   int64
	CategoryName *string
	// CategoryIfExists makes a vanished CategoryID mean "no category" instead of
	// ErrNotFound, for writes carrying the current category forward, where losing a race
	// with a category delete must not fail.
	CategoryIfExists bool
	CreatedCategory  *int64
	SlowMode         int
	Position         int
	Archived         bool
	NSFW             bool
	// VoiceMaxUsers / VoiceMaxVideo are the voice limits the ws voice-join path
	// enforces (0 = unlimited); written on text channels too so the value does not depend on type.
	VoiceMaxUsers int
	VoiceMaxVideo int
	Password      *ChannelPasswordChange
	// SyncGuard, when non-nil, replaces the channel's override rows with the
	// template of the category it ends up in and marks it synced, in the update's
	// transaction, so a refusal leaves the channel as it was; ErrUncategorized when
	// no category remains. Without it, a move keeps the rows and unsyncs the channel.
	SyncGuard ChannelSyncGuard
	SyncPlan  *ChannelSyncPlan
	// Base is the row this update was built from. The write keeps the stored value of
	// every field left equal to Base, so an edit that committed in between survives.
	// It must be a real stored row: a zero-value Base would keep every zero-valued field.
	Base *Channel
	// Before receives the row as the write found it; left alone when the channel is gone.
	Before *Channel
	// settled is the stored row when the write keeps its name or its category over the
	// request's: the pair it writes is then one the caller never checked.
	settled *Channel
}

// ErrChannelNameTaken means a write that kept a concurrent edit would leave two channels
// of one type with the same name in one category.
var ErrChannelNameTaken = errors.New("channel name is taken in the category")

// keepStored returns stored when the request left the field as the snapshot had it.
func keepStored[T comparable](requested, snapshot, stored T) T {
	if requested == snapshot {
		return stored
	}
	return requested
}

// settleAgainstStored applies Base and Before inside the write transaction. A category
// carried forward from Base follows the stored category the same way.
func (u ChannelUpdate) settleAgainstStored(ctx context.Context, q *dbgen.Queries, id int64) (ChannelUpdate, error) {
	if u.Base == nil && u.Before == nil {
		return u, nil
	}
	row, err := q.GetChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return u, nil
	}
	if err != nil {
		return u, err
	}
	cur := channelFromFields(channelFields(row))
	if u.Before != nil {
		*u.Before = cur
	}
	b := u.Base
	if b == nil {
		return u, nil
	}
	name, category := u.Name, u.CategoryID
	u.Name = keepStored(u.Name, b.Name, cur.Name)
	u.Topic = keepStored(u.Topic, b.Topic, cur.Topic)
	u.SlowMode = keepStored(u.SlowMode, b.SlowMode, cur.SlowMode)
	u.Position = keepStored(u.Position, b.Position, cur.Position)
	u.Archived = keepStored(u.Archived, b.Archived, cur.Archived)
	u.NSFW = keepStored(u.NSFW, b.NSFW, cur.NSFW)
	u.VoiceMaxUsers = keepStored(u.VoiceMaxUsers, b.VoiceMaxUsers, cur.VoiceMaxUsers)
	u.VoiceMaxVideo = keepStored(u.VoiceMaxVideo, b.VoiceMaxVideo, cur.VoiceMaxVideo)
	if u.CategoryName == nil && u.CategoryID == b.CategoryID {
		u.CategoryID, u.CategoryIfExists = cur.CategoryID, true
	}
	if u.Name != name || u.CategoryID != category {
		u.settled = &cur
	}
	return u, nil
}

// requireSettledNameFree refuses (ErrChannelNameTaken) a settled write that would put the
// channel beside another of its type with the same name, ignoring case, in the category
// it ends up in. The caller checked the name and category it asked for, and one of them
// was replaced by the stored row's. A write that leaves both as stored (a change of case
// in the name aside) moves nothing and passes, as an existing duplicate does.
func requireSettledNameFree(ctx context.Context, q *dbgen.Queries, id int64, stored *Channel, name string, catID *int64) error {
	var category int64
	if catID != nil {
		category = *catID
	}
	if strings.EqualFold(name, stored.Name) && category == stored.CategoryID {
		return nil
	}
	rows, err := q.ListChannels(ctx)
	if err != nil {
		return err
	}
	for i := range rows {
		r := &rows[i]
		if r.ID != id && r.Type == stored.Type && r.CategoryID == category && strings.EqualFold(r.Name, name) {
			return fmt.Errorf("%w: %q", ErrChannelNameTaken, r.Name)
		}
	}
	return nil
}

// AdminUpdateChannel updates all mutable channel fields, category included, in one transaction.
func (d *DB) AdminUpdateChannel(ctx context.Context, id int64, u ChannelUpdate) error {
	if err := d.adminUpdateChannel(ctx, id, u); err != nil {
		return fmt.Errorf("AdminUpdateChannel: %w", err)
	}
	return nil
}

// adminUpdateChannel also deletes the channel's standing NSFW acknowledgements in the
// same transaction whenever the row it writes is unlabelled, so none outlives its label.
func (d *DB) adminUpdateChannel(ctx context.Context, id int64, u ChannelUpdate) error {
	return d.inWriteTx(ctx, "update", func(q *dbgen.Queries) error {
		u, err := u.settleAgainstStored(ctx, q, id)
		if err != nil {
			return err
		}
		var catID *int64
		var created int64
		switch {
		case u.CategoryName != nil:
			catID, created, err = resolveCategoryTx(ctx, q, 0, *u.CategoryName, false)
		case u.CategoryID > 0:
			catID, created, err = resolveCategoryTx(ctx, q, u.CategoryID, "", u.CategoryIfExists)
		}
		if err != nil {
			return err
		}
		if u.settled != nil {
			if err := requireSettledNameFree(ctx, q, id, u.settled, u.Name, catID); err != nil {
				return err
			}
		}
		if u.CreatedCategory != nil && created != 0 {
			*u.CreatedCategory = created
		}
		before, err := q.GetChannelCategoryID(ctx, id)
		moved := false
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return err
		default:
			moved = !sameCategory(before, catID)
		}
		if err := q.AdminUpdateChannel(ctx, dbgen.AdminUpdateChannelParams{
			Name:          u.Name,
			Topic:         strToNullPtr(u.Topic),
			CategoryID:    catID,
			SlowMode:      int64(u.SlowMode),
			Position:      int64(u.Position),
			Archived:      b2i64(u.Archived),
			Nsfw:          b2i64(u.NSFW),
			VoiceMaxUsers: int64(u.VoiceMaxUsers),
			VoiceMaxVideo: int64(u.VoiceMaxVideo),
			ID:            id,
		}); err != nil {
			return err
		}
		if err := applyChannelPasswordTx(ctx, q, id, u.Password); err != nil {
			return err
		}
		if err := applyPermissionSyncTx(ctx, q, id, catID, moved, u); err != nil {
			return err
		}
		// The flag as settled against the stored row: a label kept from a concurrent
		// edit keeps its acknowledgements, an unlabelled row keeps none.
		if !u.NSFW {
			return q.DeleteNSFWAcknowledgementsForChannel(ctx, id)
		}
		return nil
	})
}

// AdminDeleteChannel removes a channel by ID (cascades to messages, etc.).
func (d *DB) AdminDeleteChannel(ctx context.Context, id int64) error {
	if err := d.q.DeleteChannel(ctx, id); err != nil {
		return fmt.Errorf("AdminDeleteChannel: %w", err)
	}
	return nil
}

// GetSetting returns the value for key, or an error wrapping sql.ErrNoRows.
func (d *DB) GetSetting(ctx context.Context, key string) (string, error) {
	value, err := d.q.GetSetting(ctx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("GetSetting: key %q: %w", key, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("GetSetting: %w", err)
	}
	return value, nil
}

// SetSetting upserts a setting value for the given key.
func (d *DB) SetSetting(ctx context.Context, key, value string) error {
	if err := d.q.SetSetting(ctx, dbgen.SetSettingParams{
		Key:   key,
		Value: value,
	}); err != nil {
		return fmt.Errorf("SetSetting: %w", err)
	}
	return nil
}

// ApplySettings upserts every pair in one transaction, in sorted key order.
func (d *DB) ApplySettings(ctx context.Context, updates map[string]string) error {
	if len(updates) == 0 {
		return nil
	}
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ApplySettings: begin: %w", err)
	}
	q := d.q.WithTx(tx)
	for _, key := range slices.Sorted(maps.Keys(updates)) {
		if err := q.SetSetting(ctx, dbgen.SetSettingParams{Key: key, Value: updates[key]}); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("ApplySettings: %s: %w", key, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("ApplySettings: commit: %w", err)
	}
	return nil
}

// GetAllSettings returns all settings as a key→value map.
func (d *DB) GetAllSettings(ctx context.Context) (map[string]string, error) {
	rows, err := d.q.GetAllSettings(ctx)
	if err != nil {
		return nil, fmt.Errorf("GetAllSettings: %w", err)
	}
	result := make(map[string]string, len(rows))
	for _, s := range rows {
		result[s.Key] = s.Value
	}
	return result, nil
}

// CountUsersWithoutTOTP returns users not effectively banned with no confirmed TOTP secret.
func (d *DB) CountUsersWithoutTOTP(ctx context.Context) (int, error) {
	count, err := d.q.CountUsersWithoutTOTP(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountUsersWithoutTOTP: %w", err)
	}
	return int(count), nil
}
