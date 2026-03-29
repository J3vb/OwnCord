package db

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// ─── Setup ───────────────────────────────────────────────────────────────────

// UserCount returns the total number of registered users.
func (d *DB) UserCount() (int64, error) {
	var count int64
	if err := d.sqlDB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return 0, fmt.Errorf("UserCount: %w", err)
	}
	return count, nil
}

// ─── Server Stats ─────────────────────────────────────────────────────────────

// GetServerStats returns aggregate counts for the admin dashboard.
// DBSizeBytes is 0 for in-memory databases (page_count * page_size returns
// a meaningful value only for file-backed databases).
func (d *DB) GetServerStats() (*ServerStats, error) {
	stats := &ServerStats{}

	if err := d.sqlDB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&stats.UserCount); err != nil {
		return nil, fmt.Errorf("GetServerStats users: %w", err)
	}
	if err := d.sqlDB.QueryRow(`SELECT COUNT(*) FROM messages WHERE deleted = 0`).Scan(&stats.MessageCount); err != nil {
		return nil, fmt.Errorf("GetServerStats messages: %w", err)
	}
	if err := d.sqlDB.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&stats.ChannelCount); err != nil {
		return nil, fmt.Errorf("GetServerStats channels: %w", err)
	}
	if err := d.sqlDB.QueryRow(`SELECT COUNT(*) FROM invites WHERE revoked = 0`).Scan(&stats.InviteCount); err != nil {
		return nil, fmt.Errorf("GetServerStats invites: %w", err)
	}

	// page_count * page_size gives the database size in bytes.
	// For :memory: databases this still works (returns the in-memory size).
	var pageCount, pageSize int64
	if err := d.sqlDB.QueryRow(`PRAGMA page_count`).Scan(&pageCount); err != nil {
		return nil, fmt.Errorf("GetServerStats page_count: %w", err)
	}
	if err := d.sqlDB.QueryRow(`PRAGMA page_size`).Scan(&pageSize); err != nil {
		return nil, fmt.Errorf("GetServerStats page_size: %w", err)
	}
	stats.DBSizeBytes = pageCount * pageSize

	return stats, nil
}

// ─── User Management ──────────────────────────────────────────────────────────

