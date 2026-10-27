package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ─── Setup ───────────────────────────────────────────────────────────────────

// UserCount returns the total number of registered users.
func (d *DB) UserCount(ctx context.Context) (int64, error) {
	count, err := d.q.UserCount(ctx)
	if err != nil {
		return 0, fmt.Errorf("UserCount: %w", err)
	}
	return count, nil
}

// ─── Server Stats ─────────────────────────────────────────────────────────────

// GetServerStats returns aggregate counts for the admin dashboard.
// DBSizeBytes is 0 for in-memory databases (page_count * page_size returns
// a meaningful value only for file-backed databases).
func (d *DB) GetServerStats(ctx context.Context) (*ServerStats, error) {
	stats := &ServerStats{}
	var err error

	if stats.UserCount, err = d.q.CountUsers(ctx); err != nil {
		return nil, fmt.Errorf("GetServerStats users: %w", err)
	}
	// CountActiveMessages is a full scan; the dashboard tolerates a minute of
	// staleness (SV-07).
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

	// page_count * page_size gives the database size in bytes. PRAGMAs are not
	// expressible as sqlc queries, so they stay on the raw connection.
	// For :memory: databases this still works (returns the in-memory size).
	// Both values are DB-wide, so reading them on the reader pool is fine.
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

// ─── User Management ──────────────────────────────────────────────────────────

// UserListFilter narrows ListAllUsers for the admin Members page. The zero
// value lists everyone.
type UserListFilter struct {
	// Query is a case-insensitive substring of the username or nickname; empty
	// matches all.
	Query string
	// RoleID keeps one role; 0 means any role.
	RoleID int64
	// BannedOnly keeps only effectively banned users (a lapsed temporary ban
	// does not count, as in notBannedClause).
	BannedOnly bool
}

// ListAllUsers returns active users matching f, joined with their role name
// and position, ordered by ID. limit=0 returns no rows.
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

// UpdateUserRole replaces every role userID holds with roleID: it clears the
// member's user_roles rows, grants roleID and re-mirrors users.role_id, in one
// writer transaction, so the two never disagree. Unknown users are a no-op.
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

// ─── Channel Management (admin) ───────────────────────────────────────────────

// AdminCreateChannel creates a channel with full field control including
// position. A non-empty category is resolved by name ignoring case and created
// when missing, in the same transaction as the insert (CreateChannelIn).
func (d *DB) AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error) {
	return d.CreateChannelIn(ctx, NewChannel{
		Name:         name,
		Type:         chanType,
		CategoryName: category,
		Topic:        topic,
		Position:     position,
	})
}

// ChannelUpdate is the full set of mutable channel fields an admin edit writes.
//
// A struct rather than a positional argument list: the update covers nine
// fields now, four of them ints, and `AdminUpdateChannel(ctx, id, name, topic,
// category, slowMode, position, archived, nsfw, maxUsers, maxVideo)` invites
// exactly the silent transposition (slow mode into user limit) that no test
// would catch. Every field is written unconditionally, so callers must start
// from the channel's current values — the handler does, which is what makes a
// partial PATCH body safe.
type ChannelUpdate struct {
	Name  string
	Topic string
	// CategoryID is the category the channel ends up in, 0 for none. It must
	// exist (ErrNotFound otherwise). CategoryName, when non-nil, overrides it:
	// the name is resolved ignoring case and the category created when missing,
	// in the same transaction as the update (the legacy free-text field).
	CategoryID   int64
	CategoryName *string
	// CategoryIfExists makes a CategoryID that no longer exists mean "no
	// category" instead of ErrNotFound. It is for writes that carry the
	// channel's own current category forward (a PATCH that names none, the
	// archive step of a delete), where losing a race with a category delete
	// must not fail the write.
	CategoryIfExists bool
	// CreatedCategory, when non-nil, receives the id of a category this
	// write created because CategoryName matched none. See NewChannel.
	CreatedCategory *int64
	SlowMode        int
	Position        int
	Archived        bool
	// NSFW is stored and broadcast only; it drives no server-side content
	// behaviour (see migration 025).
	NSFW bool
	// VoiceMaxUsers / VoiceMaxVideo are the voice capacity limits the ws
	// voice-join path already enforces (0 = unlimited). They are meaningless
	// on a text channel but are still written there, because refusing them
	// would make the value depend on a type that can never change anyway.
	VoiceMaxUsers int
	VoiceMaxVideo int
	// SyncGuard, when non-nil, asks for the channel's override rows to be
	// replaced by the template of the category it ends up in, and for it to be
	// marked synced (WP 6.5d). It runs in the same transaction as the update,
	// so a refusal leaves the channel where it was. ErrUncategorized when the
	// update leaves the channel with no category. Without it, a move to
	// another category keeps the channel's rows and unsyncs it.
	SyncGuard ChannelSyncGuard
	// SyncPlan, when non-nil and SyncGuard ran, receives the rows replaced.
	SyncPlan *ChannelSyncPlan
}

