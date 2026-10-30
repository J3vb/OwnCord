package service

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Store is the data-access surface the service layer depends on: the *db.DB
// methods the services call, which *db.DB satisfies directly. Tests inject fakes
// embedding a real in-memory *db.DB that override one method to exercise an error
// path. permissions.NewChecker takes its own narrower interface (permissions.DB)
// that both satisfy.
type Store interface {
	CallLogStore // the DM call log worker's reads and writes
	GroupDMStore // group DM membership and its system rows
	EmojiStore   // the custom emoji set
	// Second-factor state: the durable backend behind the auth service's
	// partial-auth, pending-enrolment and used-code stores, plus the recovery-code
	// rows. Stdlib types only, because auth cannot import db.
	auth.SecondFactorPersister
	ReplaceRecoveryCodes(ctx context.Context, userID int64, codeHashes []string) error
	ListUnusedRecoveryCodes(ctx context.Context, userID int64) (ids []int64, hashes []string, err error)
	MarkRecoveryCodeUsed(ctx context.Context, id int64) (consumed bool, err error)
	CountUnusedRecoveryCodes(ctx context.Context, userID int64) (int, error)
	DeleteRecoveryCodes(ctx context.Context, userID int64) error

	CreateMessage(ctx context.Context, channelID, userID int64, content string, replyTo *int64) (int64, error)
	CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, replyPingUserID int64, mentionsEveryone bool, mentionedRoleIDs []int64) (*db.Message, error)
	FindMessageDelivery(ctx context.Context, p db.MessageDeliveryParams) (*db.MessageDelivery, error)
	CreateMessageDelivery(ctx context.Context, p db.MessageDeliveryParams) (*db.MessageDelivery, error)
	MessageDeliveryFloorMS() int64
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	GetMessages(ctx context.Context, channelID, before int64, limit int) ([]db.MessageWithUser, error)
	GetMessagesForAPI(ctx context.Context, channelID, before int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	GetMessagesAfterForAPI(ctx context.Context, channelID, after int64, limit int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	GetMessagesAroundForAPI(ctx context.Context, channelID, centerID int64, beforeCount, afterCount int, requestingUserID int64) ([]db.MessageAPIResponse, error)
	EditMessage(ctx context.Context, id, userID int64, content string) (*db.Message, error)
	DeleteMessage(ctx context.Context, id, userID int64, isMod bool) error
	SearchMessagesFiltered(ctx context.Context, q db.SearchQuery, page db.SearchPage) ([]db.MessageSearchResult, error)
	GetPinnedMessages(ctx context.Context, channelID int64, requestingUserID int64) ([]db.MessageAPIResponse, error)
	SetMessagePinned(ctx context.Context, p db.SetPinnedParams) (*db.PinEventRow, error)
	AddReaction(ctx context.Context, messageID, userID int64, emoji string) error
	RemoveReaction(ctx context.Context, messageID, userID int64, emoji string) error
	GetReactionUsers(ctx context.Context, messageID int64, emoji string, limit int) ([]db.ReactionUser, error)
	// MarkChannelReadAtLatest is the mark-read that computes its own watermark. The
	// send path's read-state advance happens inside CreateMessageWithMentions /
	// CreateMessageDelivery.
	MarkChannelReadAtLatest(ctx context.Context, userID, channelID int64) error
	GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error)
	// MoveReadPointer moves a reader's pointer and recomputes mention_count from the
	// receipts in one writer transaction. The caller holds mentionEmitMu across it and
	// the frame it sends.
	MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error)
	GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]db.ChannelUnread, error)

	ReplaceMessageMentions(ctx context.Context, messageID int64, mentionedUserIDs []int64, mentionsEveryone bool, mentionedRoleIDs []int64) (replyPingUserID int64, err error)
	IncrementMentionCounts(ctx context.Context, channelID, msgID int64, userIDs []int64) error
	// IncrementMentionCountsBatch applies a coalesced window of mention jobs in one
	// writer transaction (the mention worker's flush). It returns userID to
	// mention_count for exactly the recipients whose read-state guard admitted the
	// bump: the live-badge signal.
	IncrementMentionCountsBatch(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) (map[int64]int64, error)
	// DecrementMentionCounts reverses the bumps msgIDs made and returns userID to
	// mention_count for exactly the readers the guards admitted, the live-badge signal
	// for a removal path.
	DecrementMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) (map[int64]int64, error)
	GetUserIDsByUsernames(ctx context.Context, usernames []string) (map[string]int64, error)
	ListMentionTargetsByRoles(ctx context.Context, roleIDs []int64) ([]db.MentionTarget, error)
	ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error)
	// IsBlocked answers the single (blocker, blocked) pair rather than ListBlockersOf's
	// whole set. Push dispatch re-asks it before every delivery attempt: the
	// audience-wide result is a pre-dispatch snapshot, and a block landing in flight
	// must stop the remaining attempts.
	IsBlocked(ctx context.Context, blockerID, blockedID int64) (bool, error)
	GetChannelOverrides(ctx context.Context, channelID int64) (map[int64]db.ChannelOverride, error)
	GetAllChannelPermissionsForRole(ctx context.Context, roleID int64) (map[int64]db.ChannelOverride, error)
	GetChannelUserOverrides(ctx context.Context, channelID int64) (map[int64]db.ChannelOverride, error)
	ListMentionTargetsByUserIDs(ctx context.Context, userIDs []int64) ([]db.MentionTarget, error)
	GetLatestMessageID(ctx context.Context, channelID int64) (int64, error)
	LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) ([]string, error)
	GetAttachmentsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]db.AttachmentInfo, error)
	GetReferencedMessages(ctx context.Context, channelID int64, ids []int64) (map[int64]*db.ReferencedMessage, error)

	ListChannels(ctx context.Context) ([]db.Channel, error)
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	CreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	// GetChannelPermissions / GetUserChannelPermissions are the single-row override
	// lookups permissions.DB requires.
	GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error)
	GetUserChannelPermissions(ctx context.Context, channelID, userID int64) (allow, deny int64, err error)
	// Override CRUD for the channel permission layer: the listings the matrix editor
	// renders and the gated writes/clears.
	ListChannelRoleOverrides(ctx context.Context, channelID int64) ([]db.ChannelRoleOverride, error)
	ListChannelUserOverrides(ctx context.Context, channelID int64) ([]db.ChannelUserOverride, error)
	UpsertChannelOverride(ctx context.Context, channelID, roleID, allow, deny int64) error
	DeleteChannelOverride(ctx context.Context, channelID, roleID int64) error
	UpsertChannelUserOverride(ctx context.Context, channelID, userID, allow, deny int64) error
	DeleteChannelUserOverride(ctx context.Context, channelID, userID int64) error
	// GetMemberGrants fetches every held role's override and the per-user layer for
	// one member in batch queries: the single fetch behind every "what can this
	// member do here" site, so none pays an N+1.
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)

	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	GetOwnerUser(ctx context.Context) (*db.User, error)

	CreateAPIToken(ctx context.Context, userID int64, tokenHash, label string, expiresAt *time.Time) (int64, error)
	ListAPITokens(ctx context.Context) ([]db.APITokenListItem, error)
	RevokeAPIToken(ctx context.Context, id int64) (int64, error)
	RevokeAPITokenByLabel(ctx context.Context, label string) (int64, error)
	CreateUser(ctx context.Context, username, passwordHash string, roleID int) (int64, error)
	CreateOwnerIfEmpty(ctx context.Context, username, passwordHash string, roleID int) (int64, error)
	CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode, sessionTokenHash, device, ip string) (int64, error)
	CreateUserWithSession(ctx context.Context, username, passwordHash string, roleID int, sessionTokenHash, device, ip string) (int64, error)
	// Recovery kit.
	UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error
	GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error)
	RedeemRecoveryKit(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Owner-issued recovery credential.
	UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error
	GetRecoveryAssist(ctx context.Context, userID int64) (*db.RecoveryAssist, error)
	RedeemRecoveryAssist(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Approval-mode registration.
	CreatePendingUser(ctx context.Context, username, passwordHash string, roleID, maxPending int) (int64, error)
	ListPendingUsers(ctx context.Context, limit, offset int) ([]db.PendingUser, error)
	CountPendingUsers(ctx context.Context) (int64, error)
	ApprovePendingUser(ctx context.Context, userID int64) error
	DenyPendingUser(ctx context.Context, userID int64) error
	UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string) error
	UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error
	UpdateUserPresence(ctx context.Context, userID int64, status string, customStatus, expiresAt *string) error
	NextCustomStatusExpiry(ctx context.Context) (string, bool, error)
	ListExpiredCustomStatuses(ctx context.Context, now string, limit int) ([]db.ExpiredCustomStatus, error)
	ClearCustomStatusIfExpiry(ctx context.Context, userID int64, expiresAt string) (bool, error)
	UpdateUserPassword(ctx context.Context, userID int64, newPasswordHash string) error
	UpdateUserStatus(ctx context.Context, id int64, status string) error
	StampConnections(ctx context.Context, connected, disconnected []int64) error
	UpdateUserTOTPSecret(ctx context.Context, id int64, secret *string) error
	UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error
	UpdateUserRole(ctx context.Context, userID, roleID int64) error
	ResetAllUserStatuses(ctx context.Context) error
	// Account erasure: the stages of the database half.
	ErasureStageStore
	EraseAccountPreflight(ctx context.Context, userID int64) error
	ReplayEraseAccount(ctx context.Context, userID int64, subjectToken string) (*db.ErasureJob, error)
	FlushAudits(ctx context.Context) error
	CountAdminClassAccounts(ctx context.Context) (int, error)
	CloseSetupGate(ctx context.Context) error
	SequenceValue(ctx context.Context, table string) (int64, error)
	RaiseSequences(ctx context.Context, floors map[string]int64) error
	ListUserIDs(ctx context.Context) ([]int64, error)
	LogAuditEntry(ctx context.Context, e db.AuditEntry) error
	ListUnfinishedErasureJobs(ctx context.Context) ([]db.ErasureJob, error)
	// FinishOwedErasureCheckpoint finishes, on the runner's tick, a
	// wal_checkpoint(TRUNCATE) an erasure could not.
	FinishOwedErasureCheckpoint(ctx context.Context) (bool, error)
	RecordErasureJobAttempt(ctx context.Context, id int64, filesRemoved int, lastError string) error
	CompleteErasureJob(ctx context.Context, id int64, filesRemoved int) error
	MarkErasureJobReplayPurged(ctx context.Context, id int64) error
	DeleteEventsForUser(ctx context.Context, userID int64) (int64, error)
	ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error)
	RetentionPolicySnapshot(ctx context.Context) (*db.RetentionPolicySnapshot, error)
	PreviewRetentionChange(ctx context.Context, change db.RetentionChange, revision string, observed time.Time) (*db.RetentionChangeEffect, error)
	ApplyRetentionChange(ctx context.Context, actorID int64, change db.RetentionChange, revision string) (string, error)
	// Retention: the policy, the sweep and its run journal.
	ServerRetentionDays(ctx context.Context) (int, error)
	ListChannelRetention(ctx context.Context) ([]db.ChannelRetention, error)
	GetChannelRetention(ctx context.Context, channelID int64) (*db.ChannelRetention, error)
	SetChannelRetention(ctx context.Context, channelID int64, days int, updatedBy int64) error
	DeleteChannelRetention(ctx context.Context, channelID int64) (bool, error)
	RetentionWindows(ctx context.Context) ([]db.RetentionWindow, error)
	CountRetentionCandidates(ctx context.Context, channelID int64, cutoff time.Time, includeImported bool) (int64, error)
	SweepRetentionJournaled(ctx context.Context, runID, channelID int64, cutoff time.Time, limit int, countChannel, includeImported bool) (int64, []int64, []string, error)
	DeleteEventsForMessages(ctx context.Context, ids []int64) (int64, error)
	StartRetentionRun(ctx context.Context) (int64, error)
	RecordRetentionRunFiles(ctx context.Context, runID int64, channels, deleted int, files []string) error
	RecordRetentionRunPurge(ctx context.Context, runID int64, ids []int64) error
	FinishRetentionRun(ctx context.Context, runID int64, filesRemoved int, lastError string) error
	ListUnfinishedRetentionRuns(ctx context.Context) ([]db.RetentionRun, error)
	ListMembers(ctx context.Context) ([]db.MemberSummary, error)

	CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
	CreateFirstSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (*db.Session, error)
	GetSessionsWithBanStatusBatch(ctx context.Context, tokenHashes []string) (map[string]*db.SessionWithBanStatus, error)
	TouchAPIToken(ctx context.Context, tokenHash string) error
	GetActiveAPIToken(ctx context.Context, tokenHash string) (*db.APIToken, error)
	GetSessionWithBanStatus(ctx context.Context, tokenHash string) (*db.SessionWithBanStatus, error)
	DeleteSession(ctx context.Context, tokenHash string) error
	DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error)
	SignOutEverywhere(ctx context.Context, userID int64) (sessions, tokens int64, err error)
	DeleteExpiredSessions(ctx context.Context) error
	DeleteSessionByID(ctx context.Context, sessionID, userID int64) error
	TouchSessions(ctx context.Context, tokenHashes []string) error
	ListUserSessions(ctx context.Context, userID int64) ([]db.Session, error)
	MarkSessionsSeen(ctx context.Context, userID, exceptSessionID int64) (int64, error)

	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	ListRoles(ctx context.Context) ([]*db.Role, error)
	GetRoleByName(ctx context.Context, name string) (*db.Role, error)
	GetDefaultRole(ctx context.Context) (*db.Role, error)
	CreateRole(ctx context.Context, name string, color *string, perms int64, position int, hoist, mentionable bool) (*db.Role, error)
	UpdateRole(ctx context.Context, id int64, name string, color *string, perms int64, position int, hoist, mentionable bool) ([]int64, error)
	SetRolePositions(ctx context.Context, positions map[int64]int) ([]int64, error)
	DeleteRoleReassigning(ctx context.Context, roleID, fallbackRoleID int64) ([]int64, error)
	ListUserIDsByRole(ctx context.Context, roleID int64) ([]int64, error)
	CountRoleMembers(ctx context.Context) (map[int64]int, error)

	CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error)
	GetInvite(ctx context.Context, code string) (*db.Invite, error)
	ListInvites(ctx context.Context) ([]*db.Invite, error)
	RevokeInvite(ctx context.Context, code string) error
	ListInviteRedemptions(ctx context.Context, inviteID int64, limit int) ([]*db.InviteRedemption, error)

	JoinVoiceChannel(ctx context.Context, userID, channelID int64) error
	JoinVoiceChannelIfCapacity(ctx context.Context, userID, channelID int64, maxUsers int) error
	LeaveVoiceChannelIfMatch(ctx context.Context, userID, expectedChannelID int64, expectedJoinedAt string) (bool, error)
	GetVoiceState(ctx context.Context, userID int64) (*db.VoiceState, error)
	GetChannelVoiceStates(ctx context.Context, channelID int64) ([]db.VoiceState, error)
	GetAllVoiceStates(ctx context.Context) ([]db.VoiceState, error)
	UpdateVoiceMute(ctx context.Context, userID int64, muted bool) error
	UpdateVoiceDeafen(ctx context.Context, userID int64, deafened bool) error
	ClearAllVoiceStates(ctx context.Context) error
	UpdateVoiceCamera(ctx context.Context, userID int64, camera bool) error
	EnableCameraIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	UpdateVoiceScreenshare(ctx context.Context, userID int64, screenshare bool) error
	EnableScreenshareIfUnderLimit(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	CountChannelVoiceUsers(ctx context.Context, channelID int64) (int, error)
	SetVoiceServerMute(ctx context.Context, userID, channelID int64, serverMuted bool) (matched bool, err error)
	SetVoiceServerDeafen(ctx context.Context, userID, channelID int64, serverDeafened bool) (matched bool, err error)
	// MuteForTimeoutSession is SetVoiceServerMute scoped to one exact session
	// (channelID, joinedAt), stamping actionID as owner (voice_states.server_muted_by)
	// atomically with the mute, only on a genuine unmuted-to-muted transition.
	// supersededIDs transfers ownership from just-superseded ledger ids onto actionID
	// in the same transaction; only the caller (ws.Hub, under its per-user lock) may
	// do that transfer (see TimeoutVoiceMuter.MuteForTimeout).
	MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (matched, transitioned bool, err error)
	// ClearServerMuteOwnedBy clears server_muted for the voice_states row naming one
	// of actionIDs as owner and reports its channel/join token for the paired SFU call.
	ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (channelID int64, joinedAt string, matched bool, err error)

	GetOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64) (*db.Channel, bool, error)
	GetOrCreateDMChannelGated(ctx context.Context, callerID, recipientID int64) (ch *db.Channel, created bool, recipientOpened bool, accepted *db.MessageRequest, err error)
	FindDMChannelIDBetween(ctx context.Context, user1ID, user2ID int64) (int64, bool, error)
	GetUserDMChannels(ctx context.Context, userID int64) ([]db.DMChannelInfo, error)
	GetUserDMChannelIDs(ctx context.Context, userID int64) ([]int64, error)
	OpenDM(ctx context.Context, userID, channelID int64) (bool, error)
	OpenDMIfParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	CloseDM(ctx context.Context, userID, channelID int64) error
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []db.DMDeliveryTarget, err error)
	GetDMRecipient(ctx context.Context, channelID, requestingUserID int64) (*db.User, error)
	CreateGroupDMChannel(ctx context.Context, name string, ownerID int64, participantIDs []int64) (*db.Channel, error)
	GetGroupDMMeta(ctx context.Context, channelID int64) (ownerID int64, iconID string, err error)
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMParticipants(ctx context.Context, channelID, viewerID int64) ([]db.DMUser, error)

	IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error)
	CreateMessageRequest(ctx context.Context, senderID, recipientID, channelID, firstMessageID int64) (db.MessageRequestOutcome, error)
	GetMessageRequest(ctx context.Context, id, recipientID int64) (*db.MessageRequest, error)
	GetMessageRequestByPair(ctx context.Context, senderID, recipientID int64) (*db.MessageRequest, error)
	ListPendingMessageRequests(ctx context.Context, recipientID int64) ([]db.MessageRequestView, error)
	TransitionMessageRequest(ctx context.Context, id, recipientID int64, to string) (bool, error)
	AcceptMessageRequest(ctx context.Context, id, recipientID int64) (*db.MessageRequest, error)

	BlockUser(ctx context.Context, blockerID, blockedID int64) error
	UnblockUser(ctx context.Context, blockerID, blockedID int64) error
	IsEitherBlocked(ctx context.Context, userA, userB int64) (bool, error)
	ListBlockedUsers(ctx context.Context, blockerID int64) ([]int64, error)

	AddGIFFavorite(ctx context.Context, userID int64, f db.GIFFavorite) error
	RemoveGIFFavorite(ctx context.Context, userID int64, url string) error
	ListGIFFavorites(ctx context.Context, userID int64) ([]db.GIFFavorite, error)

	AcknowledgeNSFW(ctx context.Context, userID, channelID int64) (bool, error)
	RevokeNSFW(ctx context.Context, userID, channelID int64) error
	HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error)
	ListNSFWAcknowledgedUserIDs(ctx context.Context, channelID int64) ([]int64, error)
	AdminUpdateChannelClearingNSFW(ctx context.Context, id int64, u db.ChannelUpdate) error

	CreateAttachmentVoice(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height, durationMs *int, waveform *string) error
	GetAttachmentWithChannel(ctx context.Context, id string) (*db.AttachmentAccess, error)
	DeleteUnlinkedAttachment(ctx context.Context, id string, userID int64) (bool, error)
	DiscardUnlinkedAttachment(ctx context.Context, id string, userID int64) (storedAs string, found bool, err error)
	DeleteOrphanedAttachments(ctx context.Context, cutoff time.Time) ([]string, error)
	// IsMessageDeleted backs the tombstone half of attachment access; the avatar
	// check backs the "public exactly while in use" half.
	IsMessageDeleted(ctx context.Context, id int64) (deleted, found bool, err error)
	IsAvatarFileURL(ctx context.Context, url string) (bool, error)
	IsGroupDMIconForUser(ctx context.Context, fileID string, userID int64) (bool, error) // live icon, members only
	// The per-user upload byte counter: charged before a store write, released on a
	// failed one, recounted from the rows on the maintenance tick (UploadService.Reserve).
	ChargeUserStorage(ctx context.Context, userID, bytes, quota int64) (bool, error)
	ReleaseUserStorage(ctx context.Context, userID, bytes int64) error
	UserStorageUsed(ctx context.Context, userID int64) (int64, error)
	ListUserStorageIDs(ctx context.Context) ([]int64, error)
	RecountUserStorage(ctx context.Context, userID int64) error

	// FileReport inserts the report row and its evidence snapshot in one writer
	// transaction, leaving no autocommit window for an erasure to land content or an
	// author id mid-intake. The caller generates publicID (crypto/rand).
	FileReport(ctx context.Context, publicID string, reporterID, subjectID int64, targetType, targetRef string, channelID *int64, reason, detail string, evidence []db.ReportEvidenceInput) (int64, error)
	GetReport(ctx context.Context, id int64) (*db.Report, error)
	GetReportByPublicID(ctx context.Context, publicID string) (*db.Report, error)
	FindOpenOrAssignedReport(ctx context.Context, reporterID int64, targetType, targetRef string) (int64, error)
	ListReportsQueue(ctx context.Context, state string) ([]db.ReportQueueRow, error)
	ListReportsMine(ctx context.Context, reporterID int64) ([]db.ReportSummary, error)
	// AssignReport is guarded on state, the caller's last-observed assignee
	// (optimistic concurrency) and EXISTS(users).
	AssignReport(ctx context.Context, id, assigneeID, observedAssigneeID int64) (bool, error)
	// AssignReportForced is the force-reassign path: BOTH principals' role positions
	// are read fresh inside the write's transaction. ErrForbidden means the caller
	// does not outrank the current assignee.
	AssignReportForced(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64) (bool, error)
	CloseReport(ctx context.Context, id int64, state, outcome string, actorID int64) (bool, error)
	ListReportEvidence(ctx context.Context, reportID int64) ([]db.ReportEvidenceRow, error)
	// InsertReportNote is guarded on EXISTS(users) and the report's state; false
	// means 409: the author was erased, or the report closed, before the write.
	InsertReportNote(ctx context.Context, reportID, authorID int64, body string) (bool, error)
	ListReportNotes(ctx context.Context, reportID int64) ([]db.ReportNoteRow, error)
	// ListReportEvents reads report_events, this feature's own immutable history
	// (never the shared audit_log), exposed only inside the queue detail. The
	// mutations above write their event in the same transaction.
	ListReportEvents(ctx context.Context, reportID int64) ([]db.ReportEvent, error)
	PruneReportContentOlderThan(ctx context.Context, cutoff string) (int64, error)

	// WarnUser/TimeoutUser write their whole effect as one ledger row, in one
	// transaction with the live rank guard: a target promoted after the caller's
	// check is refused (db.ErrOutranked), not sanctioned.
	WarnUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string) (int64, error)
	// TimeoutUser also returns the ids it superseded; the caller passes them to the
	// voice mute so the ownership transfer runs under ITS per-user lock.
	TimeoutUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string, expiresAt time.Time) (id int64, supersededIDs []int64, err error)
	// LiftTimeout returns the ids of the timeout rows it lifted (nil, none). The
	// caller passes them to ClearServerMuteOwnedBy: ownership lives on the voice
	// session, not this ledger.
	LiftTimeout(ctx context.Context, targetID, actorID int64) (liftedIDs []int64, err error)
	// HasActiveTimeout is the indexed per-user lookup (FinalizeTimeoutLift;
	// PermissionService.Subject reads its mirror).
	HasActiveTimeout(ctx context.Context, userID int64) (bool, error)
	// ListActiveTimeoutExpiries loads PermissionService's in-memory mirror of every
	// active timeout.
	ListActiveTimeoutExpiries(ctx context.Context) ([]db.ActiveTimeoutExpiry, error)
	AcknowledgeWarning(ctx context.Context, userID, actionID int64) (bool, error)
	ListUnacknowledgedWarnings(ctx context.Context, userID int64) ([]db.ModerationNotice, error)
	ListModerationActionsForTarget(ctx context.Context, targetID int64) ([]db.ModerationAction, error)
	ListOwnModerationActions(ctx context.Context, userID, limit int64) ([]db.OwnModerationAction, error)
	ListModerationActionsForReport(ctx context.Context, reportID int64) ([]db.ModerationAction, error)
	// BanUserWithAction/ForceLogoutWithAction are BanUser/ForceLogoutUser plus a
	// ledger row, in one transaction.
	BanUserWithAction(ctx context.Context, targetID int64, reason string, expires *time.Time, actorID int64, reportID *int64) (int64, error)
	// ForceLogoutWithAction's reason is the ledger row's text; empty falls back to
	// the fixed phrase.
	ForceLogoutWithAction(ctx context.Context, targetID, actorID int64, reportID *int64, reason string) (int64, error)
	// DeleteMessageWithRemoval/PurgeChannelMessagesWithAction are DeleteMessage/
	// PurgeChannelMessages plus a removal ledger row in the same transaction, when
	// the deleter is not the author. DeleteMessageWithRemoval's reason is the row's
	// text; empty falls back to "message removed".
	DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64, reason string) error
	PurgeChannelMessagesWithAction(ctx context.Context, channelID, before int64, limit int, actorID int64, reportID *int64) ([]int64, error)
	// PurgeUserChannelMessagesSince/ListUserMessageChannelsSince are the ban purge's
	// author-and-window-scoped counterparts of PurgeChannelMessagesWithAction;
	// RecordRemovalAction writes the one removal ledger row (targeting the author).
	PurgeUserChannelMessagesSince(ctx context.Context, channelID, userID int64, since string, limit int) ([]int64, error)
	ListUserMessageChannelsSince(ctx context.Context, userID int64, since string) ([]int64, error)
	RecordRemovalAction(ctx context.Context, targetID, actorID int64, reason string) error
	RetireModerationActions(ctx context.Context, days int) (int64, error)
	// GetModerationAction backs appeal submission and decision, which need the
	// action's kind, target and actor.
	GetModerationAction(ctx context.Context, id int64) (*db.ModerationAction, error)

	// FindAppealForAction is the dedupe FAST PATH; InsertAppeal's UNIQUE(action_id)
	// violation enforces "one appeal per action, ever" under concurrency.
	FindAppealForAction(ctx context.Context, actionID int64) (int64, error)
	InsertAppeal(ctx context.Context, publicID string, actionID, appellantID int64, body string) (int64, error)
	GetAppeal(ctx context.Context, id int64) (*db.Appeal, error)
	GetAppealByPublicID(ctx context.Context, publicID string) (*db.Appeal, error)
	ListAppealsMine(ctx context.Context, appellantID int64) ([]db.AppealSummary, error)
	ListAppealsQueue(ctx context.Context, state string) ([]db.AppealQueueRow, error)
	// AssignAppealTx is Assign's plain path in its own transaction with a fresh
	// authority re-check and, when checkSelfReview is true, the deciding-moderator
	// eligibility test (see db.AssignAppealTx).
	AssignAppealTx(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64,
		checkSelfReview bool, appellantID, permBit, adminBit int64,
		checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)
	AssignAppealForced(ctx context.Context, id, assigneeID, observedAssigneeID, actorID int64,
		checkSelfReviewNeeded bool, appellantID, permBit, adminBit int64,
		checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (bool, error)
	// DecideAppealTx runs the fresh authority re-check, stale/terminal row rejection,
	// self-review test, the guarded decide UPDATE (on the OBSERVED state/assignee)
	// and, for an overturn, the reversal in one transaction (see db.DecideAppealTx).
	// reversalApplied tells the caller whether to write the reversal's audit row,
	// best-effort, AFTER the commit.
	DecideAppealTx(ctx context.Context, appealID int64, observedState string, observedAssigneeID int64, outcome string, decidedBy int64, note string, checkSelfReview bool, appellantID, permBit, adminBit int64, action db.AppealedAction,
		checkAuthority func(rolePerms int64, banned bool, banExpires *string) error) (result db.AppealWriteOutcome, soleModeratorUsed, reversalApplied bool, err error)
	WithdrawAppeal(ctx context.Context, id, appellantID int64) (bool, error)

	// UpsertPushSubscription's keep is the per-user device cap; upsert, eviction
	// ranking and eviction delete run in one transaction.
	UpsertPushSubscription(ctx context.Context, userID int64, endpoint, p256dh, auth, deviceName, keyID string, keep int) (int64, error)
	ListPushSubscriptions(ctx context.Context, userID int64, keyID string) ([]db.PushSubscription, error)
	DeletePushSubscription(ctx context.Context, userID, id int64) (bool, error)
	SweepPushSubscriptions(ctx context.Context, cutoff time.Time, keyID string) (int64, error)
	// ListPushSubscriptionsForDispatch and DeletePushSubscriptionByID are
	// dispatch-only: the former returns push credentials for a caller-narrowed
	// audience, the latter prunes by id on a push service's 404/410.
	ListPushSubscriptionsForDispatch(ctx context.Context, userIDs []int64, keyID string) ([]db.PushSubscriptionForDispatch, error)
	DeletePushSubscriptionByID(ctx context.Context, id int64) (bool, error)

	UserCount(ctx context.Context) (int64, error)
	GetServerStats(ctx context.Context) (*db.ServerStats, error)
	ListAllUsers(ctx context.Context, f db.UserListFilter, limit, offset int) ([]db.UserWithRole, error)
	BanUser(ctx context.Context, id int64, reason string, expires *time.Time) error
	UnbanUser(ctx context.Context, id int64) error
	LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error
	SearchAuditLog(ctx context.Context, action, query string, hideSignins bool, limit, offset int) ([]db.AuditEntry, error)
	ListAuditActions(ctx context.Context, limit int) ([]string, error)
	AdminCreateChannel(ctx context.Context, name, chanType, category, topic string, position int) (int64, error)
	AdminUpdateChannel(ctx context.Context, id int64, u db.ChannelUpdate) error
	AdminDeleteChannel(ctx context.Context, id int64) error
	BackupToSafe(ctx context.Context, path, safeRoot string) error
	CountUsersWithoutTOTP(ctx context.Context) (int, error)

	GetSetting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
	GetAllSettings(ctx context.Context) (map[string]string, error)
	// ApplySettings upserts every pair in one transaction, so the settings PATCH is
	// atomic.
	ApplySettings(ctx context.Context, updates map[string]string) error
}
