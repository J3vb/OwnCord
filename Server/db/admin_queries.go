package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/owncord/server/db/dbgen"
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
	if stats.MessageCount, err = d.q.CountActiveMessages(ctx); err != nil {
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

// ListAllUsers returns users joined with their role name, ordered by ID.
// limit=0 returns no rows.
func (d *DB) ListAllUsers(ctx context.Context, limit, offset int) ([]UserWithRole, error) {
	rows, err := d.q.ListAllUsers(ctx, dbgen.ListAllUsersParams{
		Limit:  int64(limit),
		Offset: int64(offset),
	})
	if err != nil {
		return nil, fmt.Errorf("ListAllUsers: %w", err)
	}
	result := make([]UserWithRole, 0, len(rows))
	for _, r := range rows {
		result = append(result, UserWithRole{
			User: User{
				ID:         r.ID,
				Username:   r.Username,
				Avatar:     r.Avatar,
				RoleID:     r.RoleID,
				Status:     r.Status,
				CreatedAt:  r.CreatedAt,
				LastSeen:   r.LastSeen,
				Banned:     r.Banned != 0,
				BanReason:  r.BanReason,
				BanExpires: r.BanExpires,
			},
			RoleName: r.RoleName,
		})
	}
	return result, nil
}

// UpdateUserRole changes the role_id of a user.
func (d *DB) UpdateUserRole(ctx context.Context, userID, roleID int64) error {
	if err := d.q.UpdateUserRole(ctx, dbgen.UpdateUserRoleParams{
		RoleID: roleID,
		ID:     userID,
	}); err != nil {
		return fmt.Errorf("UpdateUserRole: %w", err)
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
		sessions = append(sessions, sessionFromGen(s))
	}
	return sessions, nil
}

// ─── Channel Management (admin) ───────────────────────────────────────────────

// AdminCreateChannel creates a channel with full field control including position.
// No sqlc query covers this exact INSERT shape, so it stays on raw SQL.
func (d *DB) AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error) {
	res, err := d.writer.ExecContext(ctx,
		`INSERT INTO channels (name, type, category, topic, position)
		 VALUES (?, ?, ?, ?, ?)`,
		name, chanType, strToNullPtr(category), strToNullPtr(topic), position,
	)
	if err != nil {
		return 0, fmt.Errorf("AdminCreateChannel: %w", err)
	}
	return res.LastInsertId()
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
	Name     string
	Topic    string
	Category string
	SlowMode int
	Position int
	Archived bool
	// NSFW is stored and broadcast only; it drives no server-side content
	// behaviour (see migration 025).
	NSFW bool
	// VoiceMaxUsers / VoiceMaxVideo are the voice capacity limits the ws
	// voice-join path already enforces (0 = unlimited). They are meaningless
	// on a text channel but are still written there, because refusing them
	// would make the value depend on a type that can never change anyway.
	VoiceMaxUsers int
	VoiceMaxVideo int
}