// AdminUpdateChannel updates all mutable channel fields, category included.
// The category resolve (when it is by name) and the update share one
// transaction.
func (d *DB) AdminUpdateChannel(ctx context.Context, id int64, u ChannelUpdate) error {
	if err := d.adminUpdateChannel(ctx, id, u, false); err != nil {
		return fmt.Errorf("AdminUpdateChannel: %w", err)
	}
	return nil
}

// adminUpdateChannel is the one write behind AdminUpdateChannel and
// AdminUpdateChannelClearingNSFW. With clearNSFW it also deletes the channel's
// standing NSFW acknowledgements, in the same transaction as the flag write.
func (d *DB) adminUpdateChannel(ctx context.Context, id int64, u ChannelUpdate, clearNSFW bool) error {
	return d.inWriteTx(ctx, "update", func(q *dbgen.Queries) error {
		var catID *int64
		var err error
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
		if u.CreatedCategory != nil && created != 0 {
			*u.CreatedCategory = created
		}
		before, err := q.GetChannelCategoryID(ctx, id)
		moved := false
		switch {
		case errors.Is(err, sql.ErrNoRows):
			// The channel is gone: the update below touches nothing.
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
		if err := applyPermissionSyncTx(ctx, q, id, catID, moved, u); err != nil {
			return err
		}
		if clearNSFW {
			return q.DeleteNSFWAcknowledgementsForChannel(ctx, id)
		}
		return nil
	})
}

func sameCategory(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// applyPermissionSyncTx applies the sync rules of a channel update inside its
// transaction. Moving the channel to another category unsyncs it and keeps its
// own override rows; an update that asked for a sync instead replaces the rows
// with the target category's template and marks the channel synced. moved was
// read in this transaction, not from a snapshot the caller took earlier.
func applyPermissionSyncTx(ctx context.Context, q *dbgen.Queries, id int64, catID *int64, moved bool, u ChannelUpdate) error {
	if u.SyncGuard != nil {
		if catID == nil {
			return ErrUncategorized
		}
		plan, err := replaceWithTemplateTx(ctx, q, id, *catID, u.SyncGuard)
		if err != nil {
			return err
		}
		if u.SyncPlan != nil {
			*u.SyncPlan = plan
		}
		return nil
	}
	if moved {
		return q.UnsyncChannelPermissions(ctx, id)
	}
	return nil
}

// AdminDeleteChannel removes a channel by ID (cascades to messages, etc.).
func (d *DB) AdminDeleteChannel(ctx context.Context, id int64) error {
	if err := d.q.DeleteChannel(ctx, id); err != nil {
		return fmt.Errorf("AdminDeleteChannel: %w", err)
	}
	return nil
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

// LogAudit inserts an audit log entry.
func (d *DB) LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error {
	if err := d.q.LogAudit(ctx, dbgen.LogAuditParams{
		ActorID:    actorID,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Detail:     detail,
	}); err != nil {
		return fmt.Errorf("LogAudit: %w", err)
	}
	return nil
}

// LogAuditEntry inserts an audit entry with every field, the tokens
// included (B4-10); LogAudit is the token-less form the rest of the server
// writes. The erasure's unlinking rules are applied under the writer
// connection, once it is held: an entry about a subject whose erasure
// committed while this call waited for the connection is written unlinked.
func (d *DB) LogAuditEntry(ctx context.Context, e AuditEntry) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("LogAuditEntry begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	e = unlinkEntry(e, d.auditUnlinkRules())
	if err := dbgen.New(tx).LogAuditEntry(ctx, dbgen.LogAuditEntryParams{
		ActorID:      e.ActorID,
		Action:       e.Action,
		TargetType:   e.TargetType,
		TargetID:     e.TargetID,
		Detail:       e.Detail,
		SubjectToken: nullableToken(e.SubjectToken),
		ActorToken:   nullableToken(e.ActorToken),
	}); err != nil {
		return fmt.Errorf("LogAuditEntry: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("LogAuditEntry commit: %w", err)
	}
	return nil
}

// PersistAudits inserts a batch of audit entries in a single transaction with
// one prepared insert, so the audit writer's flush pays for one fsync instead
// of one per entry. Only the LogAudit-shaped fields are written — ID, ActorName
// and CreatedAt on the input rows are ignored (the id autoincrements, the
// created_at column defaults, and actor_name is a join product).
//
// Best-effort semantics mirror PersistEvents: if the batched transaction fails,
// it falls back to per-row inserts so the good rows still land. Returns the
// number of rows persisted and, when any row was lost, the first per-row error.
func (d *DB) PersistAudits(ctx context.Context, entries []AuditEntry) (int, error) {
	if len(entries) == 0 {
		return 0, nil
	}
	if err := d.persistAuditsTx(ctx, entries); err == nil {
		return len(entries), nil
	}
	// Fallback: insert rows individually so one bad row doesn't drop the batch.
	persisted := 0
	var firstErr error
	for i := range entries {
		e := &entries[i]
		if err := d.LogAuditEntry(ctx, *e); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		persisted++
	}
	return persisted, firstErr
}

// persistAuditsTx inserts all entries inside one transaction; any failure
// rolls the whole batch back.
func (d *DB) persistAuditsTx(ctx context.Context, entries []AuditEntry) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("PersistAudits begin tx: %w", err)
	}
	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, subject_token, actor_token) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''))`,
	)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("PersistAudits prepare: %w", err)
	}
	defer func() { _ = stmt.Close() }()
	// The erasure's unlinking rules, read now that the writer connection is
	// held: an erasure that committed while this batch waited for it has
	// installed its rule, and the batch's entries about the subject go down
	// unlinked instead of raw after the transaction's UPDATE.
	rules := d.auditUnlinkRules()
	for i := range entries {
		e := unlinkEntry(entries[i], rules)
		if _, err := stmt.ExecContext(ctx, e.ActorID, e.Action, e.TargetType, e.TargetID, e.Detail, e.SubjectToken, e.ActorToken); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("PersistAudits insert action %q: %w", e.Action, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("PersistAudits commit: %w", err)
	}
	return nil
}

// GetAuditLog returns audit log entries ordered newest-first with pagination.
func (d *DB) GetAuditLog(ctx context.Context, limit, offset int) ([]AuditEntry, error) {
	return d.SearchAuditLog(ctx, "", "", false, limit, offset)
}

// SearchAuditLog is GetAuditLog narrowed to one action (exact) and to rows
// whose actor name, action, target type or detail contains query (ASCII
// case-insensitive). An empty action or query does not narrow. hideSignins
// drops the user_login and ws_connect rows.
//
// ponytail: a substring scan over the whole table, fine at an admin's page
// rate; an FTS5 index over audit_log is the upgrade if the table outgrows it.
func (d *DB) SearchAuditLog(ctx context.Context, action, query string, hideSignins bool, limit, offset int) ([]AuditEntry, error) {
	var hide int64
	if hideSignins {
		hide = 1
	}
	rows, err := d.q.GetAuditLog(ctx, dbgen.GetAuditLogParams{
		Action:      action,
		HideSignins: hide,
		Query:       query,
		RowLimit:    int64(limit),
		RowOffset:   int64(offset),
	})
	if err != nil {
		return nil, fmt.Errorf("SearchAuditLog: %w", err)
	}
	entries := make([]AuditEntry, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		entries = append(entries, AuditEntry{
			ID:           r.ID,
			ActorID:      r.ActorID,
			ActorName:    r.ActorName,
			Action:       r.Action,
			TargetType:   r.TargetType,
			TargetID:     r.TargetID,
			Detail:       r.Detail,
			SubjectToken: r.SubjectToken,
			ActorToken:   r.ActorToken,
			CreatedAt:    r.CreatedAt,
		})
	}
	return entries, nil
}

// ListAuditActions returns up to limit distinct action names in the whole
// audit log, sorted.
func (d *DB) ListAuditActions(ctx context.Context, limit int) ([]string, error) {
	actions, err := d.q.ListAuditActions(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("ListAuditActions: %w", err)
	}
	return actions, nil
}

// nullableToken maps an empty token to NULL, so the partial indexes on the
// token columns hold only the rows that carry one.
func nullableToken(token string) *string {
	if token == "" {
		return nil
	}
	return &token
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// GetSetting returns the value for the given settings key.
// Returns an error (wrapping sql.ErrNoRows) when the key does not exist.
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

// ApplySettings upserts every key→value pair in one transaction, so a
// mid-loop failure leaves no partial update behind. Keys are applied in
// sorted order for deterministic behaviour under test.
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

// CountUsersWithoutTOTP returns the number of users who are not effectively
// banned (unbanned, or serving a temporary ban whose ban_expires has already
// lapsed) and do not currently have a confirmed TOTP secret.
func (d *DB) CountUsersWithoutTOTP(ctx context.Context) (int, error) {
	count, err := d.q.CountUsersWithoutTOTP(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountUsersWithoutTOTP: %w", err)
	}
	return int(count), nil
}
