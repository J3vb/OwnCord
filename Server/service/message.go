package service

import (
	"context"
	"errors"
	"fmt"
	"html"
	"sync/atomic"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/auth"
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

// MessageService handles message business logic: send, edit, delete, reactions,
// pins and search.
type MessageService struct {
	st      Store
	perms   *PermissionService
	limiter *auth.RateLimiter
	// mentionIDs backs the <@id> and <@&id> forms; nil leaves those as plain text.
	mentionIDs MentionIDStore
	// bg runs deferred bookkeeping with no dedicated worker (Web Push, the fallback
	// mention write). The composition root installs a lifecycle-owned group via
	// SetBackground so shutdown joins it before the database closes; nil runs each
	// job on a fresh unowned group. Tests use RunBackgroundInlineForTest.
	bg       *syncutil.Group
	bgInline bool
	// mentionWorker is the single bounded worker owning every mention-badge write.
	// Nil until the composition root starts it (app.startHub); then SendMessage
	// resolves inline through bg. Atomic because it is started while other
	// goroutines may already be sending.
	mentionWorker atomic.Pointer[mentionWorker]
	// mentionEmitMu serializes each mention_count write with the frame it emits, so
	// frame order matches commit order across the worker flush and the removal paths.
	// Held across write, notify and visibility check; job resolution stays outside.
	// See mentionWorker.emitMu and reverseMentionCounts.
	mentionEmitMu syncutil.Mutex
	// readStateNotifier delivers the read_state frame MoveReadPointer sends under
	// mentionEmitMu; nil leaves it off.
	readStateNotifier ReadStateNotifier
	// liveStatus returns userID's live status, "" with no live connection. The ws
	// layer wires it (Hub.LiveStatus) so @here reads the status the member list
	// overlays (ws/serve_ready.go presentableMembers), not users.status, which keeps
	// a chosen idle/dnd/invisible across a disconnect and lags a connect by up to one
	// StampFlushInterval. Nil falls back to the row.
	liveStatus func(userID int64) string
	// messageRequests is the first-contact gate and delivery-audience filter, wired
	// by service.New(). Nil (tests and NewMessageService callers) disables the gate,
	// so 1:1 DMs behave as before it existed.
	messageRequests *MessageRequestService
	// afterFirstContactTrustCheck is a test seam called from dmFirstContactGate once
	// the recipient's trust is read false, before firstContact's insert (no exported
	// setter, like storage_quota.go's afterRecount). Nil in production.
	afterFirstContactTrustCheck func()
	// beforeRequestPreviewLookup is a test seam called right before
	// canonicalRequestPreview's DB read so a test can delete the held message in
	// that window and confirm the preview comes back nil. Nil in production.
	beforeRequestPreviewLookup func(messageID int64)
	// pushNotifier is the Web Push dispatch hook. Nil means dispatch is off
	// (push.enabled or push.dispatch_enabled false); the root installs a
	// *PushDispatcher only when both are true.
	pushNotifier PushNotifier
	// mentionNotifier delivers the per-user mention_count frame (taskbar/tray badge)
	// for each reader whose badge a mention raised. Nil (tests, no hub) pushes
	// nothing; NewHub installs the hub-backed one.
	mentionNotifier MentionCountNotifier
	// forward backs ForwardMessage (message_forward.go).
	forward forwardDeps
	// poll backs CreatePoll (message_poll.go).
	poll pollDeps
	// sticker reads a message's sticker block and a sticker's row; nil disables
	// sticker sends.
	sticker StickerStore
	// threads reads a forum post's thread for a retry; nil disables forum posts.
	threads ThreadStore
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
func NewMessageService(st Store, perms *PermissionService, limiter *auth.RateLimiter) *MessageService {
	s := &MessageService{
		st:      st,
		perms:   perms,
		limiter: limiter,
	}
	s.forward.store, _ = st.(ForwardStore)
	s.poll.store, _ = st.(PollStore)
	s.sticker, _ = st.(StickerStore)
	s.threads, _ = st.(ThreadStore)
	s.mentionIDs, _ = st.(MentionIDStore)
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

// StartMentionWorker creates and starts the bounded mention-badge worker and
// routes SendMessage's bookkeeping through it. The root calls it once
// (app.startHub); tests leave it uncalled for deterministic inline writes. ctx
// bounds the loop; the returned func drains and stops it (App.Close's job).
func (s *MessageService) StartMentionWorker(ctx context.Context) func(context.Context) {
	w := newMentionWorker(s.st)
	// Share the write+emit lock with the removal paths so a coalesced increment
	// flush cannot be overtaken by an older decrement frame, or vice versa.
	w.emitMu = &s.mentionEmitMu
	// NewHub installed the hook before this runs; nil means no hub and no pushes.
	if s.mentionNotifier != nil {
		w.notify = s.mentionNotifier.NotifyMentionCount
	}
	// Start before publishing: run sets started synchronously, so a sender seeing
	// the worker never observes it as not-started and drops a job.
	w.run(ctx)
	s.mentionWorker.Store(w)
	return w.stopAndDrain
}

func (s *MessageService) mentionWorkerForSend() *mentionWorker {
	if s == nil {
		return nil
	}
	return s.mentionWorker.Load()
}

// FlushPendingMentionCounts applies any still-queued mention-badge job for msgIDs
// before the caller reverses them. Removal paths (DeleteMessage, PurgeMessages,
// erasure) must call it first: a message removed inside the coalesce window would
// be reversed before its increment landed, and the later flush would raise a
// phantom badge or, with the liveness guard, be skipped and take a genuine badge
// with it. A no-op without a worker (the inline fallback already wrote the
// increment). ctx only bounds the wait; the worker applies jobs on its own loop
// context, so a canceled caller cannot drop the flush.
func (s *MessageService) FlushPendingMentionCounts(ctx context.Context, msgIDs []int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushMessages(ctx, msgIDs)
}

// flushChannelMentionCounts is FlushPendingMentionCounts for every queued job on
// a channel (PurgeMessages cannot name the ids until after the purge).
func (s *MessageService) flushChannelMentionCounts(ctx context.Context, channelID int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushChannel(ctx, channelID)
}

// FlushAllPendingMentionCounts applies every queued job, ignoring the coalesce
// window. Erasure calls it first since it deletes all of a user's messages and
// cannot cheaply name them. A no-op without a worker.
func (s *MessageService) FlushAllPendingMentionCounts(ctx context.Context) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushNow(ctx)
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
