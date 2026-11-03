package service

import (
	"context"
	"errors"
	"fmt"
	"html"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/microcosm-cc/bluemonday"
)

// sanitizer is the shared HTML policy (strips all tags).
var sanitizer = bluemonday.StrictPolicy()

const maxMessageLen = 4000

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
	// ErrAttachmentsUnavailable means a send had no text and none of its attachments
	// could be linked. Always wrapped with ErrBadRequest, refining it into the
	// ATTACHMENTS_UNAVAILABLE wire code.
	ErrAttachmentsUnavailable = errors.New("attachments unavailable")
	// ErrReactionLimit means the message already holds db.MaxDistinctReactions emoji.
	// Wrapped with ErrBadRequest; wire code REACTION_LIMIT.
	ErrReactionLimit = errors.New("reaction limit reached")
	// ErrPollEnded means a vote or end reached an ended or expired poll. Wrapped
	// with ErrBadRequest; wire code POLL_ENDED.
	ErrPollEnded = errors.New("poll ended")
	// ErrStickerNotFound means a sticker send named a missing sticker. Wrapped with
	// ErrNotFound; wire code STICKER_NOT_FOUND.
	ErrStickerNotFound = errors.New("sticker not found")
	// ErrTimedOut is a 403 TIMED_OUT: the actor has an active moderator timeout and
	// cannot send, edit, react, join voice, start a DM, create or rename a group DM,
	// ring a DM call, pin in a DM, or set a custom status.
	ErrTimedOut = errors.New("timed out")
	// ErrCallNeedsAcceptance refuses a 1:1 call_ring whose recipient has not accepted
	// the caller (pending, ignored or deleted alike: one answer for every untrusted
	// state). The ring is never delivered.
	ErrCallNeedsAcceptance = errors.New("calls work after the other person accepts your message request")
)

// DMRequestPreview is the message preview a dm_request frame carries
// (docs/protocol.md).
type DMRequestPreview struct {
	MessageID int64
	Content   string
	Timestamp string
}

// EditMessageResult is the output of a successful edit.
type EditMessageResult struct {
	MessageID      int64
	ChannelID      int64
	Content        string
	EditedAt       string
	IsDM           bool
	ParticipantIDs []int64

	// Mentions/MentionsEveryone are re-resolved from the edited content; an edit
	// never raises a badge.
	Mentions         []int64
	MentionRoles     []int64
	MentionsEveryone bool
	// MentionsHere: see SendMessageResult.MentionsHere.
	MentionsHere bool
	// PostOpening marks the edit of a forum post's opening message.
	PostOpening bool
}

// DeleteMessageResult is the output of a successful delete.
type DeleteMessageResult struct {
	MessageID      int64
	ChannelID      int64
	IsDM           bool
	IsMod          bool
	IsThread       bool // the message lived in a thread (its count moved)
	ParticipantIDs []int64
}

// PurgeMessagesResult is the output of a bulk delete. MessageIDs is newest-first
// and empty (never nil) when nothing matched.
type PurgeMessagesResult struct {
	ChannelID  int64
	MessageIDs []int64
}

// ReactionResult is the output of a reaction add/remove.
type ReactionResult struct {
	MessageID      int64
	ChannelID      int64
	UserID         int64
	Emoji          string
	Action         string // "add" or "remove"
	IsDM           bool
	ParticipantIDs []int64
}

// messageStore is what MessageService reads and writes. *db.DB satisfies it.
type messageStore interface {
	db.Auditor
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	CreateMessageWithMentions(ctx context.Context, channelID, userID int64, content string, replyTo *int64, mentionedUserIDs []int64, replyPingUserID int64, mentionsEveryone bool, mentionedRoleIDs []int64) (*db.Message, error)
	FindMessageDelivery(ctx context.Context, p db.MessageDeliveryParams) (*db.MessageDelivery, error)
	CreateMessageDelivery(ctx context.Context, p db.MessageDeliveryParams) (*db.MessageDelivery, error)
	MessageDeliveryFloorMS() int64
	GetMessage(ctx context.Context, id int64) (*db.Message, error)
	EditMessage(ctx context.Context, id, userID int64, content string) (*db.Message, error)
	DeleteMessage(ctx context.Context, id, userID int64, isMod bool) error
	AddReaction(ctx context.Context, messageID, userID int64, emoji string) error
	RemoveReaction(ctx context.Context, messageID, userID int64, emoji string) error
	ReplaceMessageMentions(ctx context.Context, messageID int64, mentionedUserIDs []int64, mentionsEveryone bool, mentionedRoleIDs []int64) (replyPingUserID int64, err error)
	LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) ([]string, error)
	GetAttachmentsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]db.AttachmentInfo, error)
	GetReferencedMessages(ctx context.Context, channelID int64, ids []int64) (map[int64]*db.ReferencedMessage, error)
}

