// Package store defines the database abstraction layer for OwnCord.
// The Store interface decouples services from the concrete database
// implementation, enabling SQLite (default) and future PostgreSQL support.
package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/owncord/server/db"
)

// Store is the top-level interface combining all domain-specific stores.
// Services accept Store instead of *db.DB, enabling swappable backends.
type Store interface {
	MessageStore
	ChannelStore
	UserStore
	SessionStore
	RoleStore
	InviteStore
	VoiceStore
	DMStore
	BlockStore
	AttachmentStore
	AdminStore
	SettingsStore
	EventStore
	PluginStore

	// Close releases the underlying database connection.
	Close() error

	// WithTx executes fn within a transaction. The transaction is committed
	// if fn returns nil, rolled back otherwise.
	WithTx(ctx context.Context, fn func(Store) error) error

	// Raw access for callers that need it (migration, backup, etc.).
	SQLDb() *sql.DB
}

// MessageStore handles message CRUD, reactions, search, and read state.
type MessageStore interface {
	CreateMessage(channelID, userID int64, content string, replyTo *int64) (int64, error)
	GetMessage(id int64) (*db.Message, error)
	GetMessages(channelID, before int64, limit int) ([]db.MessageWithUser, error)
	GetMessagesForAPI(channelID, before int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	EditMessage(id, userID int64, content string) error
	DeleteMessage(id, userID int64, isMod bool) error
	SearchMessages(query string, channelID *int64, limit int) ([]db.MessageSearchResult, error)
	SearchMessagesInChannels(query string, channelIDs []int64, limit int) ([]db.MessageSearchResult, error)
	GetPinnedMessages(channelID int64, requestingUserID int64) ([]db.MessageAPIResponse, error)
	SetMessagePinned(id int64, pinned bool) error
	AddReaction(messageID, userID int64, emoji string) error
	RemoveReaction(messageID, userID int64, emoji string) error
	GetReactions(messageID int64) ([]db.ReactionCount, error)
	UpdateReadState(userID, channelID, lastReadMessageID int64) error
	GetChannelUnreadCounts(userID int64) (map[int64]db.ChannelUnread, error)
	GetLatestMessageID(channelID int64) (int64, error)
	LinkAttachmentsToMessage(messageID, uploaderID int64, attachmentIDs []string) (int64, error)
	GetAttachmentsByMessageIDs(msgIDs []int64) (map[int64][]db.AttachmentInfo, error)
}

// ChannelStore handles channel CRUD and permission overrides.
type ChannelStore interface {
	ListChannels() ([]db.Channel, error)
	GetChannel(id int64) (*db.Channel, error)
	CreateChannel(name, chanType, category, topic string, position int) (int64, error)
	UpdateChannel(id int64, name, topic string, slowMode int) error
	DeleteChannel(id int64) error
	SetChannelSlowMode(id int64, slowMode int) error
	SetChannelVoiceMaxUsers(id int64, maxUsers int) error
	GetChannelPermissions(channelID, roleID int64) (allow, deny int64, err error)
	GetAllChannelPermissionsForRole(roleID int64) (map[int64]db.ChannelOverride, error)
	GetChannelTypes(ids []int64) (map[int64]string, error)
}

// UserStore handles user lookup and profile operations.
type UserStore interface {
	GetUserByID(id int64) (*db.User, error)
	GetUserByUsername(username string) (*db.User, error)
	CreateUser(username, passwordHash string, roleID int) (int64, error)
	CreateOwnerIfEmpty(username, passwordHash string, roleID int) (int64, error)
	CreateUserWithInvite(username, passwordHash string, roleID int, inviteCode string) (int64, error)
	UpdateUserProfile(userID int64, username string, avatar *string) error
	UpdateUserPassword(userID int64, newPasswordHash string) error
	UpdateUserStatus(id int64, status string) error
	UpdateUserTOTPSecret(id int64, secret *string) error
	UpdateUserRole(userID, roleID int64) error
	ResetAllUserStatuses() error
	DeleteAccount(ctx context.Context, userID int64) error
	ListMembers() ([]db.MemberSummary, error)
}

// SessionStore handles authentication session management.
type SessionStore interface {
	CreateSession(userID int64, tokenHash, device, ip string) (int64, error)
	GetSessionByTokenHash(tokenHash string) (*db.Session, error)
	GetSessionWithBanStatus(tokenHash string) (*db.SessionWithBanStatus, error)
	DeleteSession(tokenHash string) error
	DeleteOtherSessions(userID, keepSessionID int64) (int64, error)
	DeleteExpiredSessions() error
	DeleteSessionByID(sessionID, userID int64) error
	TouchSession(tokenHash string) error
	ListUserSessions(userID int64) ([]db.Session, error)
	ForceLogoutUser(userID int64) error
	GetUserSessions(userID int64) ([]db.Session, error)
}

// RoleStore handles role lookups.
type RoleStore interface {
	GetRoleByID(id int64) (*db.Role, error)
	GetRoleForUser(userID int64) (*db.Role, error)
	GetUserWithRole(userID int64) (*db.User, *db.Role, error)
	ListRoles() ([]*db.Role, error)
}

// InviteStore handles invite management.
type InviteStore interface {
	CreateInvite(createdBy int64, maxUses int, expiresAt *time.Time) (string, error)
	GetInvite(code string) (*db.Invite, error)
	ListInvites() ([]*db.Invite, error)
	UseInviteAtomic(code string) error
	RevokeInvite(code string) error
}

// VoiceStore handles voice state management.
type VoiceStore interface {
	JoinVoiceChannel(userID, channelID int64) error
	JoinVoiceChannelIfCapacity(userID, channelID int64, maxUsers int) error
	LeaveVoiceChannel(userID int64) error
	LeaveVoiceChannelIfMatch(userID, expectedChannelID int64, expectedJoinedAt string) (bool, error)
	GetVoiceState(userID int64) (*db.VoiceState, error)
	GetChannelVoiceStates(channelID int64) ([]db.VoiceState, error)
	GetAllVoiceStates() ([]db.VoiceState, error)
	UpdateVoiceMute(userID int64, muted bool) error
	UpdateVoiceDeafen(userID int64, deafened bool) error
	ClearVoiceState(userID int64) error
	ClearAllVoiceStates() error
	CountActiveCameras(channelID int64) (int, error)
	UpdateVoiceCamera(userID int64, camera bool) error
	EnableCameraIfUnderLimit(userID, channelID int64, maxVideo int) (bool, error)
	UpdateVoiceScreenshare(userID int64, screenshare bool) error
	CountChannelVoiceUsers(channelID int64) (int, error)
}

// DMStore handles direct message channels.
type DMStore interface {
	GetOrCreateDMChannel(user1ID, user2ID int64) (*db.Channel, bool, error)
	GetUserDMChannels(userID int64) ([]db.DMChannelInfo, error)
	OpenDM(userID, channelID int64) error
	CloseDM(userID, channelID int64) error
	IsDMParticipant(userID, channelID int64) (bool, error)
	GetDMParticipantIDs(channelID int64) ([]int64, error)
	GetDMRecipient(channelID, requestingUserID int64) (*db.User, error)
}

// BlockStore handles user blocks.
type BlockStore interface {
	BlockUser(blockerID, blockedID int64) error
	UnblockUser(blockerID, blockedID int64) error
	IsBlocked(blockerID, blockedID int64) (bool, error)
	IsEitherBlocked(userA, userB int64) (bool, error)
	ListBlockedUsers(blockerID int64) ([]int64, error)
}

// AttachmentStore handles file attachment metadata.
type AttachmentStore interface {
	CreateAttachment(id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error
	GetAttachmentByID(id string) (*db.Attachment, error)
	GetAttachmentWithChannel(id string) (*db.AttachmentAccess, error)
	DeleteOrphanedAttachments(cutoff string) ([]string, error)
}

// AdminStore handles admin operations.
type AdminStore interface {
	UserCount() (int64, error)
	GetServerStats() (*db.ServerStats, error)
	ListAllUsers(limit, offset int) ([]db.UserWithRole, error)
	BanUser(id int64, reason string, expires *time.Time) error
	UnbanUser(id int64) error
	LogAudit(actorID int64, action, targetType string, targetID int64, detail string) error
	GetAuditLog(limit, offset int) ([]db.AuditEntry, error)
	AdminCreateChannel(name, chanType, category, topic string, position int) (int64, error)
	AdminUpdateChannel(id int64, name, topic string, slowMode, position int, archived bool) error
	AdminDeleteChannel(id int64) error
	BackupTo(path string) error
	BackupToSafe(path, safeRoot string) error
	CountUsersWithoutTOTP() (int, error)
}

// SettingsStore handles server settings.
type SettingsStore interface {
	GetSetting(key string) (string, error)
	SetSetting(key, value string) error
	GetAllSettings() (map[string]string, error)
}

// EventStore persists broadcast events for cold-replay during reconnection
// when the in-memory ring buffer no longer covers the client's last_seq.
//
// Phase B Step 7 — Event Persistence Layer.
type EventStore interface {
	// PersistEvent appends an event with the hub-assigned seq. seq must be
	// the same monotonic counter the wrapped payload exposes to clients so
	// that cold-replay queries by seq return rows whose payload seq matches
	// the row seq. channelID == 0 means the event was a global broadcast.
	// Implementations should be tolerant of out-of-order seq insertion (e.g.
	// they SHOULD NOT rely on AUTOINCREMENT semantics).
	PersistEvent(ctx context.Context, seq int64, eventType string, channelID int64, payload []byte) error

	// GetEventsSince returns up to limit events with seq > afterSeq, ordered
	// by seq ascending. Used as a fallback after the ring buffer misses.
	GetEventsSince(ctx context.Context, afterSeq int64, limit int) ([]db.PersistedEvent, error)

	// GetEventsSinceForChannels returns up to limit events with seq > afterSeq
	// whose channel_id is in channelIDs OR is 0 (global broadcasts), ordered by
	// seq ascending. Mirrors EventRingBuffer.EventsSinceFiltered.
	GetEventsSinceForChannels(ctx context.Context, afterSeq int64, channelIDs []int64, limit int) ([]db.PersistedEvent, error)

	// PruneEventsOlderThan deletes events with created_at < cutoff. Returns the
	// number of deleted rows. Called periodically by the pruner goroutine.
	PruneEventsOlderThan(ctx context.Context, cutoff time.Time) (int64, error)

	// GetMaxEventSeq returns the largest seq in the events table, or 0 if the
	// table is empty. Used at startup to seed the hub's in-memory monotonic
	// counter so wrapped-payload seqs stay aligned with row seqs across
	// restarts. Returns 0 (without error) when the table is empty.
	GetMaxEventSeq(ctx context.Context) (int64, error)
}

// PluginStore manages installed plugins and per-plugin KV namespaces.
//
// Phase C Step 9 — Wazero Plugin Runtime.
type PluginStore interface {
	InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error)
	EnablePlugin(ctx context.Context, id int64) error
	DisablePlugin(ctx context.Context, id int64) error
	UninstallPlugin(ctx context.Context, id int64) error
	GetPlugin(ctx context.Context, id int64) (*db.PluginRow, error)
	GetPluginByName(ctx context.Context, name string) (*db.PluginRow, error)
	ListPlugins(ctx context.Context) ([]db.PluginRow, error)

	PluginKVGet(ctx context.Context, pluginID int64, key string) ([]byte, error)
	PluginKVSet(ctx context.Context, pluginID int64, key string, value []byte) error
	PluginKVDelete(ctx context.Context, pluginID int64, key string) error
	PluginKVScan(ctx context.Context, pluginID int64, prefix string, limit int) (map[string][]byte, error)
}
