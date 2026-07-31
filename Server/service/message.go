package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
	"unicode/utf8"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
)

// sanitizer is the shared HTML sanitization policy (strips all tags).
var sanitizer = bluemonday.StrictPolicy()

// maxMessageLen is the maximum message length in runes.
const maxMessageLen = 4000

// Common service-layer errors.
var (
	ErrRateLimited    = errors.New("rate limited")
	ErrBadRequest     = errors.New("bad request")
	ErrNotFound       = errors.New("not found")
	ErrForbidden      = errors.New("forbidden")
	ErrInternal       = errors.New("internal error")
	ErrSlowMode       = errors.New("slow mode")
	ErrConflict       = errors.New("conflict")
	ErrBlocked        = errors.New("blocked")
	ErrDeletedMessage = errors.New("message is deleted")
)

// SendMessageParams contains validated input for sending a message.
type SendMessageParams struct {
	ChannelID     int64
	UserID        int64
	Username      string
	Avatar        *string
	RoleName      string
	Content       string // raw, will be sanitized
	ReplyTo       *int64
	AttachmentIDs []string
}

// SendMessageResult contains the output of a successful message send.
type SendMessageResult struct {
	MessageID int64
	Timestamp string
	Content   string // sanitized content
	IsDM      bool
	Channel   *db.Channel

	// DM-specific fields populated when IsDM is true.
	ParticipantIDs []int64
	SenderUser     *db.User // for dm_channel_open events
	OpenedDMFor    []int64  // participant IDs that had their DM opened

	// Attachment data for broadcast.
	Attachments []db.AttachmentInfo
}

// EditMessageResult contains the output of a successful message edit.
type EditMessageResult struct {
	MessageID int64
	ChannelID int64
	Content   string
	EditedAt  string
	IsDM      bool
	// DM-specific.
	ParticipantIDs []int64
}

// DeleteMessageResult contains the output of a successful message delete.
type DeleteMessageResult struct {
	MessageID int64
	ChannelID int64
	IsDM      bool
	IsMod     bool
	// DM-specific.
	ParticipantIDs []int64
}

// ReactionResult contains the output of a reaction add/remove.
type ReactionResult struct {
	MessageID int64
	ChannelID int64
	UserID    int64
	Emoji     string
	Action    string // "add" or "remove"
	IsDM      bool
	// DM-specific.
	ParticipantIDs []int64
}

// MessageService handles message-related business logic including
// send, edit, delete, reactions, pins, and search.
type MessageService struct {
	st      Store
	perms   *PermissionService
	limiter *auth.RateLimiter
}

// NewMessageService creates a MessageService.
func NewMessageService(st Store, perms *PermissionService, limiter *auth.RateLimiter) *MessageService {
	return &MessageService{
		st:      st,
		perms:   perms,
		limiter: limiter,
	}
}