// AdminUpdateChannel updates all mutable channel fields, category included —
// moving a channel between categories is a rename of free text, not a
// structural change, so it rides on the ordinary update.
func (d *DB) AdminUpdateChannel(ctx context.Context, id int64, u ChannelUpdate) error {
	if err := d.q.AdminUpdateChannel(ctx, dbgen.AdminUpdateChannelParams{
		Name:          u.Name,
		Topic:         strToNullPtr(u.Topic),
		Category:      strToNullPtr(u.Category),
		SlowMode:      int64(u.SlowMode),
		Position:      int64(u.Position),
		Archived:      b2i64(u.Archived),
		Nsfw:          b2i64(u.NSFW),
		VoiceMaxUsers: int64(u.VoiceMaxUsers),
		VoiceMaxVideo: int64(u.VoiceMaxVideo),
		ID:            id,
	}); err != nil {
		return fmt.Errorf("AdminUpdateChannel: %w", err)
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
	for _, e := range entries {
		if err := d.LogAudit(ctx, e.ActorID, e.Action, e.TargetType, e.TargetID, e.Detail); err != nil {
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
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)`,
	)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("PersistAudits prepare: %w", err)
	}
	defer func() { _ = stmt.Close() }()
	for _, e := range entries {
		if _, err := stmt.ExecContext(ctx, e.ActorID, e.Action, e.TargetType, e.TargetID, e.Detail); err != nil {
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
	rows, err := d.q.GetAuditLog(ctx, dbgen.GetAuditLogParams{
		Limit:  int64(limit),
		Offset: int64(offset),
	})
	if err != nil {
		return nil, fmt.Errorf("GetAuditLog: %w", err)
	}
	entries := make([]AuditEntry, 0, len(rows))
	for _, r := range rows {
		entries = append(entries, AuditEntry{
			ID:         r.ID,
			ActorID:    r.ActorID,
			ActorName:  r.ActorName,
			Action:     r.Action,
			TargetType: r.TargetType,
			TargetID:   r.TargetID,
			Detail:     r.Detail,
			CreatedAt:  r.CreatedAt,
		})
	}
	return entries, nil
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

// CountUsersWithoutTOTP returns the number of non-banned users that do not
// currently have a confirmed TOTP secret.
func (d *DB) CountUsersWithoutTOTP(ctx context.Context) (int, error) {
	count, err := d.q.CountUsersWithoutTOTP(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountUsersWithoutTOTP: %w", err)
	}
	return int(count), nil
}

// ─── Backup ───────────────────────────────────────────────────────────────────

// BackupTo creates an online backup of the database using SQLite's VACUUM INTO.
// The destination path must not already exist.
//
// Security: VACUUM INTO does not support bind parameters, so the path is
// interpolated into SQL. To prevent injection we enforce two structural guards:
//  1. The path must resolve to a location under safeRoot (after filepath.Clean
//     and filepath.Abs).
//  2. After structural validation, any single-quote, semicolon, double-dash,
//     or null byte in the cleaned path causes rejection as defence-in-depth.
//
// The caller in handleBackup constructs the path from a hardcoded directory
// and a timestamp — no user input reaches this function.
func (d *DB) BackupTo(ctx context.Context, path string) error {
	return d.BackupToSafe(ctx, path, filepath.Join("data", "backups"))
}

// BackupToSafe is the internal implementation that accepts an explicit safe
// root directory. Exported for testing with isolated directories.
func (d *DB) BackupToSafe(ctx context.Context, path, safeRoot string) error {
	clean := filepath.Clean(path)

	absRoot, err := filepath.Abs(safeRoot)
	if err != nil {
		return fmt.Errorf("BackupToSafe: resolving safe root: %w", err)
	}
	absClean, err := filepath.Abs(clean)
	if err != nil {
		return fmt.Errorf("BackupToSafe: resolving path: %w", err)
	}

	// Structural guard: path must be under the safe root directory.
	if !strings.HasPrefix(absClean, absRoot+string(filepath.Separator)) {
		return fmt.Errorf("BackupToSafe: path %q is not under safe root %q", absClean, absRoot)
	}

	// Defence-in-depth: only allow safe characters (alphanumeric, path separators,
	// hyphen, underscore, dot, space, colon, tilde). This is a strict allowlist —
	// anything else is rejected to prevent SQL injection via the interpolated path.
	for _, ch := range absClean {
		switch {
		case ch >= 'a' && ch <= 'z',
			ch >= 'A' && ch <= 'Z',
			ch >= '0' && ch <= '9',
			ch == '/' || ch == '\\' || ch == '-' || ch == '_' || ch == '.' || ch == ' ' || ch == ':' || ch == '~':
			// allowed (colon for Windows drive letters, tilde for temp paths)
		default:
			return fmt.Errorf("BackupToSafe: path contains forbidden character %q", string(ch))
		}
	}

	// Reject SQL comment sequences that could break the VACUUM INTO statement,
	// even though individual hyphens are allowed for filenames.
	if strings.Contains(absClean, "--") {
		return fmt.Errorf("BackupToSafe: path contains forbidden sequence %q", "--")
	}

	// VACUUM INTO refuses to write over an existing destination on its own,
	// but only after it has already created (and, on failure below, would
	// otherwise abandon) the file. Check explicitly and return before the
	// exec so the failure branch below can tell "this call created the file"
	// (safe to remove) from "the file was already there" (a same-second
	// timestamp collision, or an operator-chosen name) without ever deleting
	// something that predates this call.
	if _, statErr := os.Stat(absClean); statErr == nil {
		return fmt.Errorf("BackupToSafe: destination %q already exists", absClean)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("BackupToSafe: checking destination %q: %w", absClean, statErr)
	}

	_, err = d.writer.ExecContext(ctx, fmt.Sprintf("VACUUM INTO '%s'", absClean))
	if err != nil {
		// An interrupted VACUUM INTO (ENOSPC, EIO, a canceled/expired ctx, ...)
		// leaves a truncated file at absClean. Since the existence check above
		// already proved nothing was there before this call, whatever exists
		// now was created by this exec and is safe to remove — leaving it
		// behind would let handleListBackups offer a truncated, unrestorable
		// .db as a normal backup (OC-0212).
		_ = os.Remove(absClean)
		return fmt.Errorf("BackupToSafe: %w", err)
	}
	return nil
}
