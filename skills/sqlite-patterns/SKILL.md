---
name: sqlite-patterns
description: Patterns for SQLite database access in the chat server — connection setup, migrations, query patterns, full-text search, and backup. Use this skill when working on the db/ package, writing SQL queries, creating migrations, implementing search, or handling database backups. Trigger when the user mentions SQLite, database, migration, query, search, FTS5, backup, or schema changes. Also use when debugging slow queries or data integrity issues.
---

# SQLite Patterns for ChatServer

## Connection Setup

```go
import (
    "database/sql"
    _ "modernc.org/sqlite"
)

func Open(path string) (*DB, error) {
    db, err := sql.Open("sqlite", path)
    if err != nil {
        return nil, err
    }

    // Essential pragmas — run on every connection
    pragmas := []string{
        "PRAGMA journal_mode=WAL",        // concurrent reads, better performance
        "PRAGMA foreign_keys=ON",         // enforce FK constraints
        "PRAGMA busy_timeout=5000",       // wait 5s on lock instead of failing
        "PRAGMA synchronous=NORMAL",      // safe with WAL, faster than FULL
        "PRAGMA cache_size=-20000",       // 20MB cache
        "PRAGMA temp_store=MEMORY",       // temp tables in memory
    }
    for _, p := range pragmas {
        db.Exec(p)
    }

    return &DB{db: db}, nil
}

type DB struct {
    db *sql.DB
}
```

## Migration System

```
migrations/
├── 001_init.sql          ← core tables (users, channels, messages, etc.)
├── 002_fts.sql           ← FTS5 virtual table + triggers
├── 003_soundboard.sql    ← soundboard table
└── ...
```

```go
//go:embed migrations/*.sql
var migrationsFS embed.FS

func (d *DB) Migrate() error {
    // Create version tracking
    d.db.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER)`)

    var current int
    d.db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_version").Scan(&current)

    files, _ := fs.ReadDir(migrationsFS, "migrations")
    for _, f := range files {
        // Extract version number from filename: "001_init.sql" -> 1
        num := extractVersion(f.Name())
        if num <= current {
            continue
        }

        data, _ := fs.ReadFile(migrationsFS, "migrations/"+f.Name())
        tx, _ := d.db.Begin()
        _, err := tx.Exec(string(data))
        if err != nil {
            tx.Rollback()
            return fmt.Errorf("migration %s failed: %w", f.Name(), err)
        }
        tx.Exec("INSERT INTO schema_version (version) VALUES (?)", num)
        tx.Commit()
        slog.Info("applied migration", "file", f.Name())
    }
    return nil
}
```

## Query Patterns

### Always Use Parameterized Queries

```go
// CORRECT — parameterized
row := d.db.QueryRow("SELECT id, username FROM users WHERE username = ?", username)

// NEVER DO THIS — SQL injection
row := d.db.QueryRow("SELECT * FROM users WHERE username = '" + username + "'")
```

### Common Query Methods

```go
// Single row
func (d *DB) GetUser(id int) (*User, error) {
    var u User
    err := d.db.QueryRow(`
        SELECT u.id, u.username, u.avatar, u.status, r.permissions, r.name as role_name
        FROM users u JOIN roles r ON u.role_id = r.id
        WHERE u.id = ? AND u.banned = 0
    `, id).Scan(&u.ID, &u.Username, &u.Avatar, &u.Status, &u.Permissions, &u.RoleName)
    if err == sql.ErrNoRows {
        return nil, nil
    }
    return &u, err
}

// Multiple rows
func (d *DB) GetMessages(channelID, beforeID, limit int) ([]Message, error) {
    query := `
        SELECT m.id, m.channel_id, m.user_id, u.username, u.avatar,
               m.content, m.reply_to, m.edited_at, m.deleted, m.pinned, m.timestamp
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = ? AND m.id < ?
        ORDER BY m.id DESC
        LIMIT ?
    `
    rows, err := d.db.Query(query, channelID, beforeID, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var messages []Message
    for rows.Next() {
        var m Message
        rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Username, &m.Avatar,
            &m.Content, &m.ReplyTo, &m.EditedAt, &m.Deleted, &m.Pinned, &m.Timestamp)
        messages = append(messages, m)
    }
    return messages, rows.Err()
}