// SendMessage validates, persists, and prepares broadcast data for a new message.
// Callers are responsible for emitting the appropriate events.
func (s *MessageService) SendMessage(ctx context.Context, p SendMessageParams) (*SendMessageResult, error) {
	// Phase B Step 8 — wrap the public service entrypoint in a tracing span
	// and a duration histogram. Both are no-ops in the default build.
	ctx, span := telemetry.GlobalTracer("service/message").Start(ctx, "MessageService.SendMessage",
		telemetry.Int64("user_id", p.UserID),
		telemetry.Int64("channel_id", p.ChannelID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "SendMessage"))
		span.End()
	}()

	// Rate limit.
	ratKey := auth.Key("chat", p.UserID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if p.ChannelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	isDM := ch.Type == "dm"

	// Permission check.
	if err := s.checkSendPermission(ctx, p.UserID, p.ChannelID, ch.Type); err != nil {
		return nil, err
	}

	// Slow mode (non-DM only).
	if !isDM && ch.SlowMode > 0 && !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.ManageMessages) {
		slowKey := auth.Key(auth.Key("slow", p.UserID), p.ChannelID)
		if s.limiter != nil && !s.limiter.Allow(slowKey, 1, time.Duration(ch.SlowMode)*time.Second) {
			return nil, fmt.Errorf("%w: channel has %ds slow mode", ErrSlowMode, ch.SlowMode)
		}
	}

	// Validate and sanitize content.
	content, err := sanitizeContent(p.Content, len(p.AttachmentIDs) > 0)
	if err != nil {
		return nil, err
	}

	// Attachment permission (non-DM).
	if !isDM && len(p.AttachmentIDs) > 0 {
		if !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.AttachFiles) {
			return nil, fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
		}
	}

	// Persist message. RETURNING hands back the inserted row, so the DB-assigned
	// timestamp the fan-out needs arrives with the insert instead of a re-read.
	msg, err := s.st.CreateMessageReturning(ctx, p.ChannelID, p.UserID, content, p.ReplyTo)
	if err != nil {
		slog.Error("MessageService.SendMessage CreateMessage", "err", err)
		return nil, fmt.Errorf("%w: failed to save message", ErrInternal)
	}
	msgID := msg.ID

	// Link attachments. Ownership is enforced atomically inside the link
	// UPDATE itself (uploader match + still unlinked), so another user's
	// upload, an already-linked attachment, or a nonexistent id is skipped by
	// the statement — no check-then-link race and no N+1 pre-verification.
	var attachments []db.AttachmentInfo
	if len(p.AttachmentIDs) > 0 {
		linked, linkErr := s.st.LinkAttachmentsToMessage(ctx, msgID, p.UserID, p.AttachmentIDs)
		if linkErr != nil {
			slog.Error("MessageService.SendMessage LinkAttachments", "err", linkErr, "msg_id", msgID)
			// Cleanup: soft-delete the message. The compensating delete must run
			// even when the link failed because the request ctx was canceled.
			if delErr := s.st.DeleteMessage(context.WithoutCancel(ctx), msgID, p.UserID, true); delErr != nil {
				slog.Error("MessageService.SendMessage DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
			}
			return nil, fmt.Errorf("%w: failed to send message with attachments", ErrInternal)
		}
		if linked < int64(len(p.AttachmentIDs)) {
			slog.Warn("MessageService.SendMessage: skipped attachments (not owned, already linked, or missing)",
				"msg_id", msgID, "user_id", p.UserID, "requested", len(p.AttachmentIDs), "linked", linked)
		}
		if linked > 0 {
			attMap, attErr := s.st.GetAttachmentsByMessageIDs(ctx, []int64{msgID})
			if attErr != nil {
				slog.Error("MessageService.SendMessage GetAttachments", "err", attErr)
			} else {
				attachments = attMap[msgID]
			}
		}
	}

	result := &SendMessageResult{
		MessageID:   msgID,
		Timestamp:   msg.Timestamp,
		Content:     content,
		IsDM:        isDM,
		Channel:     ch,
		Attachments: attachments,
	}

	// DM path: open DM for recipients.
	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, p.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.SendMessage GetDMParticipantIDs", "err", pErr, "channel_id", p.ChannelID)
			return result, nil // Message saved, skip DM side effects.
		}
		result.ParticipantIDs = participantIDs

		sender, _ := s.st.GetUserByID(ctx, p.UserID)
		result.SenderUser = sender

		for _, pid := range participantIDs {
			if pid == p.UserID {
				continue
			}
			if openErr := s.st.OpenDM(ctx, pid, p.ChannelID); openErr != nil {
				slog.Error("MessageService.SendMessage OpenDM", "err", openErr, "recipient_id", pid, "channel_id", p.ChannelID)
				continue
			}
			result.OpenedDMFor = append(result.OpenedDMFor, pid)
		}
	}

	slog.Debug("message sent", "user", p.Username, "channel_id", p.ChannelID, "msg_id", msgID)
	return result, nil
}

// EditMessage validates and persists a message edit.
func (s *MessageService) EditMessage(ctx context.Context, userID, msgID int64, rawContent string) (*EditMessageResult, error) {
	// Rate limit.
	ratKey := auth.Key("chat_edit", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive integer", ErrBadRequest)
	}

	content, err := sanitizeContent(rawContent, false)
	if err != nil {
		return nil, err
	}

	// Fetch message.
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrDeletedMessage)
	}

	// Channel type for DM-aware permissions.
	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	chanType := ""
	if chErr == nil && ch != nil {
		chanType = ch.Type
	}
	isDM := chanType == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, msg.ChannelID); blkErr != nil {
			return nil, blkErr
		}
	} else if permErr := s.checkSendPermission(ctx, userID, msg.ChannelID, chanType); permErr != nil {
		// An edit injects new text into the channel and is fanned out to every
		// reader, so it must clear the same gate as a send rather than
		// SEND_MESSAGES alone: READ_MESSAGES so a role locked out of a private
		// channel (the panel's "Can access" toggle denies
		// READ_MESSAGES|CONNECT_VOICE and leaves SEND_MESSAGES intact) cannot
		// rewrite its old posts, and the announcement rule so a demoted
		// moderator cannot rewrite a trusted broadcast. Mirrors DeleteMessage,
		// SetMessagePinned and handleReaction, which already require
		// READ_MESSAGES. The reason is collapsed into this sink's single opaque
		// error so the reply stays an ownership/permission non-oracle.
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// EditMessage checks ownership internally and returns the updated row via
	// RETURNING, so the edited_at the broadcast needs arrives with the write.
	msg, err = s.st.EditMessage(ctx, msgID, userID, content)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	editedAt := ""
	if msg.EditedAt != nil {
		editedAt = *msg.EditedAt
	}

	result := &EditMessageResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		Content:   content,
		EditedAt:  editedAt,
		IsDM:      isDM,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.EditMessage GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	slog.Debug("message edited", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID)
	return result, nil
}