// messageServiceStore is everything NewMessageService hands out: the write
// path's own interface plus each part's.
type messageServiceStore interface {
	messageStore
	messageReadStore
	mentionStateStore
	dmDeliveryStore
	messagePinStore
	messageRemovalStore
}

// MessageService handles message business logic: send, edit, delete, reactions,
// pins and search.
type MessageService struct {
	// The read side, the mention and read-state writes, DM delivery, pins and
	// removal each take their own store interface; their methods are promoted onto
	// MessageService, so callers see one service.
	*messageReads
	*mentionState
	*dmDelivery
	*messagePins
	*messageRemoval

	// st is what the write path itself calls: send, edit, forward, polls and
	// reactions.
	st      messageStore
	perms   *PermissionService
	limiter *auth.RateLimiter
	// bg runs deferred bookkeeping with no dedicated worker (Web Push, the fallback
	// mention write). The composition root installs a lifecycle-owned group via
	// SetBackground so shutdown joins it before the database closes; nil runs each
	// job on a fresh unowned group. Tests use RunBackgroundInlineForTest.
	bg       *syncutil.Group
	bgInline bool
	// pushNotifier is the Web Push dispatch hook. Nil means dispatch is off
	// (push.enabled or push.dispatch_enabled false); the root installs a
	// *PushDispatcher only when both are true.
	pushNotifier PushNotifier
	// forward backs ForwardMessage (message_forward.go).
	forward forwardDeps
	// poll backs CreatePoll (message_poll.go).
	poll pollDeps
	// sticker reads a message's sticker block and a sticker's row; nil disables
	// sticker sends.
	sticker StickerStore
	// threads reads a forum post's thread for a retry; nil disables forum posts.
	threads ThreadStore
	// storedMentions backs AfterAttachmentRemoved; nil reports no stored mentions.
	storedMentions StoredMentionStore
	// afterRemovalRead is a test seam called after AfterAttachmentRemoved reads the
	// message and before it deletes. Nil in production.
	afterRemovalRead func()
}

// SetMessageRequests wires the first-contact gate (service.New() calls it once);
// see messageRequests for what nil means.
func (s *MessageService) SetMessageRequests(mr *MessageRequestService) {
	s.messageRequests = mr
}

// SetLiveStatusLookup wires the live-status lookup @here's offline narrowing
// reads in place of users.status; nil clears it. Call once at startup or from a
// test.
func (s *MessageService) SetLiveStatusLookup(liveStatus func(userID int64) string) {
	s.liveStatus = liveStatus
}

// SetPushNotifier installs the Web Push dispatch hook. The root calls it once,
// only when both push.enabled and push.dispatch_enabled are true; nil leaves
// dispatch off (the compiled default).
func (s *MessageService) SetPushNotifier(n PushNotifier) {
	s.pushNotifier = n
}

// backgroundJobTimeout bounds each job SendMessage hands to bg so a wedged store
// or push service cannot hold its goroutine forever. Matches Notify's own cap; a
// var so tests can shorten it.
var backgroundJobTimeout = pushDispatchTimeout

// NewMessageService creates a MessageService.
func NewMessageService(st messageServiceStore, perms *PermissionService, limiter *auth.RateLimiter) *MessageService {
	mentions := newMentionState(st, perms)
	dm := &dmDelivery{st: st}
	s := &MessageService{
		messageReads:   newMessageReads(st, perms),
		mentionState:   mentions,
		dmDelivery:     dm,
		messagePins:    &messagePins{st: st, perms: perms, limiter: limiter, dm: dm},
		messageRemoval: newMessageRemoval(st, perms, limiter, mentions, dm),
		st:             st,
		perms:          perms,
		limiter:        limiter,
	}
	s.forward.store, _ = st.(ForwardStore)
	s.poll.store, _ = st.(PollStore)
	s.sticker, _ = st.(StickerStore)
	s.threads, _ = st.(ThreadStore)
	s.storedMentions, _ = st.(StoredMentionStore)
	return s
}

