//go:build postgres

// Package store — PostgreSQL backend.
//
// This file is compiled only when the `postgres` build tag is set. The
// default `go build ./...` produces a sqlite-only binary with zero postgres
// dependencies. To enable postgres support:
//
//	go get github.com/jackc/pgx/v5
//	go build -tags postgres ./...
//
// The connection lifecycle methods (Open, Close, SQLDb, WithTx) are fully
// implemented against the pgx stdlib driver. Query methods are stubbed —
// they satisfy the Store interface so the type-assertion check at the
// bottom of this file passes, but each returns ErrPostgresNotImplemented at
// runtime. The stubs will be replaced incrementally as Server/db/pgdbgen/
// is generated from the query files in Server/db/queries/postgres/ via
// `make sqlc-generate`, and PostgresStore methods migrate to wrap the
// generated querier.
//
// Until the store-everywhere refactor lands in main.go / router.go, this
// type is not yet wired into the runtime — see phase-a-foundation.md's
// "Pending" section. Constructing a PostgresStore in isolation works, but
// main.go will still refuse to start with type: "postgres" until the
// boundary refactor lands.

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	// pgx's stdlib driver exposes pgx as a database/sql driver, letting
	// PostgresStore reuse the same *sql.DB patterns as SQLiteStore. Once the
	// sqlc-generated pgdbgen package is wired in, this import shifts to the
	// native pgxpool API for zero-overhead query execution.
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// ErrPostgresNotImplemented is returned by every query method that is not
// yet backed by sqlc-generated code. It is a sentinel error so callers and
// tests can detect "postgres path reached but implementation pending".
var ErrPostgresNotImplemented = errors.New("postgres backend: query not yet implemented (awaiting sqlc-generated pgdbgen)")

// PostgresStore implements store.Store against a PostgreSQL database.
// It wraps a *sql.DB opened with pgx's stdlib driver. The query methods are
// currently stubs; see the package-level comment for the migration path.
type PostgresStore struct {
	sqlDB *sql.DB
}

// NewPostgresStore creates a PostgresStore from an already-open *sql.DB.
// Callers that want a one-step constructor should use OpenPostgres.
func NewPostgresStore(sqlDB *sql.DB) *PostgresStore {
	return &PostgresStore{sqlDB: sqlDB}
}

// OpenPostgres dials a PostgreSQL server using the connection settings in
// cfg and returns a ready-to-use PostgresStore. The caller is responsible
// for calling Close when done. Connection pooling is handled by *sql.DB;
// cfg.MaxConns > 0 caps the pool at that size, otherwise the database/sql
// default is used.
func OpenPostgres(cfg *config.DatabaseConfig) (*PostgresStore, error) {
	if cfg == nil {
		return nil, errors.New("OpenPostgres: nil config")
	}
	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Name, cfg.SSLMode,
	)
	sqlDB, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("OpenPostgres: open: %w", err)
	}
	if cfg.MaxConns > 0 {
		sqlDB.SetMaxOpenConns(cfg.MaxConns)
		sqlDB.SetMaxIdleConns(cfg.MaxConns)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("OpenPostgres: ping: %w", err)
	}
	return &PostgresStore{sqlDB: sqlDB}, nil
}

// Close releases the underlying database connection pool.
func (s *PostgresStore) Close() error { return s.sqlDB.Close() }

// SQLDb returns the underlying *sql.DB for callers that need raw access
// (backup, migration runners, ad-hoc queries).
func (s *PostgresStore) SQLDb() *sql.DB { return s.sqlDB }

// WithTx runs fn inside a transaction. The transaction is committed if fn
// returns nil, otherwise rolled back. Postgres supports full transactional
// semantics (unlike SQLite's single-writer model), so concurrent callers
// are safe.
func (s *PostgresStore) WithTx(ctx context.Context, fn func(Store) error) error {
	tx, err := s.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("PostgresStore.WithTx: begin: %w", err)
	}
	if txErr := fn(s); txErr != nil {
		_ = tx.Rollback()
		return txErr
	}
	return tx.Commit()
}

// ── MessageStore (stubs) ────────────────────────────────────────────────────

