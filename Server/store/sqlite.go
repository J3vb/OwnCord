package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/owncord/server/db"
)

// SQLiteStore wraps *db.DB to implement the Store interface.
// It delegates all operations to the existing db package methods.
type SQLiteStore struct {
	db *db.DB
}

// NewSQLiteStore creates a SQLiteStore from an existing *db.DB.
func NewSQLiteStore(database *db.DB) *SQLiteStore {
	return &SQLiteStore{db: database}
}

// Open opens a SQLite database at path and returns a ready-to-use Store.
func Open(path string) (*SQLiteStore, error) {
	database, err := db.Open(path)
	if err != nil {
		return nil, err
	}
	return &SQLiteStore{db: database}, nil
}

// DB returns the underlying *db.DB for callers that need raw access.
func (s *SQLiteStore) DB() *db.DB { return s.db }

// Close releases the underlying database connection.
func (s *SQLiteStore) Close() error { return s.db.Close() }

// SQLDb returns the underlying *sql.DB.
func (s *SQLiteStore) SQLDb() *sql.DB { return s.db.SQLDb() }

// WithTx executes fn within a transaction. For SQLite, all writes are
// serialized through a single connection (MaxOpenConns=1), so the transaction
// is started and committed on the same underlying connection that fn's
// store calls use.
//
// TODO: implement properly with a transaction-scoped Store wrapper when
// services need multi-statement transactions.
func (s *SQLiteStore) WithTx(ctx context.Context, fn func(Store) error) error {
	// SQLite serializes all writes through one connection, so starting a
	// transaction and calling fn(s) effectively wraps fn's DB calls in
	// that transaction — provided MaxOpenConns remains 1.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if txErr := fn(s); txErr != nil {
		_ = tx.Rollback()
		return txErr
	}
	return tx.Commit()
}

// ── MessageStore ────────────────────────────────────────────────────────────

func (s *SQLiteStore) CreateMessage(channelID, userID int64, content string, replyTo *int64) (int64, error) {
	return s.db.CreateMessage(channelID, userID, content, replyTo)
}
func (s *SQLiteStore) GetMessage(id int64) (*db.Message, error) {
	return s.db.GetMessage(id)
}
func (s *SQLiteStore) GetMessages(channelID, before int64, limit int) ([]db.MessageWithUser, error) {
	return s.db.GetMessages(channelID, before, limit)
}
func (s *SQLiteStore) GetMessagesForAPI(channelID, before int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error) {
	return s.db.GetMessagesForAPI(channelID, before, limit, requestingUserID)
}
func (s *SQLiteStore) EditMessage(id, userID int64, content string) error {
	return s.db.EditMessage(id, userID, content)
}
func (s *SQLiteStore) DeleteMessage(id, userID int64, isMod bool) error {
	return s.db.DeleteMessage(id, userID, isMod)
}
func (s *SQLiteStore) SearchMessages(query string, channelID *int64, limit int) ([]db.MessageSearchResult, error) {
	return s.db.SearchMessages(query, channelID, limit)
}
func (s *SQLiteStore) SearchMessagesInChannels(query string, channelIDs []int64, limit int) ([]db.MessageSearchResult, error) {
	return s.db.SearchMessagesInChannels(query, channelIDs, limit)
}
func (s *SQLiteStore) GetPinnedMessages(channelID int64, requestingUserID int64) ([]db.MessageAPIResponse, error) {
	return s.db.GetPinnedMessages(channelID, requestingUserID)
}
func (s *SQLiteStore) SetMessagePinned(id int64, pinned bool) error {
	return s.db.SetMessagePinned(id, pinned)
}
func (s *SQLiteStore) AddReaction(messageID, userID int64, emoji string) error {
	return s.db.AddReaction(messageID, userID, emoji)
}
func (s *SQLiteStore) RemoveReaction(messageID, userID int64, emoji string) error {
	return s.db.RemoveReaction(messageID, userID, emoji)
}
func (s *SQLiteStore) GetReactions(messageID int64) ([]db.ReactionCount, error) {
	return s.db.GetReactions(messageID)
}
func (s *SQLiteStore) UpdateReadState(userID, channelID, lastReadMessageID int64) error {
	return s.db.UpdateReadState(userID, channelID, lastReadMessageID)
}
func (s *SQLiteStore) GetChannelUnreadCounts(userID int64) (map[int64]db.ChannelUnread, error) {
	return s.db.GetChannelUnreadCounts(userID)
}
func (s *SQLiteStore) GetLatestMessageID(channelID int64) (int64, error) {
	return s.db.GetLatestMessageID(channelID)
}
func (s *SQLiteStore) LinkAttachmentsToMessage(messageID, uploaderID int64, attachmentIDs []string) (int64, error) {
	return s.db.LinkAttachmentsToMessage(messageID, uploaderID, attachmentIDs)
}
func (s *SQLiteStore) GetAttachmentsByMessageIDs(msgIDs []int64) (map[int64][]db.AttachmentInfo, error) {
	return s.db.GetAttachmentsByMessageIDs(msgIDs)
}