// DeleteMessage validates and soft-deletes a message.
func (s *MessageService) DeleteMessage(ctx context.Context, userID, msgID int64) (*DeleteMessageResult, error) {
	// Rate limit.
	ratKey := auth.Key("chat_delete", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive integer", ErrBadRequest)
	}

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	var isMod bool
	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
	} else {
		// Require READ_MESSAGES alongside MANAGE_MESSAGES (and alongside
		// SEND_MESSAGES on the author path) so a role explicitly denied access to
		// a channel cannot delete messages in it. Mirrors handleReaction and
		// checkSendPermission, which both require ReadMessages for non-DM channels.
		isMsgOwner := msg.UserID == userID
		canManage := s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.ManageMessages)
		canDelete := canManage || (isMsgOwner && s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.SendMessages))
		if !canDelete {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
		// db.DeleteMessage skips the ownership check when ismod is true, so the
		// moderation flag must reuse the decision made above rather than
		// re-checking MANAGE_MESSAGES without READ_MESSAGES.
		isMod = canManage
	}

	if err := s.st.DeleteMessage(ctx, msgID, userID, isMod); err != nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	// Audit rows must survive a request canceled after the delete committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	result := &DeleteMessageResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		IsDM:      isDM,
		IsMod:     isMod,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}

// AddReaction adds a reaction to a message.
func (s *MessageService) AddReaction(ctx context.Context, userID, msgID int64, emoji string) (*ReactionResult, error) {
	return s.handleReaction(ctx, userID, msgID, emoji, true)
}

// RemoveReaction removes a reaction from a message.
func (s *MessageService) RemoveReaction(ctx context.Context, userID, msgID int64, emoji string) (*ReactionResult, error) {
	return s.handleReaction(ctx, userID, msgID, emoji, false)
}

