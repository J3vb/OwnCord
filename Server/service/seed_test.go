package service

import (
	"context"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// This file provides real in-memory SQLite test helpers for the service
// package. D3 removed the store abstraction (and its MemStore fake); service
// tests now run against a real *db.DB opened at ":memory:" with all migrations
// applied. The seed* helpers insert rows directly with explicit IDs so tests
// keep the fixed identifiers (user 1, channel 10, …) they relied on under the
// old fake. Migration 001 pre-seeds the four default roles, so seedRole upserts
// by id to let a test redefine a role's permission bits.

// newTestDB opens an in-memory database with the full migration set applied and
// registers cleanup. Each test gets an isolated database.
func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// seedRole upserts a role by id (overriding a default role's bits when the id
// collides with one of the migration-seeded defaults).
func seedRole(t *testing.T, database *db.DB, r *db.Role) {
	t.Helper()
	// Migration 023 made role names unique case-insensitively, so a test that
	// redefines role 3 as "member" now collides with the seeded "Member"
	// (role 4). Free the name from whichever OTHER role holds it rather than
	// making every test pick names that dodge the four defaults — the
	// displaced role keeps its id, permissions and position, which is all the
	// tests read it for.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET name = name || ' #' || id WHERE name = ? COLLATE NOCASE AND id != ?`,
		r.Name, r.ID,
	); err != nil {
		t.Fatalf("seedRole(%d) freeing name %q: %v", r.ID, r.Name, err)
	}
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		     name=excluded.name,
		     color=excluded.color,
		     permissions=excluded.permissions,
		     position=excluded.position`,
		r.ID, r.Name, r.Color, r.Permissions, r.Position,
	)
	if err != nil {
		t.Fatalf("seedRole(%d): %v", r.ID, err)
	}
}

// seedUserRole assigns a role to a user, creating a minimal user row when one
// does not already exist. It preserves any identity fields set by an earlier
// seedUser call and only writes role_id.
func seedUserRole(t *testing.T, database *db.DB, userID, roleID int64) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password, role_id)
		 VALUES (?, ?, '', ?)
		 ON CONFLICT(id) DO UPDATE SET role_id=excluded.role_id`,
		userID, seedUsername(userID), roleID,
	)
	if err != nil {
		t.Fatalf("seedUserRole(%d,%d): %v", userID, roleID, err)
	}
}

// seedUser upserts a user's identity fields by id without clobbering a role_id
// assigned by a prior seedUserRole call.
func seedUser(t *testing.T, database *db.DB, u *db.User) {
	t.Helper()
	username := u.Username
	if username == "" {
		username = seedUsername(u.ID)
	}
	status := u.Status
	if status == "" {
		status = "offline"
	}
	var banReason any
	if u.BanReason != nil {
		banReason = *u.BanReason
	}
	var avatar any
	if u.Avatar != nil {
		avatar = *u.Avatar
	}
	banned := 0
	if u.Banned {
		banned = 1
	}
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password, avatar, status, banned, ban_reason)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		     username=excluded.username,
		     password=excluded.password,
		     avatar=excluded.avatar,
		     status=excluded.status,
		     banned=excluded.banned,
		     ban_reason=excluded.ban_reason`,
		u.ID, username, u.PasswordHash, avatar, status, banned, banReason,
	)
	if err != nil {
		t.Fatalf("seedUser(%d): %v", u.ID, err)
	}
}

// seedChannel upserts a channel by id.
func seedChannel(t *testing.T, database *db.DB, ch *db.Channel) {
	t.Helper()
	ctype := ch.Type
	if ctype == "" {
		ctype = "text"
	}
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (id, name, type, category, topic, position)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		     name=excluded.name,
		     type=excluded.type,
		     category=excluded.category,
		     topic=excluded.topic,
		     position=excluded.position`,
		ch.ID, ch.Name, ctype, nullStr(ch.Category), nullStr(ch.Topic), ch.Position,
	)
	if err != nil {
		t.Fatalf("seedChannel(%d): %v", ch.ID, err)
	}
}

// seedChannelOverride sets a per-channel permission override for a role.
func seedChannelOverride(t *testing.T, database *db.DB, roleID, channelID, allow, deny int64) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(channel_id, role_id) DO UPDATE SET
		     allow=excluded.allow,
		     deny=excluded.deny`,
		channelID, roleID, allow, deny,
	)
	if err != nil {
		t.Fatalf("seedChannelOverride(role=%d,chan=%d): %v", roleID, channelID, err)
	}
}

// seedDMParticipant adds a user as a participant of a DM channel.
func seedDMParticipant(t *testing.T, database *db.DB, channelID, userID int64) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT OR IGNORE INTO dm_participants (channel_id, user_id) VALUES (?, ?)`,
		channelID, userID,
	)
	if err != nil {
		t.Fatalf("seedDMParticipant(chan=%d,user=%d): %v", channelID, userID, err)
	}
}

// seedBlock records that blockerID has blocked blockedID.
func seedBlock(t *testing.T, database *db.DB, blockerID, blockedID int64) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)`,
		blockerID, blockedID,
	)
	if err != nil {
		t.Fatalf("seedBlock(%d,%d): %v", blockerID, blockedID, err)
	}
}

func seedUsername(id int64) string {
	return "seeduser" + strconv.FormatInt(id, 10)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