// SetUploads gives the service the upload service a forward clones files
// through; without it a forward carrying files is refused.
func (s *MessageService) SetUploads(u *UploadService) { s.forward.uploads = u }

// RunBackgroundInlineForTest runs the fallback mention write and Web Push
// dispatch synchronously so tests can assert right after SendMessage. Test-only.
func (s *MessageService) RunBackgroundInlineForTest() {
	s.bgInline = true
}

// sanitizePass is one unescape-sanitize-unescape cycle; both unescapes are
// load-bearing.
//   - Inner: StrictPolicy lets "&lt;img ...&gt;" through as inert escaped text, so
//     unescaping first turns smuggled entity-encoded markup into real markup
//     that it then strips.
//   - Outer: Sanitize output is always HTML-escaped, so without this plain
//     punctuation like don't/>/"/& would be stored as literal &#39;/&gt;/&#34;/&amp;.
func sanitizePass(s string) string {
	return html.UnescapeString(sanitizer.Sanitize(html.UnescapeString(s)))
}

// sanitizeToFixpoint repeats sanitizePass until the string stops changing. One
// pass is not enough:
//   - A multiply-encoded payload like "&amp;lt;script&amp;gt;" has only its
//     outermost layer peeled by the inner unescape, and the outer unescape then
//     turns the remaining layer into a live "<script>". A second pass strips it.
//   - StrictPolicy is self-stable only in escaped space, and emitting a literal
//     outer-unescaped "<" breaks that: it tag-strips
//     "<<script>script>alert(1)<</script>/script>" to escaped "&lt;/script&gt;",
//     which one outer unescape turns into a literal "</script>", inert now but a
//     real end tag if sanitized again. Looping to a fixpoint makes
//     sanitizeContent's output stable, so re-sanitizing on edit is a true no-op.
//
// It always terminates: each pass's output length is non-increasing. The
// iteration bound is a backstop pathological input cannot reach.
func sanitizeToFixpoint(raw string) string {
	s := raw
	for i := 0; i <= len(raw); i++ {
		next := sanitizePass(s)
		if next == s {
			return next
		}
		s = next
	}
	return s
}

// SanitizeText runs raw through the message-content pipeline (see
// sanitizeToFixpoint): it strips HTML but leaves survivors as typed rather than
// as literal &#39;/&gt;/&amp; entities. Exported for call sites outside this
// package, e.g. registration's username, which must canonicalize as lookups do.
func SanitizeText(raw string) string {
	return sanitizeToFixpoint(raw)
}

// SanitizeImportedContent applies a sent message's sanitizer and length limit,
// cutting over-long text with an ellipsis instead of refusing it.
func SanitizeImportedContent(raw string) string {
	// The raw-byte guard in front of the quadratic sanitizer: cut first.
	cut := len(raw) > maxMessageLen*4
	if cut {
		raw = strings.ToValidUTF8(raw[:maxMessageLen*4], "")
	}
	content := sanitizeToFixpoint(raw)
	if n := utf8.RuneCountInString(content); n > maxMessageLen {
		content = string([]rune(content)[:maxMessageLen-1]) + "…"
	} else if cut && n > 0 {
		content = string([]rune(content)[:min(n, maxMessageLen-1)]) + "…"
	}
	return content
}

func sanitizeContent(raw string, allowEmpty bool) (string, error) {
	if len(raw) > maxMessageLen*4 {
		return "", fmt.Errorf("%w: message content exceeds maximum length", ErrBadRequest)
	}
	content := sanitizeToFixpoint(raw)
	if content == "" && !allowEmpty {
		return "", fmt.Errorf("%w: message content cannot be empty", ErrBadRequest)
	}
	if utf8.RuneCountInString(content) > maxMessageLen {
		return "", fmt.Errorf("%w: message content exceeds maximum length of %d characters", ErrBadRequest, maxMessageLen)
	}
	return content, nil
}