func (s *MessageService) handleReaction(ctx context.Context, userID, msgID int64, emoji string, add bool) (*ReactionResult, error) {
	// Rate limit.
	ratKey := auth.Key("reaction", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 5, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive", ErrBadRequest)
	}
	if emoji == "" || len([]rune(emoji)) > 32 {
		return nil, fmt.Errorf("%w: invalid emoji", ErrBadRequest)
	}
	// Reject control characters.
	for _, r := range emoji {
		if r <= 0x1F || r == 0x7F {
			return nil, fmt.Errorf("%w: emoji contains control characters", ErrBadRequest)
		}
	}
	// Sanitize check.
	if sanitizer.Sanitize(emoji) != emoji {
		return nil, fmt.Errorf("%w: emoji contains unsafe content", ErrBadRequest)
	}

	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: message not found", ErrBadRequest)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot react to deleted message", ErrBadRequest)
	}

	ch, chErr := s.st.GetChannel(ctx, msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(ctx, userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: not a DM participant", ErrBadRequest)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, msg.ChannelID); blkErr != nil {
			return nil, blkErr
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, msg.ChannelID, permissions.ReadMessages|permissions.AddReactions) {
		// Require READ_MESSAGES in addition to ADD_REACTIONS so a user cannot
		// react in a channel they cannot read. Mirrors checkSendPermission,
		// which requires ReadMessages|SendMessages for non-DM sends.
		return nil, fmt.Errorf("%w: missing ADD_REACTIONS permission", ErrForbidden)
	}

	action := "add"
	if add {
		if err := s.st.AddReaction(ctx, msgID, userID, emoji); err != nil {
			slog.Warn("MessageService.AddReaction", "err", err, "msg_id", msgID, "user_id", userID)
			return nil, fmt.Errorf("%w: reaction already exists", ErrConflict)
		}
	} else {
		action = "remove"
		if err := s.st.RemoveReaction(ctx, msgID, userID, emoji); err != nil {
			slog.Warn("MessageService.RemoveReaction", "err", err, "msg_id", msgID, "user_id", userID)
			return nil, fmt.Errorf("%w: reaction not found", ErrBadRequest)
		}
	}

	result := &ReactionResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		UserID:    userID,
		Emoji:     emoji,
		Action:    action,
		IsDM:      isDM,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(ctx, msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.handleReaction GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}

// GetMessages retrieves paginated messages for a channel with permission checks.
func (s *MessageService) GetMessages(ctx context.Context, userID, channelID, before int64, limit int) ([]db.MessageAPIResponse, bool, error) {
	if channelID <= 0 {
		return nil, false, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, false, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	// Permission check.
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return nil, false, fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return nil, false, fmt.Errorf("%w: access denied", ErrForbidden)
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Fetch one extra to detect has_more.
	msgs, err := s.st.GetMessagesForAPI(ctx, channelID, before, limit+1, userID)
	if err != nil {
		slog.Error("MessageService.GetMessages", "err", err, "channel_id", channelID)
		return nil, false, fmt.Errorf("%w: failed to fetch messages", ErrInternal)
	}

	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}

	return msgs, hasMore, nil
}

// SearchMessages performs full-text search across accessible channels.
func (s *MessageService) SearchMessages(ctx context.Context, userID int64, query string, channelID *int64, limit int) ([]db.MessageSearchResult, error) {
	if query == "" {
		return nil, fmt.Errorf("%w: query cannot be empty", ErrBadRequest)
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Single-channel search.
	if channelID != nil && *channelID > 0 {
		ch, err := s.st.GetChannel(ctx, *channelID)
		if err != nil || ch == nil {
			return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
		}
		if ch.Type == "dm" {
			ok, err := s.st.IsDMParticipant(ctx, userID, *channelID)
			if err != nil || !ok {
				return nil, fmt.Errorf("%w: access denied", ErrForbidden)
			}
		} else if !s.perms.HasChannelPerm(ctx, userID, *channelID, permissions.ReadMessages) {
			return nil, fmt.Errorf("%w: access denied", ErrForbidden)
		}
		results, err := s.st.SearchMessages(ctx, query, channelID, limit)
		if err != nil {
			return nil, fmt.Errorf("%w: search failed: %v", ErrInternal, err)
		}
		return results, nil
	}

	// Global search: build accessible channel list.
	accessibleIDs, err := s.GetAccessibleChannelIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(accessibleIDs) == 0 {
		return nil, nil
	}

	results, err := s.st.SearchMessagesInChannels(ctx, query, accessibleIDs, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: search failed: %v", ErrInternal, err)
	}
	return results, nil
}

// GetPinnedMessages retrieves pinned messages for a channel.
func (s *MessageService) GetPinnedMessages(ctx context.Context, userID, channelID int64) ([]db.MessageAPIResponse, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return nil, fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages) {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	msgs, err := s.st.GetPinnedMessages(ctx, channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch pinned messages: %v", ErrInternal, err)
	}
	return msgs, nil
}

// SetMessagePinned pins or unpins a message.
func (s *MessageService) SetMessagePinned(ctx context.Context, userID, channelID, msgID int64, pinned bool) error {
	if channelID <= 0 || msgID <= 0 {
		return fmt.Errorf("%w: invalid IDs", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil || !ok {
			return fmt.Errorf("%w: access denied", ErrNotFound)
		}
		if blkErr := requireDMNotBlocked(ctx, s.st, userID, channelID); blkErr != nil {
			return blkErr
		}
	} else if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.ManageMessages) {
		// Require READ_MESSAGES alongside MANAGE_MESSAGES so a role locked out
		// of a private channel cannot mutate its pins — the admin panel's
		// "Can access" toggle denies READ_MESSAGES|CONNECT_VOICE and leaves
		// MANAGE_MESSAGES intact. Mirrors handleReaction and checkSendPermission.
		return fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}
	// Verify message belongs to this channel.
	msg, err := s.st.GetMessage(ctx, msgID)
	if err != nil || msg == nil || msg.ChannelID != channelID {
		return fmt.Errorf("%w: message not found in this channel", ErrNotFound)
	}
	return s.st.SetMessagePinned(ctx, msgID, pinned)
}

// GetAccessibleChannelIDs returns all channel IDs the user can read.
func (s *MessageService) GetAccessibleChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %v", ErrInternal, err)
	}

	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to get role: %v", ErrInternal, err)
	}

	var overrides map[int64]db.ChannelOverride
	if !permissions.HasAdmin(role.Permissions) {
		var overrideErr error
		overrides, overrideErr = s.st.GetAllChannelPermissionsForRole(ctx, role.ID)
		if overrideErr != nil {
			return nil, fmt.Errorf("%w: failed to fetch channel overrides: %v", ErrInternal, overrideErr)
		}
	}

	// Single visibility predicate shared with REST ListVisibleChannels and the
	// ws ready payload, so no site can drift.
	visibleIDs := s.perms.Checker().VisibleChannelIDs(role.Permissions, channelRefs(channels), permOverrides(overrides))
	var ids []int64
	for i := range channels {
		if visibleIDs[channels[i].ID] {
			ids = append(ids, channels[i].ID)
		}
	}

	// Also include DM channels the user participates in. Only the IDs are
	// needed here, so skip the full DM query's preview/unread work.
	dmIDs, err := s.st.GetUserDMChannelIDs(ctx, userID)
	if err == nil {
		ids = append(ids, dmIDs...)
	}

	return ids, nil
}