// ── ChannelStore ────────────────────────────────────────────────────────────

func (s *SQLiteStore) ListChannels() ([]db.Channel, error)      { return s.db.ListChannels() }
func (s *SQLiteStore) GetChannel(id int64) (*db.Channel, error) { return s.db.GetChannel(id) }
func (s *SQLiteStore) CreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	return s.db.CreateChannel(name, chanType, category, topic, position)
}
func (s *SQLiteStore) UpdateChannel(id int64, name, topic string, slowMode int) error {
	return s.db.UpdateChannel(id, name, topic, slowMode)
}
func (s *SQLiteStore) DeleteChannel(id int64) error { return s.db.DeleteChannel(id) }
func (s *SQLiteStore) SetChannelSlowMode(id int64, sm int) error {
	return s.db.SetChannelSlowMode(id, sm)
}
func (s *SQLiteStore) SetChannelVoiceMaxUsers(id int64, max int) error {
	return s.db.SetChannelVoiceMaxUsers(id, max)
}
func (s *SQLiteStore) GetChannelPermissions(channelID, roleID int64) (int64, int64, error) {
	return s.db.GetChannelPermissions(channelID, roleID)
}
func (s *SQLiteStore) GetAllChannelPermissionsForRole(roleID int64) (map[int64]db.ChannelOverride, error) {
	return s.db.GetAllChannelPermissionsForRole(roleID)
}
func (s *SQLiteStore) GetChannelTypes(ids []int64) (map[int64]string, error) {
	return s.db.GetChannelTypes(ids)
}

// ── UserStore ───────────────────────────────────────────────────────────────

func (s *SQLiteStore) GetUserByID(id int64) (*db.User, error) { return s.db.GetUserByID(id) }
func (s *SQLiteStore) GetUserByUsername(username string) (*db.User, error) {
	return s.db.GetUserByUsername(username)
}
func (s *SQLiteStore) CreateUser(username, passwordHash string, roleID int) (int64, error) {
	return s.db.CreateUser(username, passwordHash, roleID)
}
func (s *SQLiteStore) CreateOwnerIfEmpty(username, passwordHash string, roleID int) (int64, error) {
	return s.db.CreateOwnerIfEmpty(username, passwordHash, roleID)
}
func (s *SQLiteStore) CreateUserWithInvite(username, passwordHash string, roleID int, inviteCode string) (int64, error) {
	return s.db.CreateUserWithInvite(username, passwordHash, roleID, inviteCode)
}
func (s *SQLiteStore) UpdateUserProfile(userID int64, username string, avatar *string) error {
	return s.db.UpdateUserProfile(userID, username, avatar)
}
func (s *SQLiteStore) UpdateUserPassword(userID int64, hash string) error {
	return s.db.UpdateUserPassword(userID, hash)
}
func (s *SQLiteStore) UpdateUserStatus(id int64, status string) error {
	return s.db.UpdateUserStatus(id, status)
}
func (s *SQLiteStore) UpdateUserTOTPSecret(id int64, secret *string) error {
	return s.db.UpdateUserTOTPSecret(id, secret)
}
func (s *SQLiteStore) UpdateUserRole(userID, roleID int64) error {
	return s.db.UpdateUserRole(userID, roleID)
}
func (s *SQLiteStore) ResetAllUserStatuses() error { return s.db.ResetAllUserStatuses() }
func (s *SQLiteStore) DeleteAccount(ctx context.Context, userID int64) error {
	return s.db.DeleteAccount(ctx, userID)
}
func (s *SQLiteStore) ListMembers() ([]db.MemberSummary, error) { return s.db.ListMembers() }