// Insert returning ID
func (d *DB) CreateMessage(channelID, userID int, content string, replyTo *int, attachments []string) (*Message, error) {
    tx, _ := d.db.Begin()
    defer tx.Rollback()

    res, err := tx.Exec(`
        INSERT INTO messages (channel_id, user_id, content, reply_to)
        VALUES (?, ?, ?, ?)
    `, channelID, userID, content, replyTo)
    if err != nil {
        return nil, err
    }

    id, _ := res.LastInsertId()

    // Link attachments
    for _, aid := range attachments {
        tx.Exec("UPDATE attachments SET message_id = ? WHERE id = ?", id, aid)
    }

    tx.Commit()

    // Fetch the complete message for broadcasting
    return d.GetMessage(int(id))
}
```

### Use Transactions for Multi-Step Operations

```go
func (d *DB) BanUser(userID int, reason string, expiresAt *time.Time) error {
    tx, _ := d.db.Begin()
    defer tx.Rollback()

    // Ban the user
    tx.Exec("UPDATE users SET banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?",
        reason, expiresAt, userID)

    // Revoke all sessions
    tx.Exec("DELETE FROM sessions WHERE user_id = ?", userID)

    return tx.Commit()
}
```

## Full-Text Search (FTS5)

### Setup (in migration 002_fts.sql)

```sql
-- Virtual table
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
);

-- Keep FTS in sync with triggers
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
```

### Search Query

```go
func (d *DB) Search(userID int, query string, channelID *int, limit int) ([]SearchResult, error) {
    // User can only search channels they have read permission for.
    // Build list of accessible channel IDs first.
    accessibleChannels := d.GetAccessibleChannelIDs(userID)

    sql := `
        SELECT m.id, m.channel_id, c.name, m.user_id, u.username,
               snippet(messages_fts, 0, '**', '**', '...', 32) as snippet,
               m.timestamp
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN channels c ON m.channel_id = c.id
        JOIN users u ON m.user_id = u.id
        WHERE messages_fts MATCH ?
          AND m.channel_id IN (` + placeholders(len(accessibleChannels)) + `)
          AND m.deleted = 0
        ORDER BY rank
        LIMIT ?
    `
    args := []interface{}{query}
    for _, id := range accessibleChannels {
        args = append(args, id)
    }
    args = append(args, limit)

    // ... execute and scan
}
```

## Session Management

```go
func (d *DB) CreateSession(userID int, ip, device string) (string, error) {
    token := generateSecureToken() // 256-bit random, hex encoded
    expiresAt := time.Now().Add(30 * 24 * time.Hour)

    _, err := d.db.Exec(`
        INSERT INTO sessions (user_id, token, ip_address, device, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `, userID, token, ip, device, expiresAt)

    return token, err
}

func (d *DB) ValidateSession(token string) (*User, error) {
    var u User
    err := d.db.QueryRow(`
        SELECT u.id, u.username, u.avatar, u.status, r.permissions, r.name
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        JOIN roles r ON u.role_id = r.id
        WHERE s.token = ? AND s.expires_at > datetime('now') AND u.banned = 0
    `, token).Scan(&u.ID, &u.Username, &u.Avatar, &u.Status, &u.Permissions, &u.RoleName)

    if err == nil {
        // Update last_used
        d.db.Exec("UPDATE sessions SET last_used = datetime('now') WHERE token = ?", token)
    }
    return &u, err
}
```

## Backup

```go
func (d *DB) Backup(destPath string) error {
    // SQLite backup API via SQL
    _, err := d.db.Exec("VACUUM INTO ?", destPath)
    return err
    // VACUUM INTO creates a clean copy, safe to call while the server is running.
    // The backup is a standalone .db file.
}
```

For full backup (database + uploads):

```go
func FullBackup(cfg Config) error {
    timestamp := time.Now().Format("2006-01-02_150405")
    backupDir := filepath.Join(cfg.DataDir, "backups")
    os.MkdirAll(backupDir, 0755)

    // 1. Backup database
    dbBackup := filepath.Join(backupDir, timestamp+"_db.sqlite")
    d.Backup(dbBackup)

    // 2. Create zip of database + uploads
    zipPath := filepath.Join(backupDir, timestamp+".zip")
    createZip(zipPath, []string{dbBackup, filepath.Join(cfg.DataDir, "uploads")})

    // 3. Clean up temp db copy
    os.Remove(dbBackup)

    // 4. Prune old backups (keep N most recent)
    pruneBackups(backupDir, cfg.BackupRetention)

    return nil
}
```

## Performance Notes

- SQLite handles the read/write load of a small chat server trivially.
- WAL mode allows concurrent reads while writing.
- Single-writer is fine — at this scale, writes complete in microseconds.
- Index on `messages(channel_id, id DESC)` is critical for paginated history.
- FTS5 queries are very fast — sub-millisecond for typical search volumes.
- `VACUUM INTO` for backups doesn't block the main database.
- If the database grows large (>1GB), consider archiving old messages to a separate file.