// ListAllUsers returns users joined with their role name, ordered by ID.
// limit=0 returns no rows.
func (d *DB) ListAllUsers(limit, offset int) ([]UserWithRole, error) {
	rows, err := d.sqlDB.Query(
		`SELECT u.id, u.username, u.password, u.avatar, u.role_id, u.totp_secret,
		        u.status, u.created_at, u.last_seen, u.banned, u.ban_reason, u.ban_expires,
		        COALESCE(r.name, '') AS role_name
		 FROM users u
		 LEFT JOIN roles r ON r.id = u.role_id
		 ORDER BY u.id ASC
		 LIMIT ? OFFSET ?`,
		limit, offset,
	)
	if err != nil {
		return nil, fmt.Errorf("ListAllUsers: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var result []UserWithRole
	for rows.Next() {
		var uwr UserWithRole
		var banned int
		err := rows.Scan(
			&uwr.ID, &uwr.Username, &uwr.PasswordHash, &uwr.Avatar, &uwr.RoleID,
			&uwr.TOTPSecret, &uwr.Status, &uwr.CreatedAt, &uwr.LastSeen,
			&banned, &uwr.BanReason, &uwr.BanExpires,
			&uwr.RoleName,
		)
		if err != nil {
			return nil, fmt.Errorf("ListAllUsers scan: %w", err)
		}
		uwr.Banned = banned != 0
		result = append(result, uwr)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListAllUsers rows: %w", rows.Err())
	}
	if result == nil {
		result = []UserWithRole{}
	}
	return result, nil
}

// UpdateUserRole changes the role_id of a user.
func (d *DB) UpdateUserRole(userID, roleID int64) error {
	_, err := d.sqlDB.Exec(
		`UPDATE users SET role_id = ? WHERE id = ?`,
		roleID, userID,
	)
	if err != nil {
		return fmt.Errorf("UpdateUserRole: %w", err)
	}
	return nil
}

// ForceLogoutUser deletes all sessions for the given user ID.
func (d *DB) ForceLogoutUser(userID int64) error {
	_, err := d.sqlDB.Exec(`DELETE FROM sessions WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("ForceLogoutUser: %w", err)
	}
	return nil
}

// GetUserSessions returns all active sessions for the given user ID.
func (d *DB) GetUserSessions(userID int64) ([]Session, error) {
	rows, err := d.sqlDB.Query(
		`SELECT id, user_id, token, device, ip_address, created_at, last_used, expires_at
		 FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("GetUserSessions: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var sessions []Session
	for rows.Next() {
		var s Session
		err := rows.Scan(
			&s.ID, &s.UserID, &s.TokenHash, &s.Device, &s.IP,
			&s.CreatedAt, &s.LastUsed, &s.ExpiresAt,
		)
		if err != nil {
			return nil, fmt.Errorf("GetUserSessions scan: %w", err)
		}
		sessions = append(sessions, s)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetUserSessions rows: %w", rows.Err())
	}
	if sessions == nil {
		sessions = []Session{}
	}
	return sessions, nil
}

// ─── Channel Management (admin) ───────────────────────────────────────────────

// AdminCreateChannel creates a channel with full field control including position.
func (d *DB) AdminCreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	res, err := d.sqlDB.Exec(
		`INSERT INTO channels (name, type, category, topic, position)
		 VALUES (?, ?, ?, ?, ?)`,
		name, chanType, nullableString(category), nullableString(topic), position,
	)
	if err != nil {
		return 0, fmt.Errorf("AdminCreateChannel: %w", err)
	}
	return res.LastInsertId()
}

// AdminUpdateChannel updates all mutable channel fields.
func (d *DB) AdminUpdateChannel(id int64, name, topic string, slowMode, position int, archived bool) error {
	archivedInt := 0
	if archived {
		archivedInt = 1
	}
	_, err := d.sqlDB.Exec(
		`UPDATE channels
		 SET name = ?, topic = ?, slow_mode = ?, position = ?, archived = ?
		 WHERE id = ?`,
		name, nullableString(topic), slowMode, position, archivedInt, id,
	)
	if err != nil {
		return fmt.Errorf("AdminUpdateChannel: %w", err)
	}
	return nil
}

// AdminDeleteChannel removes a channel by ID (cascades to messages, etc.).
func (d *DB) AdminDeleteChannel(id int64) error {
	_, err := d.sqlDB.Exec(`DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("AdminDeleteChannel: %w", err)
	}
	return nil
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

// LogAudit inserts an audit log entry.
func (d *DB) LogAudit(actorID int64, action, targetType string, targetID int64, detail string) error {
	_, err := d.sqlDB.Exec(
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
		 VALUES (?, ?, ?, ?, ?)`,
		actorID, action, targetType, targetID, detail,
	)
	if err != nil {
		return fmt.Errorf("LogAudit: %w", err)
	}
	return nil
}

// GetAuditLog returns audit log entries ordered newest-first with pagination.
func (d *DB) GetAuditLog(limit, offset int) ([]AuditEntry, error) {
	rows, err := d.sqlDB.Query(
		`SELECT a.id, a.actor_id, COALESCE(u.username, ''), a.action,
		        a.target_type, a.target_id, a.detail, a.created_at
		 FROM audit_log a
		 LEFT JOIN users u ON u.id = a.actor_id
		 ORDER BY a.id DESC
		 LIMIT ? OFFSET ?`,
		limit, offset,
	)
	if err != nil {
		return nil, fmt.Errorf("GetAuditLog: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(
			&e.ID, &e.ActorID, &e.ActorName, &e.Action,
			&e.TargetType, &e.TargetID, &e.Detail, &e.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("GetAuditLog scan: %w", err)
		}
		entries = append(entries, e)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetAuditLog rows: %w", rows.Err())
	}
	if entries == nil {
		entries = []AuditEntry{}
	}
	return entries, nil
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// GetSetting returns the value for the given settings key.
// Returns an error (wrapping sql.ErrNoRows) when the key does not exist.
func (d *DB) GetSetting(key string) (string, error) {
	var value string
	err := d.sqlDB.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("GetSetting: key %q: %w", key, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("GetSetting: %w", err)
	}
	return value, nil
}

// SetSetting upserts a setting value for the given key.
func (d *DB) SetSetting(key, value string) error {
	_, err := d.sqlDB.Exec(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	if err != nil {
		return fmt.Errorf("SetSetting: %w", err)
	}
	return nil
}

// GetAllSettings returns all settings as a key→value map.
func (d *DB) GetAllSettings() (map[string]string, error) {
	rows, err := d.sqlDB.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return nil, fmt.Errorf("GetAllSettings: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, fmt.Errorf("GetAllSettings scan: %w", err)
		}
		result[k] = v
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetAllSettings rows: %w", rows.Err())
	}
	return result, nil
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
func (d *DB) BackupTo(path string) error {
	return d.BackupToSafe(path, filepath.Join("data", "backups"))
}

// BackupToSafe is the internal implementation that accepts an explicit safe
// root directory. Exported for testing with isolated directories.
func (d *DB) BackupToSafe(path, safeRoot string) error {
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
	for _, ch := range clean {
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
	if strings.Contains(clean, "--") {
		return fmt.Errorf("BackupToSafe: path contains forbidden sequence %q", "--")
	}

	_, err = d.sqlDB.Exec(fmt.Sprintf("VACUUM INTO '%s'", clean))
	if err != nil {
		return fmt.Errorf("BackupToSafe: %w", err)
	}
	return nil
}