// ── SessionStore ────────────────────────────────────────────────────────────

func (s *SQLiteStore) CreateSession(userID int64, tokenHash, device, ip string) (int64, error) {
	return s.db.CreateSession(userID, tokenHash, device, ip)
}
func (s *SQLiteStore) GetSessionByTokenHash(tokenHash string) (*db.Session, error) {
	return s.db.GetSessionByTokenHash(tokenHash)
}
func (s *SQLiteStore) GetSessionWithBanStatus(tokenHash string) (*db.SessionWithBanStatus, error) {
	return s.db.GetSessionWithBanStatus(tokenHash)
}
func (s *SQLiteStore) DeleteSession(tokenHash string) error { return s.db.DeleteSession(tokenHash) }
func (s *SQLiteStore) DeleteOtherSessions(userID, keepSessionID int64) (int64, error) {
	return s.db.DeleteOtherSessions(userID, keepSessionID)
}
func (s *SQLiteStore) DeleteExpiredSessions() error { return s.db.DeleteExpiredSessions() }
func (s *SQLiteStore) DeleteSessionByID(sid, uid int64) error {
	return s.db.DeleteSessionByID(sid, uid)
}
func (s *SQLiteStore) TouchSession(tokenHash string) error { return s.db.TouchSession(tokenHash) }
func (s *SQLiteStore) ListUserSessions(userID int64) ([]db.Session, error) {
	return s.db.ListUserSessions(userID)
}
func (s *SQLiteStore) ForceLogoutUser(userID int64) error { return s.db.ForceLogoutUser(userID) }
func (s *SQLiteStore) GetUserSessions(userID int64) ([]db.Session, error) {
	return s.db.GetUserSessions(userID)
}

// ── RoleStore ───────────────────────────────────────────────────────────────

func (s *SQLiteStore) GetRoleByID(id int64) (*db.Role, error) { return s.db.GetRoleByID(id) }
func (s *SQLiteStore) GetRoleForUser(userID int64) (*db.Role, error) {
	return s.db.GetRoleForUser(userID)
}
func (s *SQLiteStore) GetUserWithRole(userID int64) (*db.User, *db.Role, error) {
	return s.db.GetUserWithRole(userID)
}
func (s *SQLiteStore) ListRoles() ([]*db.Role, error) { return s.db.ListRoles() }

// ── InviteStore ─────────────────────────────────────────────────────────────

func (s *SQLiteStore) CreateInvite(createdBy int64, maxUses int, expiresAt *time.Time) (string, error) {
	return s.db.CreateInvite(createdBy, maxUses, expiresAt)
}
func (s *SQLiteStore) GetInvite(code string) (*db.Invite, error) { return s.db.GetInvite(code) }
func (s *SQLiteStore) ListInvites() ([]*db.Invite, error)        { return s.db.ListInvites() }
func (s *SQLiteStore) UseInviteAtomic(code string) error         { return s.db.UseInviteAtomic(code) }
func (s *SQLiteStore) RevokeInvite(code string) error            { return s.db.RevokeInvite(code) }

// ── VoiceStore ──────────────────────────────────────────────────────────────

