package service

import (
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/microcosm-cc/bluemonday"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
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
	// DMParticipants is the full participant list of the DM, viewer-neutral:
	// it is read with viewerID 0, which matches nobody, so every status is
	// already broadcast-collapsed (an invisible participant reads as offline).
	// That is what makes it safe to reuse for every addressee — the ws layer
	// turns it into a per-recipient dm_channel_open payload without re-deriving
	// visibility. Nil when the participant read failed, in which case the
	// caller falls back to the sender-only 1:1 shape.
	DMParticipants []db.DMUser
	// DMIsGroup mirrors channels.is_group for this DM. Carried alongside the
	// participants because a group that people have left can have two members
	// and must still render as a group.
	DMIsGroup bool

	// Attachment data for broadcast.
	Attachments []db.AttachmentInfo

	// Mentions is the resolved mentioned user ids (never nil) and
	// MentionsEveryone an authorized @everyone/@here. Both are broadcast so
	// clients highlight from server-resolved data instead of re-guessing.
	Mentions         []int64
	MentionsEveryone bool
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

	// Mentions/MentionsEveryone are re-resolved from the edited content.
	Mentions         []int64
	MentionsEveryone bool
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

// PurgeMessagesResult contains the output of a successful bulk delete.
// MessageIDs is newest-first and is empty (never nil) when nothing matched.
type PurgeMessagesResult struct {
	ChannelID  int64
	MessageIDs []int64
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
