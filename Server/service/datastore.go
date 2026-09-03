package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// Store is the data-access surface the service layer depends on. It is the
// set of *db.DB methods the services call — no event/plugin/transaction
// methods, which belong to other layers. *db.DB satisfies this interface
// directly (D3 removed the former store package's pass-through wrapper), and
// tests inject fakes that embed a real in-memory *db.DB and override the one
// method they need to exercise an error path.
//
// permissions.NewChecker takes its own narrower interface (permissions.DB),
// which *db.DB and this Store both satisfy.
type Store interface {
	// ── Second-factor state (B4-3) ──
	// The durable backend behind the auth service's partial-auth, pending
	// enrolment and used-code stores, plus the recovery-code rows; stdlib
	// types only, because auth cannot import db back.
	auth.SecondFactorPersister
	ReplaceRecoveryCodes(ctx context.Context, userID int64, codeHashes []string) error
	ListUnusedRecoveryCodes(ctx context.Context, userID int64) (ids []int64, hashes []string, err error)
	MarkRecoveryCodeUsed(ctx context.Context, id int64) (consumed bool, err error)
	CountUnusedRecoveryCodes(ctx context.Context, userID int64) (int, error)
	DeleteRecoveryCodes(ctx context.Context, userID int64) error

	// ── Messages / reactions / read-state ──
	CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (int64, error)
	CreateMessageReturning(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (*db.Message, error)
	CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, mentionsEveryone bool) (*db.Message, error)
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetMessages(ctx context.Context, channelID, before int64, limit int) ([]db.MessageWithUser, error)
	GetMessagesForAPI(ctx context.Context, channelID, before int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	GetMessagesAroundForAPI(ctx context.Context, channelID, centerID int64, beforeCount, afterCount int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	EditMessage(ctx context.Context, id, userID int64, content string) (*db.Message, error)
	DeleteMessage(ctx context.Context, id, userID int64, isMod bool) error
	PurgeChannelMessages(ctx context.Context, channelID, before int64, limit int) ([]int64, error)
	SearchMessages(ctx context.Context, query string, channelID *int64, limit int) ([]db.MessageSearchResult, error)
	SearchMessagesInChannels(ctx context.Context, query string, channelIDs []int64, limit int) ([]db.MessageSearchResult, error)
	GetPinnedMessages(ctx context.Context, channelID int64, requestingUserID int64) ([]db.MessageAPIResponse, error)
	SetMessagePinned(ctx context.Context, id int64, pinned bool) error
	AddReaction(ctx context.Context, messageID, userID int64, emoji string) error
	RemoveReaction(ctx context.Context, messageID, userID int64, emoji string) error
	GetReactions(ctx context.Context, messageID int64) ([]db.ReactionCount, error)
	GetReactionUsers(ctx context.Context, messageID int64, emoji string, limit int) ([]db.ReactionUser, error)
	UpdateReadState(ctx context.Context, userID, channelID, lastReadMessageID int64) error
	// MarkChannelReadAtLatest is the mark-read that computes its own
	// watermark; UpdateReadState is for a caller that already holds the
	// exact id it means (OC-0323).
	MarkChannelReadAtLatest(ctx context.Context, userID, channelID int64) error
	GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error)
	GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]db.ChannelUnread, error)

	// ── Mentions ──
	ReplaceMessageMentions(ctx context.Context, messageID int64, mentionedUserIDs []int64, mentionsEveryone bool) error
	GetMentionsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]int64, error)
	IncrementMentionCounts(ctx context.Context, channelID, msgID int64, userIDs []int64) error
	DecrementMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) error
	GetUserIDsByUsernames(ctx context.Context, usernames []string) (map[string]int64, error)
	ListMentionTargetsByRoles(ctx context.Context, roleIDs []int64) ([]db.MentionTarget, error)
	ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error)
	GetChannelOverrides(ctx context.Context, channelID int64) (map[int64]db.ChannelOverride, error)
	GetChannelUserOverrides(ctx context.Context, channelID int64) (map[int64]db.ChannelOverride, error)
	ListMentionTargetsByUserIDs(ctx context.Context, userIDs []int64) ([]db.MentionTarget, error)
	GetLatestMessageID(ctx context.Context, channelID int64) (int64, error)
	LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) (int64, error)
	GetAttachmentsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]db.AttachmentInfo, error)

	// ── Channels ──
	ListChannels(ctx context.Context) ([]db.Channel, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	CreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	UpdateChannel(ctx context.Context, id int64, name, topic string, slowMode int) error
	DeleteChannel(ctx context.Context, id int64) error
	SetChannelSlowMode(ctx context.Context, id int64, slowMode int) error
	SetChannelVoiceMaxUsers(ctx context.Context, id int64, maxUsers int) error
	// GetChannelPermissions / GetUserChannelPermissions are the two single-row
	// override lookups permissions.DB requires (Store is passed straight to
	// permissions.NewChecker).
	GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error)
	GetUserChannelPermissions(ctx context.Context, channelID, userID int64) (allow, deny int64, err error)
	// Override CRUD for the channel family's permission layer (B3-8 part 2):
	// the full role/user override listings the matrix editor renders, and the
	// writes/clears the service gates.
	ListChannelRoleOverrides(ctx context.Context, channelID int64) ([]db.ChannelRoleOverride, error)
	ListChannelUserOverrides(ctx context.Context, channelID int64) ([]db.ChannelUserOverride, error)
	UpsertChannelOverride(ctx context.Context, channelID, roleID, allow, deny int64) error
	DeleteChannelOverride(ctx context.Context, channelID, roleID int64) error
	UpsertChannelUserOverride(ctx context.Context, channelID, userID, allow, deny int64) error
	DeleteChannelUserOverride(ctx context.Context, channelID, userID int64) error
	GetAllChannelPermissionsForRole(ctx context.Context, roleID int64) (map[int64]db.ChannelOverride, error)
	// GetChannelOverridesFor merges the role and per-user override layers for
	// one member in two batch queries — the single fetch behind every
	// "what can this member do here" site, and the reason no site pays an N+1
	// for the second layer.
	GetChannelOverridesFor(ctx context.Context, roleID, userID int64) (map[int64]db.ChannelOverride, error)
	GetChannelTypes(ctx context.Context, ids []int64) (map[int64]string, error)

	// ── Users ──
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	GetOwnerUser(ctx context.Context) (*db.User, error)

	// ── API tokens ──
	CreateAPIToken(ctx context.Context, userID int64, tokenHash, label string, expiresAt *time.Time) (int64, error)
	ListAPITokens(ctx context.Context) ([]db.APITokenListItem, error)
	RevokeAPIToken(ctx context.Context, id int64) (int64, error)
	RevokeAPITokenByLabel(ctx context.Context, label string) (int64, error)
	CreateUser(ctx context.Context, username, passwordHash string, roleID int) (int64, error)
	CreateOwnerIfEmpty(ctx context.Context, username, passwordHash string, roleID int) (int64, error)
	CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode, sessionTokenHash, device, ip string) (int64, error)
	CreateUserWithSession(ctx context.Context, username, passwordHash string, roleID int, sessionTokenHash, device, ip string) (int64, error)
	// Recovery kit (B4-5).
	UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error
	GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error)
	RedeemRecoveryKit(ctx context.Context, userID int64, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Owner-issued recovery credential (B4-6).
	UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error
	GetRecoveryAssist(ctx context.Context, userID int64) (*db.RecoveryAssist, error)
	RedeemRecoveryAssist(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Approval-mode registration (B4-1).
	CreatePendingUser(ctx context.Context, username, passwordHash string, roleID, maxPending int) (int64, error)
	ListPendingUsers(ctx context.Context, limit, offset int) ([]db.PendingUser, error)
	CountPendingUsers(ctx context.Context) (int64, error)
	ApprovePendingUser(ctx context.Context, userID int64) error
	DenyPendingUser(ctx context.Context, userID int64) error
	UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about *string) error
	UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error
	UpdateUserPassword(ctx context.Context, userID int64, newPasswordHash string) error
	UpdateUserStatus(ctx context.Context, id int64, status string) error
	MarkUserDisconnected(ctx context.Context, userID int64) error
	UpdateUserTOTPSecret(ctx context.Context, id int64, secret *string) error
	UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error
	UpdateUserRole(ctx context.Context, userID, roleID int64) error
	ResetAllUserStatuses(ctx context.Context) error
	// Account erasure (B4-9): the database half in one transaction, the
	// file half journaled in erasure_jobs and resumed until every file is
	// gone; ReferencedStoredFiles serves the storage reconciliation pass.
	EraseAccount(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	EraseAccountPreflight(ctx context.Context, userID int64) error
	ReplayEraseAccount(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	UnlinkQueuedAudits(ctx context.Context, userID int64, token string) error
	RelinkAudits(userID int64)
	CountAdminClassAccounts(ctx context.Context) (int, error)
	SequenceValue(ctx context.Context, table string) (int64, error)
	RaiseSequences(ctx context.Context, floors map[string]int64) error
	ListUserIDs(ctx context.Context) ([]int64, error)
	LogAuditEntry(ctx context.Context, e db.AuditEntry) error
	ListUnfinishedErasureJobs(ctx context.Context) ([]db.ErasureJob, error)
	RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error
	CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error
	MarkErasureJobReplayPurged(ctx context.Context, id int64) error
	DeleteEventsForUser(ctx context.Context, userID int64) (int64, error)
	ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error)
	// Retention (B4-11): the policy, the sweep and its run journal.
	ServerRetentionDays(ctx context.Context) (int, error)
	ListChannelRetention(ctx context.Context) ([]db.ChannelRetention, error)
	GetChannelRetention(ctx context.Context, channelID int64) (*db.ChannelRetention, error)
	SetChannelRetention(ctx context.Context, channelID int64, days int, updatedBy int64) error
	DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error)
	RetentionWindows(ctx context.Context) ([]db.RetentionWindow, error)
	CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time) (int64, error)
	SweepRetention(ctx context.Context, channelID int64, cutoff time.Time, limit int) ([]int64, []string, error)
	DeleteEventsForMessages(ctx context.Context, ids []int64) (int64, error)
	StartRetentionRun(ctx context.Context) (int64, error)
	RecordRetentionRunFiles(ctx context.Context, runID int64, channels, deleted int, files []string) error
	RecordRetentionRunPurge(ctx context.Context, runID int64, ids []int64) error
	FinishRetentionRun(ctx context.Context, runID int64, filesRemoved int, lastError string) error
	ListUnfinishedRetentionRuns(ctx context.Context) ([]db.RetentionRun, error)
	ListMembers(ctx context.Context) ([]db.MemberSummary, error)

	// ── Sessions ──
	CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (*db.Session, error)
	GetSessionsWithBanStatusBatch(ctx context.Context, tokenHashes []string) (map[string]*db.SessionWithBanStatus, error)
	TouchAPIToken(ctx context.Context, tokenHash string) error
	GetActiveAPIToken(ctx context.Context, tokenHash string) (*db.APIToken, error)
	GetSessionWithBanStatus(ctx context.Context, tokenHash string) (*db.SessionWithBanStatus, error)
	DeleteSession(ctx context.Context, tokenHash string) error
	DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error)
	DeleteUserSessions(ctx context.Context, userID int64) (int64, error)
	DeleteExpiredSessions(ctx context.Context) error
	DeleteSessionByID(ctx context.Context, sessionID, userID int64) error
	TouchSession(ctx context.Context, tokenHash string) error
	ListUserSessions(ctx context.Context, userID int64) ([]db.Session, error)
	MarkSessionsSeen(ctx context.Context, userID, exceptSessionID int64) (int64, error)
	ForceLogoutUser(ctx context.Context, userID int64) error
	GetUserSessions(ctx context.Context, userID int64) ([]db.Session, error)

	// ── Roles ──
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error)
	GetUserWithRole(ctx context.Context, userID int64) (*db.User, *db.Role, error)
	ListRoles(ctx context.Context) ([]*db.Role, error)
	GetRoleByName(ctx context.Context, name string) (*db.Role, error)
	GetDefaultRole(ctx context.Context) (*db.Role, error)
	CreateRole(ctx context.Context, name string, color *string, perms int64, position int) (*db.Role, error)
	UpdateRole(ctx context.Context, id int64, name string, color *string, perms int64, position int) error
	SetRolePositions(ctx context.Context, positions map[int64]int) error
	DeleteRoleReassigning(ctx context.Context, roleID, fallbackRoleID int64) ([]int64, error)
	ListUserIDsByRole(ctx context.Context, roleID int64) ([]int64, error)
	CountRoleMembers(ctx context.Context) (map[int64]int, error)

	// ── Emoji ──
	ListEmoji(ctx context.Context) ([]*db.Emoji, error)
	GetEmoji(ctx context.Context, id int64) (*db.Emoji, error)
	GetEmojiByShortcode(ctx context.Context, shortcode string) (*db.Emoji, error)
	CreateEmoji(ctx context.Context, shortcode, storedAs, mimeType string, uploadedBy int64) (*db.Emoji, error)
	DeleteEmoji(ctx context.Context, id int64) (bool, error)

	// ── Invites ──
	CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error)
	GetInvite(ctx context.Context, code string) (*db.Invite, error)
	ListInvites(ctx context.Context) ([]*db.Invite, error)
	UseInviteAtomic(ctx context.Context, code string) error
	RevokeInvite(ctx context.Context, code string) error

	// ── Voice ──
	JoinVoiceChannel(ctx context.Context, userID, channelID int64) error
	JoinVoiceChannelIfCapacity(ctx context.Context, userID, channelID int64, maxUsers int) error
	LeaveVoiceChannel(ctx context.Context, userID int64) error
	LeaveVoiceChannelIfMatch(ctx context.Context, userID, expectedChannelID int64, expectedJoinedAt string) (bool, error)
	GetVoiceState(ctx context.Context, userID int64) (*db.VoiceState, error)
	GetChannelVoiceStates(ctx context.Context, channelID int64) ([]db.VoiceState, error)
	GetAllVoiceStates(ctx context.Context) ([]db.VoiceState, error)
	UpdateVoiceMute(ctx context.Context, userID int64, muted bool) error
	UpdateVoiceDeafen(ctx context.Context, userID int64, deafened bool) error
	ClearVoiceState(ctx context.Context, userID int64) error
	ClearAllVoiceStates(ctx context.Context) error
	CountActiveCameras(ctx context.Context, channelID int64) (int, error)
	UpdateVoiceCamera(ctx context.Context, userID int64, camera bool) error
	EnableCameraIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	UpdateVoiceScreenshare(ctx context.Context, userID int64, screenshare bool) error
	EnableScreenshareIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	CountChannelVoiceUsers(ctx context.Context, channelID int64) (int, error)
	SetVoiceServerMute(ctx context.Context, userID, channelID int64, serverMuted bool) (matched bool, err error)
	SetVoiceServerDeafen(ctx context.Context, userID, channelID int64, serverDeafened bool) (matched bool, err error)

	// ── Direct messages ──
	GetOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64) (*db.Channel, bool, error)
	FindDMChannelIDBetween(ctx context.Context, user1ID, user2ID int64) (int64, bool, error)
	GetUserDMChannels(ctx context.Context, userID int64) ([]db.DMChannelInfo, error)
	GetUserDMChannelIDs(ctx context.Context, userID int64) ([]int64, error)
	OpenDM(ctx context.Context, userID, channelID int64) (bool, error)
	CloseDM(ctx context.Context, userID, channelID int64) error
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	GetDMRecipient(ctx context.Context, channelID, requestingUserID int64) (*db.User, error)
	CreateGroupDMChannel(ctx context.Context, name string, participantIDs []int64) (*db.Channel, error)
	LeaveGroupDM(ctx context.Context, userID, channelID int64) (bool, error)
	CountDMParticipants(ctx context.Context, channelID int64) (int, error)
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	SetDMChannelName(ctx context.Context, channelID int64, name string) error
	GetDMParticipants(ctx context.Context, channelID, viewerID int64) ([]db.DMUser, error)

	// ── Blocks ──
	BlockUser(ctx context.Context, blockerID, blockedID int64) error
	UnblockUser(ctx context.Context, blockerID, blockedID int64) error
	IsBlocked(ctx context.Context, blockerID, blockedID int64) (bool, error)
	IsEitherBlocked(ctx context.Context, userA, userB int64) (bool, error)
	ListBlockedUsers(ctx context.Context, blockerID int64) ([]int64, error)

	// ── Attachments ──
	CreateAttachment(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error
	GetAttachmentByID(ctx context.Context, id string) (*db.Attachment, error)
	GetAttachmentWithChannel(ctx context.Context, id string) (*db.AttachmentAccess, error)
	DeleteOrphanedAttachments(ctx context.Context, cutoff time.Time) ([]string, error)
	// IsMessageDeleted backs the tombstone half of attachment access; the
	// avatar check backs the "public exactly while in use" half.
	IsMessageDeleted(ctx context.Context, id int64) (deleted, found bool, err error)
	IsAvatarFileURL(ctx context.Context, url string) (bool, error)

	// ── Admin ──
	UserCount(ctx context.Context) (int64, error)
	GetServerStats(ctx context.Context) (*db.ServerStats, error)
	ListAllUsers(ctx context.Context, limit, offset int) ([]db.UserWithRole, error)
	BanUser(ctx context.Context, id int64, reason string, expires *time.Time) error
	UnbanUser(ctx context.Context, id int64) error
	LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error
	GetAuditLog(ctx context.Context, limit, offset int) ([]db.AuditEntry, error)
	AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	AdminUpdateChannel(ctx context.Context, id int64, u db.ChannelUpdate) error
	AdminDeleteChannel(ctx context.Context, id int64) error
	BackupTo(ctx context.Context, path string) error
	BackupToSafe(ctx context.Context, path, safeRoot string) error
	CountUsersWithoutTOTP(ctx context.Context) (int, error)

	// ── Settings ──
	GetSetting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
	GetAllSettings(ctx context.Context) (map[string]string, error)
	// ApplySettings upserts every pair in one transaction — the settings
	// PATCH is atomic from the caller's perspective (settings family).
	ApplySettings(ctx context.Context, updates map[string]string) error
}