func (s *SQLiteStore) JoinVoiceChannel(userID, channelID int64) error {
	return s.db.JoinVoiceChannel(userID, channelID)
}
func (s *SQLiteStore) JoinVoiceChannelIfCapacity(userID, channelID int64, maxUsers int) error {
	return s.db.JoinVoiceChannelIfCapacity(userID, channelID, maxUsers)
}
func (s *SQLiteStore) LeaveVoiceChannel(userID int64) error { return s.db.LeaveVoiceChannel(userID) }
func (s *SQLiteStore) LeaveVoiceChannelIfMatch(userID, expectedChannelID int64, expectedJoinedAt string) (bool, error) {
	return s.db.LeaveVoiceChannelIfMatch(userID, expectedChannelID, expectedJoinedAt)
}
func (s *SQLiteStore) GetVoiceState(userID int64) (*db.VoiceState, error) {
	return s.db.GetVoiceState(userID)
}
func (s *SQLiteStore) GetChannelVoiceStates(channelID int64) ([]db.VoiceState, error) {
	return s.db.GetChannelVoiceStates(channelID)
}
func (s *SQLiteStore) GetAllVoiceStates() ([]db.VoiceState, error) { return s.db.GetAllVoiceStates() }
func (s *SQLiteStore) UpdateVoiceMute(userID int64, m bool) error {
	return s.db.UpdateVoiceMute(userID, m)
}
func (s *SQLiteStore) UpdateVoiceDeafen(userID int64, d bool) error {
	return s.db.UpdateVoiceDeafen(userID, d)
}
func (s *SQLiteStore) ClearVoiceState(userID int64) error { return s.db.ClearVoiceState(userID) }
func (s *SQLiteStore) ClearAllVoiceStates() error         { return s.db.ClearAllVoiceStates() }
func (s *SQLiteStore) CountActiveCameras(channelID int64) (int, error) {
	return s.db.CountActiveCameras(channelID)
}
func (s *SQLiteStore) UpdateVoiceCamera(userID int64, c bool) error {
	return s.db.UpdateVoiceCamera(userID, c)
}
func (s *SQLiteStore) EnableCameraIfUnderLimit(userID, channelID int64, maxVideo int) (bool, error) {
	return s.db.EnableCameraIfUnderLimit(userID, channelID, maxVideo)
}
func (s *SQLiteStore) UpdateVoiceScreenshare(userID int64, ss bool) error {
	return s.db.UpdateVoiceScreenshare(userID, ss)
}
func (s *SQLiteStore) CountChannelVoiceUsers(channelID int64) (int, error) {
	return s.db.CountChannelVoiceUsers(channelID)
}

// ── DMStore ─────────────────────────────────────────────────────────────────

func (s *SQLiteStore) GetOrCreateDMChannel(user1ID, user2ID int64) (*db.Channel, bool, error) {
	return s.db.GetOrCreateDMChannel(user1ID, user2ID)
}
func (s *SQLiteStore) GetUserDMChannels(userID int64) ([]db.DMChannelInfo, error) {
	return s.db.GetUserDMChannels(userID)
}
func (s *SQLiteStore) OpenDM(userID, channelID int64) error  { return s.db.OpenDM(userID, channelID) }
func (s *SQLiteStore) CloseDM(userID, channelID int64) error { return s.db.CloseDM(userID, channelID) }
func (s *SQLiteStore) IsDMParticipant(userID, channelID int64) (bool, error) {
	return s.db.IsDMParticipant(userID, channelID)
}
func (s *SQLiteStore) GetDMParticipantIDs(channelID int64) ([]int64, error) {
	return s.db.GetDMParticipantIDs(channelID)
}
func (s *SQLiteStore) GetDMRecipient(channelID, requestingUserID int64) (*db.User, error) {
	return s.db.GetDMRecipient(channelID, requestingUserID)
}

// ── BlockStore ──────────────────────────────────────────────────────────────

