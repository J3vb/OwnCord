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
	"github.com/owncord/server/store"
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
	st      store.Store
	perms   *PermissionService
	limiter *auth.RateLimiter
}

// NewMessageService creates a MessageService.
func NewMessageService(st store.Store, perms *PermissionService, limiter *auth.RateLimiter) *MessageService {
	return &MessageService{
		st:      st,
		perms:   perms,
		limiter: limiter,
	}
}

// SendMessage validates, persists, and prepares broadcast data for a new message.
// Callers are responsible for emitting the appropriate events.
func (s *MessageService) SendMessage(p SendMessageParams) (*SendMessageResult, error) {
	// Phase B Step 8 — wrap the public service entrypoint in a tracing span
	// and a duration histogram. Both are no-ops in the default build.
	ctx, span := telemetry.GlobalTracer("service/message").Start(context.Background(), "MessageService.SendMessage",
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
	ratKey := fmt.Sprintf("chat:%d", p.UserID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if p.ChannelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be a positive integer", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(p.ChannelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	isDM := ch.Type == "dm"

	// Permission check.
	if err := s.checkSendPermission(p.UserID, p.ChannelID, isDM); err != nil {
		return nil, err
	}

	// Slow mode (non-DM only).
	if !isDM && ch.SlowMode > 0 && !s.perms.HasChannelPerm(p.UserID, p.ChannelID, permissions.ManageMessages) {
		slowKey := fmt.Sprintf("slow:%d:%d", p.UserID, p.ChannelID)
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
		if !s.perms.HasChannelPerm(p.UserID, p.ChannelID, permissions.AttachFiles) {
			return nil, fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
		}
	}

	// Persist message.
	msgID, err := s.st.CreateMessage(p.ChannelID, p.UserID, content, p.ReplyTo)
	if err != nil {
		slog.Error("MessageService.SendMessage CreateMessage", "err", err)
		return nil, fmt.Errorf("%w: failed to save message", ErrInternal)
	}

	// Link attachments.
	var attachments []db.AttachmentInfo
	if len(p.AttachmentIDs) > 0 {
		linked, linkErr := s.st.LinkAttachmentsToMessage(msgID, p.AttachmentIDs)
		if linkErr != nil {
			slog.Error("MessageService.SendMessage LinkAttachments", "err", linkErr, "msg_id", msgID)
			// Cleanup: soft-delete the message.
			if delErr := s.st.DeleteMessage(msgID, p.UserID, true); delErr != nil {
				slog.Error("MessageService.SendMessage DeleteMessage (cleanup)", "err", delErr, "msg_id", msgID)
			}
			return nil, fmt.Errorf("%w: failed to send message with attachments", ErrInternal)
		}
		if linked > 0 {
			attMap, attErr := s.st.GetAttachmentsByMessageIDs([]int64{msgID})
			if attErr != nil {
				slog.Error("MessageService.SendMessage GetAttachments", "err", attErr)
			} else {
				attachments = attMap[msgID]
			}
		}
	}

	// Fetch message for timestamp.
	msg, err := s.st.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("MessageService.SendMessage GetMessage after create", "err", err)
		return nil, fmt.Errorf("%w: failed to retrieve message", ErrInternal)
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
		participantIDs, pErr := s.st.GetDMParticipantIDs(p.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.SendMessage GetDMParticipantIDs", "err", pErr, "channel_id", p.ChannelID)
			return result, nil // Message saved, skip DM side effects.
		}
		result.ParticipantIDs = participantIDs

		sender, _ := s.st.GetUserByID(p.UserID)
		result.SenderUser = sender

		for _, pid := range participantIDs {
			if pid == p.UserID {
				continue
			}
			if openErr := s.st.OpenDM(pid, p.ChannelID); openErr != nil {
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
func (s *MessageService) EditMessage(userID, msgID int64, rawContent string) (*EditMessageResult, error) {
	// Rate limit.
	ratKey := fmt.Sprintf("chat_edit:%d", userID)
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
	msg, err := s.st.GetMessage(msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrDeletedMessage)
	}

	// Channel type for DM-aware permissions.
	ch, chErr := s.st.GetChannel(msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
		}
	} else if !s.perms.HasChannelPerm(userID, msg.ChannelID, permissions.SendMessages) {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// EditMessage checks ownership internally.
	if err := s.st.EditMessage(msgID, userID, content); err != nil {
		return nil, fmt.Errorf("%w: cannot edit this message", ErrForbidden)
	}

	// Re-fetch for updated edited_at timestamp.
	msg, err = s.st.GetMessage(msgID)
	if err != nil || msg == nil {
		slog.Error("MessageService.EditMessage GetMessage after edit", "err", err, "msg_id", msgID)
		return nil, fmt.Errorf("%w: edit saved but broadcast failed", ErrInternal)
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
		participantIDs, pErr := s.st.GetDMParticipantIDs(msg.ChannelID)
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
func (s *MessageService) DeleteMessage(userID, msgID int64) (*DeleteMessageResult, error) {
	// Rate limit.
	ratKey := fmt.Sprintf("chat_delete:%d", userID)
	if s.limiter != nil && !s.limiter.Allow(ratKey, 10, time.Second) {
		return nil, ErrRateLimited
	}

	if msgID <= 0 {
		return nil, fmt.Errorf("%w: message_id must be positive integer", ErrBadRequest)
	}

	msg, err := s.st.GetMessage(msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	ch, chErr := s.st.GetChannel(msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
	} else {
		isMsgOwner := msg.UserID == userID
		canManage := s.perms.HasChannelPerm(userID, msg.ChannelID, permissions.ManageMessages)
		canDelete := canManage || (isMsgOwner && s.perms.HasChannelPerm(userID, msg.ChannelID, permissions.SendMessages))
		if !canDelete {
			return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
		}
	}

	isMod := !isDM && s.perms.HasChannelPerm(userID, msg.ChannelID, permissions.ManageMessages)
	if err := s.st.DeleteMessage(msgID, userID, isMod); err != nil {
		return nil, fmt.Errorf("%w: cannot delete this message", ErrForbidden)
	}

	slog.Debug("message deleted", "user_id", userID, "msg_id", msgID, "channel_id", msg.ChannelID, "is_mod", isMod)
	_ = s.st.LogAudit(userID, "message_delete", "message", msgID,
		fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

	result := &DeleteMessageResult{
		MessageID: msgID,
		ChannelID: msg.ChannelID,
		IsDM:      isDM,
		IsMod:     isMod,
	}

	if isDM {
		participantIDs, pErr := s.st.GetDMParticipantIDs(msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.DeleteMessage GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}

// AddReaction adds a reaction to a message.
func (s *MessageService) AddReaction(userID, msgID int64, emoji string) (*ReactionResult, error) {
	return s.handleReaction(userID, msgID, emoji, true)
}

// RemoveReaction removes a reaction from a message.
func (s *MessageService) RemoveReaction(userID, msgID int64, emoji string) (*ReactionResult, error) {
	return s.handleReaction(userID, msgID, emoji, false)
}

func (s *MessageService) handleReaction(userID, msgID int64, emoji string, add bool) (*ReactionResult, error) {
	// Rate limit.
	ratKey := fmt.Sprintf("reaction:%d", userID)
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

	msg, err := s.st.GetMessage(msgID)
	if err != nil || msg == nil {
		return nil, fmt.Errorf("%w: message not found", ErrBadRequest)
	}
	if msg.Deleted {
		return nil, fmt.Errorf("%w: cannot react to deleted message", ErrBadRequest)
	}

	ch, chErr := s.st.GetChannel(msg.ChannelID)
	isDM := chErr == nil && ch != nil && ch.Type == "dm"

	if isDM {
		ok, dmErr := s.st.IsDMParticipant(userID, msg.ChannelID)
		if dmErr != nil || !ok {
			return nil, fmt.Errorf("%w: not a DM participant", ErrBadRequest)
		}
	} else {
		if !s.perms.HasChannelPerm(userID, msg.ChannelID, permissions.AddReactions) {
			return nil, fmt.Errorf("%w: missing ADD_REACTIONS permission", ErrForbidden)
		}
	}

	action := "add"
	if add {
		if err := s.st.AddReaction(msgID, userID, emoji); err != nil {
			slog.Warn("MessageService.AddReaction", "err", err, "msg_id", msgID, "user_id", userID)
			return nil, fmt.Errorf("%w: reaction already exists", ErrConflict)
		}
	} else {
		action = "remove"
		if err := s.st.RemoveReaction(msgID, userID, emoji); err != nil {
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
		participantIDs, pErr := s.st.GetDMParticipantIDs(msg.ChannelID)
		if pErr != nil {
			slog.Error("MessageService.handleReaction GetDMParticipantIDs", "err", pErr, "channel_id", msg.ChannelID)
		} else {
			result.ParticipantIDs = participantIDs
		}
	}

	return result, nil
}

// GetMessages retrieves paginated messages for a channel with permission checks.
func (s *MessageService) GetMessages(userID, channelID, before int64, limit int) ([]db.MessageAPIResponse, bool, error) {
	if channelID <= 0 {
		return nil, false, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}

	ch, err := s.st.GetChannel(channelID)
	if err != nil || ch == nil {
		return nil, false, fmt.Errorf("%w: channel not found", ErrNotFound)
	}

	// Permission check.
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil || !ok {
			return nil, false, fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else {
		if !s.perms.HasChannelPerm(userID, channelID, permissions.ReadMessages) {
			return nil, false, fmt.Errorf("%w: access denied", ErrForbidden)
		}
	}

	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	// Fetch one extra to detect has_more.
	msgs, err := s.st.GetMessagesForAPI(channelID, before, limit+1, userID)
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
func (s *MessageService) SearchMessages(userID int64, query string, channelID *int64, limit int) ([]db.MessageSearchResult, error) {
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
		ch, err := s.st.GetChannel(*channelID)
		if err != nil || ch == nil {
			return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
		}
		if ch.Type == "dm" {
			ok, err := s.st.IsDMParticipant(userID, *channelID)
			if err != nil || !ok {
				return nil, fmt.Errorf("%w: access denied", ErrForbidden)
			}
		} else if !s.perms.HasChannelPerm(userID, *channelID, permissions.ReadMessages) {
			return nil, fmt.Errorf("%w: access denied", ErrForbidden)
		}
		results, err := s.st.SearchMessages(query, channelID, limit)
		if err != nil {
			return nil, fmt.Errorf("%w: search failed", ErrInternal)
		}
		return results, nil
	}

	// Global search: build accessible channel list.
	accessibleIDs, err := s.GetAccessibleChannelIDs(userID)
	if err != nil {
		return nil, err
	}
	if len(accessibleIDs) == 0 {
		return nil, nil
	}

	results, err := s.st.SearchMessagesInChannels(query, accessibleIDs, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: search failed", ErrInternal)
	}
	return results, nil
}

// GetPinnedMessages retrieves pinned messages for a channel.
func (s *MessageService) GetPinnedMessages(userID, channelID int64) ([]db.MessageAPIResponse, error) {
	if channelID <= 0 {
		return nil, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(channelID)
	if err != nil || ch == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil || !ok {
			return nil, fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else if !s.perms.HasChannelPerm(userID, channelID, permissions.ReadMessages) {
		return nil, fmt.Errorf("%w: access denied", ErrForbidden)
	}
	msgs, err := s.st.GetPinnedMessages(channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch pinned messages", ErrInternal)
	}
	return msgs, nil
}

// SetMessagePinned pins or unpins a message.
func (s *MessageService) SetMessagePinned(userID, channelID, msgID int64, pinned bool) error {
	if channelID <= 0 || msgID <= 0 {
		return fmt.Errorf("%w: invalid IDs", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.Type == "dm" {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil || !ok {
			return fmt.Errorf("%w: access denied", ErrNotFound)
		}
	} else if !s.perms.HasChannelPerm(userID, channelID, permissions.ManageMessages) {
		return fmt.Errorf("%w: missing MANAGE_MESSAGES permission", ErrForbidden)
	}
	// Verify message belongs to this channel.
	msg, err := s.st.GetMessage(msgID)
	if err != nil || msg == nil || msg.ChannelID != channelID {
		return fmt.Errorf("%w: message not found in this channel", ErrNotFound)
	}
	return s.st.SetMessagePinned(msgID, pinned)
}

// GetAccessibleChannelIDs returns all channel IDs the user can read.
func (s *MessageService) GetAccessibleChannelIDs(userID int64) ([]int64, error) {
	channels, err := s.st.ListChannels()
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels", ErrInternal)
	}

	role, err := s.perms.GetRoleForUser(userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to get role", ErrInternal)
	}

	isAdmin := permissions.HasAdmin(role.Permissions)
	var overrides map[int64]db.ChannelOverride
	if !isAdmin {
		var overrideErr error
		overrides, overrideErr = s.st.GetAllChannelPermissionsForRole(role.ID)
		if overrideErr != nil {
			return nil, fmt.Errorf("%w: failed to fetch channel overrides", ErrInternal)
		}
		if overrides == nil {
			overrides = make(map[int64]db.ChannelOverride)
		}
	}

	var ids []int64
	for _, ch := range channels {
		if ch.Type == "dm" {
			continue
		}
		if isAdmin {
			ids = append(ids, ch.ID)
			continue
		}
		o := overrides[ch.ID]
		effective := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
		if effective&permissions.ReadMessages == permissions.ReadMessages {
			ids = append(ids, ch.ID)
		}
	}

	// Also include DM channels the user participates in.
	dmChannels, err := s.st.GetUserDMChannels(userID)
	if err == nil {
		for _, dmc := range dmChannels {
			ids = append(ids, dmc.ChannelID)
		}
	}

	return ids, nil
}

// checkSendPermission validates send permission for DM and non-DM channels.
func (s *MessageService) checkSendPermission(userID, channelID int64, isDM bool) error {
	if isDM {
		ok, err := s.st.IsDMParticipant(userID, channelID)
		if err != nil {
			return fmt.Errorf("%w: failed to check DM participation", ErrInternal)
		}
		if !ok {
			return fmt.Errorf("%w: not a participant in this DM", ErrForbidden)
		}
		recipient, err := s.st.GetDMRecipient(channelID, userID)
		if err == nil && recipient != nil {
			blocked, blkErr := s.st.IsEitherBlocked(userID, recipient.ID)
			if blkErr != nil {
				return fmt.Errorf("%w: failed to check block status", ErrInternal)
			}
			if blocked {
				return fmt.Errorf("%w: cannot send messages — user is blocked", ErrBlocked)
			}
		}
		return nil
	}
	if !s.perms.HasChannelPerm(userID, channelID, permissions.ReadMessages|permissions.SendMessages) {
		return fmt.Errorf("%w: missing SEND_MESSAGES permission", ErrForbidden)
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