// CanPost reports whether userID may post into channelID, applying the same
// checks as a real message send: channel permissions via the cached checker
// for regular channels; participant membership AND block status for DMs.
// Exists so gates outside the send flow (the plugin broadcast path) share
// exactly this policy instead of hand-rolling a weaker copy.
func (s *MessageService) CanPost(ctx context.Context, userID, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return s.checkSendPermission(ctx, userID, channelID, ch.Type)
}

// checkSendPermission validates send permission for a channel of the given
// type. Announcement channels are readable by anyone with READ_MESSAGES but
// only postable by users with MANAGE_MESSAGES (posting is restricted to
// moderators/admins); all other non-DM channels require SEND_MESSAGES.
func (s *MessageService) checkSendPermission(ctx context.Context, userID, channelID int64, chanType string) error {
	isDM := chanType == "dm"
	if isDM {
		ok, err := s.st.IsDMParticipant(ctx, userID, channelID)
		if err != nil {
			return fmt.Errorf("%w: failed to check DM participation: %v", ErrInternal, err)
		}
		if !ok {
			return fmt.Errorf("%w: not a participant in this DM", ErrForbidden)
		}
		return requireDMNotBlocked(ctx, s.st, userID, channelID)
	}
	if !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ReadMessages|permissions.SendMessages) {
		return fmt.Errorf("%w: missing SEND_MESSAGES permission", ErrForbidden)
	}
	// Announcement channels: posting is restricted to users who can manage
	// messages, even though everyone with READ_MESSAGES can view them.
	if chanType == "announcement" && !s.perms.HasChannelPerm(ctx, userID, channelID, permissions.ManageMessages) {
		return fmt.Errorf("%w: announcement channels require MANAGE_MESSAGES to post", ErrForbidden)
	}
	return nil
}

// requireDMNotBlocked reports ErrBlocked when userID and the other participant
// of DM channelID have blocked each other in either direction.
//
// It is the single block-check implementation, called from every DM
// interaction sink — send, edit, react, pin and typing. Enforcing it on the
// send path alone left a blocked user an open channel to the blocker: editing
// an already-sent message fans MessageEditedDMEvent out to every participant,
// so arbitrary new text still reached the person who blocked them, and
// reactions and typing indicators did the same.
//
// Callers keep their own IsDMParticipant check. Its failure mode is
// deliberately different per sink (ErrForbidden for edit, ErrBadRequest for
// reactions, ErrNotFound for pins so a foreign DM's existence stays hidden)
// and flattening them here would change client-visible status codes.
//
// A GetDMRecipient lookup failure or a DM with no other participant is treated
// as "not blocked", carrying over the posture the send path has always had
// rather than newly failing closed on all five sinks at once.
func requireDMNotBlocked(ctx context.Context, st Store, userID, channelID int64) error {
	recipient, err := st.GetDMRecipient(ctx, channelID, userID)
	if err != nil || recipient == nil {
		return nil //nolint:nilerr // carries over checkSendPermission's posture: a lookup failure or a DM with no other participant is not a block
	}
	blocked, blkErr := st.IsEitherBlocked(ctx, userID, recipient.ID)
	if blkErr != nil {
		return fmt.Errorf("%w: failed to check block status: %v", ErrInternal, blkErr)
	}
	if blocked {
		return fmt.Errorf("%w: user is blocked", ErrBlocked)
	}
	return nil
}

// sanitizeContent validates and sanitizes message content.
func sanitizeContent(raw string, allowEmpty bool) (string, error) {
	if len(raw) > maxMessageLen*4 {
		return "", fmt.Errorf("%w: message content exceeds maximum length", ErrBadRequest)
	}
	content := sanitizer.Sanitize(raw)
	if content == "" && !allowEmpty {
		return "", fmt.Errorf("%w: message content cannot be empty", ErrBadRequest)
	}
	if utf8.RuneCountInString(content) > maxMessageLen {
		return "", fmt.Errorf("%w: message content exceeds maximum length of %d characters", ErrBadRequest, maxMessageLen)
	}
	return content, nil
}