func (s *SQLiteStore) BlockUser(blockerID, blockedID int64) error {
	return s.db.BlockUser(blockerID, blockedID)
}
func (s *SQLiteStore) UnblockUser(blockerID, blockedID int64) error {
	return s.db.UnblockUser(blockerID, blockedID)
}
func (s *SQLiteStore) IsBlocked(blockerID, blockedID int64) (bool, error) {
	return s.db.IsBlocked(blockerID, blockedID)
}
func (s *SQLiteStore) IsEitherBlocked(userA, userB int64) (bool, error) {
	return s.db.IsEitherBlocked(userA, userB)
}
func (s *SQLiteStore) ListBlockedUsers(blockerID int64) ([]int64, error) {
	return s.db.ListBlockedUsers(blockerID)
}

// ── AttachmentStore ─────────────────────────────────────────────────────────

func (s *SQLiteStore) CreateAttachment(id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error {
	return s.db.CreateAttachment(id, uploaderID, filename, storedAs, mimeType, size, width, height)
}
func (s *SQLiteStore) GetAttachmentByID(id string) (*db.Attachment, error) {
	return s.db.GetAttachmentByID(id)
}
func (s *SQLiteStore) GetAttachmentWithChannel(id string) (*db.AttachmentAccess, error) {
	return s.db.GetAttachmentWithChannel(id)
}
func (s *SQLiteStore) DeleteOrphanedAttachments(cutoff string) ([]string, error) {
	return s.db.DeleteOrphanedAttachments(cutoff)
}

// ── AdminStore ──────────────────────────────────────────────────────────────

func (s *SQLiteStore) UserCount() (int64, error)                { return s.db.UserCount() }
func (s *SQLiteStore) GetServerStats() (*db.ServerStats, error) { return s.db.GetServerStats() }
func (s *SQLiteStore) ListAllUsers(limit, offset int) ([]db.UserWithRole, error) {
	return s.db.ListAllUsers(limit, offset)
}
func (s *SQLiteStore) BanUser(id int64, reason string, expires *time.Time) error {
	return s.db.BanUser(id, reason, expires)
}
func (s *SQLiteStore) UnbanUser(id int64) error { return s.db.UnbanUser(id) }
func (s *SQLiteStore) LogAudit(actorID int64, action, targetType string, targetID int64, detail string) error {
	return s.db.LogAudit(actorID, action, targetType, targetID, detail)
}
func (s *SQLiteStore) GetAuditLog(limit, offset int) ([]db.AuditEntry, error) {
	return s.db.GetAuditLog(limit, offset)
}
func (s *SQLiteStore) AdminCreateChannel(name, chanType, category, topic string, position int) (int64, error) {
	return s.db.AdminCreateChannel(name, chanType, category, topic, position)
}
func (s *SQLiteStore) AdminUpdateChannel(id int64, name, topic string, slowMode, position int, archived bool) error {
	return s.db.AdminUpdateChannel(id, name, topic, slowMode, position, archived)
}
func (s *SQLiteStore) AdminDeleteChannel(id int64) error { return s.db.AdminDeleteChannel(id) }
func (s *SQLiteStore) BackupTo(path string) error        { return s.db.BackupTo(path) }
func (s *SQLiteStore) BackupToSafe(path, safeRoot string) error {
	return s.db.BackupToSafe(path, safeRoot)
}
func (s *SQLiteStore) CountUsersWithoutTOTP() (int, error) { return s.db.CountUsersWithoutTOTP() }

// ── SettingsStore ───────────────────────────────────────────────────────────

func (s *SQLiteStore) GetSetting(key string) (string, error)      { return s.db.GetSetting(key) }
func (s *SQLiteStore) SetSetting(key, value string) error         { return s.db.SetSetting(key, value) }
func (s *SQLiteStore) GetAllSettings() (map[string]string, error) { return s.db.GetAllSettings() }

// Compile-time interface check.
var _ Store = (*SQLiteStore)(nil)