func (s *PostgresStore) CreateMessage(channelID, userID int64, content string, replyTo *int64) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetMessage(id int64) (*db.Message, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetMessages(channelID, before int64, limit int) ([]db.MessageWithUser, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetMessagesForAPI(channelID, before int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) EditMessage(id, userID int64, content string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteMessage(id, userID int64, isMod bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) SearchMessages(query string, channelID *int64, limit int) ([]db.MessageSearchResult, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) SearchMessagesInChannels(query string, channelIDs []int64, limit int) ([]db.MessageSearchResult, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetPinnedMessages(channelID int64, requestingUserID int64) ([]db.MessageAPIResponse, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) SetMessagePinned(id int64, pinned bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) AddReaction(messageID, userID int64, emoji string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) RemoveReaction(messageID, userID int64, emoji string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetReactions(messageID int64) ([]db.ReactionCount, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateReadState(userID, channelID, lastReadMessageID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetChannelUnreadCounts(userID int64) (map[int64]db.ChannelUnread, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetLatestMessageID(channelID int64) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) LinkAttachmentsToMessage(messageID int64, attachmentIDs []string) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAttachmentsByMessageIDs(msgIDs []int64) (map[int64][]db.AttachmentInfo, error) {
	return nil, ErrPostgresNotImplemented
}

// ── ChannelStore (stubs) ────────────────────────────────────────────────────

func (s *PostgresStore) ListChannels() ([]db.Channel, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetChannel(id int64) (*db.Channel, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) CreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateChannel(id int64, name, topic string, slowMode int) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteChannel(id int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) SetChannelSlowMode(id int64, slowMode int) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) SetChannelVoiceMaxUsers(id int64, maxUsers int) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetChannelPermissions(channelID, roleID int64) (int64, int64, error) {
	return 0, 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAllChannelPermissionsForRole(roleID int64) (map[int64]db.ChannelOverride, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetChannelTypes(ids []int64) (map[int64]string, error) {
	return nil, ErrPostgresNotImplemented
}

// ── UserStore (stubs) ───────────────────────────────────────────────────────

func (s *PostgresStore) GetUserByID(id int64) (*db.User, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetUserByUsername(username string) (*db.User, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) CreateUser(username, passwordHash string, roleID int) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) CreateOwnerIfEmpty(username, passwordHash string, roleID int) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) CreateUserWithInvite(username, passwordHash string, roleID int, inviteCode string) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateUserProfile(userID int64, username string, avatar *string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateUserPassword(userID int64, newPasswordHash string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateUserStatus(id int64, status string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateUserTOTPSecret(id int64, secret *string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateUserRole(userID, roleID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) ResetAllUserStatuses() error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteAccount(ctx context.Context, userID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) ListMembers() ([]db.MemberSummary, error) {
	return nil, ErrPostgresNotImplemented
}

// ── SessionStore (stubs) ────────────────────────────────────────────────────

func (s *PostgresStore) CreateSession(userID int64, tokenHash, device, ip string) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetSessionByTokenHash(tokenHash string) (*db.Session, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetSessionWithBanStatus(tokenHash string) (*db.SessionWithBanStatus, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteSession(tokenHash string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteOtherSessions(userID, keepSessionID int64) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteExpiredSessions() error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteSessionByID(sessionID, userID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) TouchSession(tokenHash string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) ListUserSessions(userID int64) ([]db.Session, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) ForceLogoutUser(userID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetUserSessions(userID int64) ([]db.Session, error) {
	return nil, ErrPostgresNotImplemented
}

// ── RoleStore (stubs) ───────────────────────────────────────────────────────

func (s *PostgresStore) GetRoleByID(id int64) (*db.Role, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetRoleForUser(userID int64) (*db.Role, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetUserWithRole(userID int64) (*db.User, *db.Role, error) {
	return nil, nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) ListRoles() ([]*db.Role, error) {
	return nil, ErrPostgresNotImplemented
}

// ── InviteStore (stubs) ─────────────────────────────────────────────────────

func (s *PostgresStore) CreateInvite(createdBy int64, maxUses int, expiresAt *time.Time) (string, error) {
	return "", ErrPostgresNotImplemented
}

func (s *PostgresStore) GetInvite(code string) (*db.Invite, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) ListInvites() ([]*db.Invite, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) UseInviteAtomic(code string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) RevokeInvite(code string) error {
	return ErrPostgresNotImplemented
}

// ── VoiceStore (stubs) ──────────────────────────────────────────────────────

func (s *PostgresStore) JoinVoiceChannel(userID, channelID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) JoinVoiceChannelIfCapacity(userID, channelID int64, maxUsers int) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) LeaveVoiceChannel(userID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) LeaveVoiceChannelIfMatch(userID, expectedChannelID int64, expectedJoinedAt string) (bool, error) {
	return false, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetVoiceState(userID int64) (*db.VoiceState, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetChannelVoiceStates(channelID int64) ([]db.VoiceState, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAllVoiceStates() ([]db.VoiceState, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateVoiceMute(userID int64, muted bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateVoiceDeafen(userID int64, deafened bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) ClearVoiceState(userID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) ClearAllVoiceStates() error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) CountActiveCameras(channelID int64) (int, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateVoiceCamera(userID int64, camera bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) EnableCameraIfUnderLimit(userID, channelID int64, maxVideo int) (bool, error) {
	return false, ErrPostgresNotImplemented
}

func (s *PostgresStore) UpdateVoiceScreenshare(userID int64, screenshare bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) CountChannelVoiceUsers(channelID int64) (int, error) {
	return 0, ErrPostgresNotImplemented
}

// ── DMStore (stubs) ─────────────────────────────────────────────────────────

func (s *PostgresStore) GetOrCreateDMChannel(user1ID, user2ID int64) (*db.Channel, bool, error) {
	return nil, false, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetUserDMChannels(userID int64) ([]db.DMChannelInfo, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) OpenDM(userID, channelID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) CloseDM(userID, channelID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) IsDMParticipant(userID, channelID int64) (bool, error) {
	return false, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetDMParticipantIDs(channelID int64) ([]int64, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetDMRecipient(channelID, requestingUserID int64) (*db.User, error) {
	return nil, ErrPostgresNotImplemented
}

// ── BlockStore (stubs) ──────────────────────────────────────────────────────

func (s *PostgresStore) BlockUser(blockerID, blockedID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UnblockUser(blockerID, blockedID int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) IsBlocked(blockerID, blockedID int64) (bool, error) {
	return false, ErrPostgresNotImplemented
}

func (s *PostgresStore) IsEitherBlocked(userA, userB int64) (bool, error) {
	return false, ErrPostgresNotImplemented
}

func (s *PostgresStore) ListBlockedUsers(blockerID int64) ([]int64, error) {
	return nil, ErrPostgresNotImplemented
}

// ── AttachmentStore (stubs) ─────────────────────────────────────────────────

func (s *PostgresStore) CreateAttachment(id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAttachmentByID(id string) (*db.Attachment, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAttachmentWithChannel(id string) (*db.AttachmentAccess, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) DeleteOrphanedAttachments(cutoff string) ([]string, error) {
	return nil, ErrPostgresNotImplemented
}

// ── AdminStore (stubs) ──────────────────────────────────────────────────────

func (s *PostgresStore) UserCount() (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetServerStats() (*db.ServerStats, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) ListAllUsers(limit, offset int) ([]db.UserWithRole, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) BanUser(id int64, reason string, expires *time.Time) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UnbanUser(id int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) LogAudit(actorID int64, action, targetType string, targetID int64, detail string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAuditLog(limit, offset int) ([]db.AuditEntry, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) AdminCreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) AdminUpdateChannel(id int64, name, topic string, slowMode, position int, archived bool) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) AdminDeleteChannel(id int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) BackupTo(path string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) BackupToSafe(path, safeRoot string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) CountUsersWithoutTOTP() (int, error) {
	return 0, ErrPostgresNotImplemented
}

// ── SettingsStore (stubs) ───────────────────────────────────────────────────

func (s *PostgresStore) GetSetting(key string) (string, error) {
	return "", ErrPostgresNotImplemented
}

func (s *PostgresStore) SetSetting(key, value string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetAllSettings() (map[string]string, error) {
	return nil, ErrPostgresNotImplemented
}

// ── EventStore (stubs — Phase B Step 7) ─────────────────────────────────────

func (s *PostgresStore) PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetMaxEventSeq(ctx context.Context) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

// ── PluginStore (stubs — Phase C Step 9) ────────────────────────────────────

func (s *PostgresStore) InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error) {
	return 0, ErrPostgresNotImplemented
}

func (s *PostgresStore) EnablePlugin(ctx context.Context, id int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) DisablePlugin(ctx context.Context, id int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) UninstallPlugin(ctx context.Context, id int64) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) GetPlugin(ctx context.Context, id int64) (*db.PluginRow, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) GetPluginByName(ctx context.Context, name string) (*db.PluginRow, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) ListPlugins(ctx context.Context) ([]db.PluginRow, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) PluginKVGet(ctx context.Context, pluginID int64, key string) ([]byte, error) {
	return nil, ErrPostgresNotImplemented
}

func (s *PostgresStore) PluginKVSet(ctx context.Context, pluginID int64, key string, value []byte) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) PluginKVDelete(ctx context.Context, pluginID int64, key string) error {
	return ErrPostgresNotImplemented
}

func (s *PostgresStore) PluginKVScan(ctx context.Context, pluginID int64, prefix string, limit int) (map[string][]byte, error) {
	return nil, ErrPostgresNotImplemented
}

// Compile-time interface check — fails to compile if any Store method is
// missing a PostgresStore receiver.
var _ Store = (*PostgresStore)(nil)
