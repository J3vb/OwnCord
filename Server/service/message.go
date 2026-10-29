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
	// ErrAttachmentsUnavailable means a send had no text and none of its
	// requested attachments could be linked (swept, foreign, already linked or
	// missing). It is always wrapped together with ErrBadRequest, which it
	// refines into the ATTACHMENTS_UNAVAILABLE wire code.
	ErrAttachmentsUnavailable = errors.New("attachments unavailable")
	// ErrReactionLimit means a new emoji was refused because the message already
	// holds db.MaxDistinctReactions different ones. It is always wrapped together
	// with ErrBadRequest, which it refines into the REACTION_LIMIT wire code.
	ErrReactionLimit = errors.New("reaction limit reached")
	// ErrPollEnded means a vote or an end reached a poll that was already ended
	// or whose time ran out. It is always wrapped together with ErrBadRequest,
	// which it refines into the POLL_ENDED wire code.
	ErrPollEnded = errors.New("poll ended")
	// ErrStickerNotFound means a sticker send named a sticker that does not
	// exist (or no longer does). It is always wrapped together with
	// ErrNotFound, which it refines into the STICKER_NOT_FOUND wire code.
	ErrStickerNotFound = errors.New("sticker not found")
	// ErrTimedOut is a 403 TIMED_OUT: the actor has an active moderator
	// timeout row (B5-9) and cannot send or edit messages, add reactions,
	// join voice, start a new DM, create or rename a group DM, ring a DM
	// call, pin in a DM, or set a custom status.
	ErrTimedOut = errors.New("timed out")
	// ErrCallNeedsAcceptance refuses a 1:1 call_ring whose recipient has not
	// accepted the caller (pending, ignored or deleted request alike: one
	// answer for every untrusted state). The ring is never delivered.
	ErrCallNeedsAcceptance = errors.New("calls work after the other person accepts your message request")
)

// DMRequestPreview is the message preview a dm_request frame carries on
// creation (docs/protocol.md's dm_request section).
type DMRequestPreview struct {
	MessageID int64
	Content   string
	Timestamp string
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
	// MentionRoles lists the roles whose @role token cleared the gate; an edit
	// never raises a badge for them or anyone else.
	Mentions         []int64
	MentionRoles     []int64
	MentionsEveryone bool
	// MentionsHere: see SendMessageResult.MentionsHere.
	MentionsHere bool
	// PostOpening marks the edit of a forum post's opening message (WP 6.9d).
	PostOpening bool
}

// DeleteMessageResult contains the output of a successful message delete.
type DeleteMessageResult struct {
	MessageID int64
	ChannelID int64
	IsDM      bool
	IsMod     bool
	IsThread  bool // the message lived in a thread (its count moved)
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
	// mentionIDs backs the <@id> and <@&id> mention forms; nil when the store
	// lacks it, which leaves those tokens as plain text.
	mentionIDs MentionIDStore
	// bg runs the deferred bookkeeping that has no dedicated worker off the send
	// path: Web Push dispatch, and the fallback mention write used when no
	// mention worker is running. It runs on bg, the lifecycle-owned group the
	// composition root installs with SetBackground so shutdown joins it before
	// the database closes (ARCH-034); a nil bg runs each job on a fresh
	// unowned group (the old `go fn()`). Tests switch to inline via
	// RunBackgroundInlineForTest so they can read the results
	// deterministically right after a send.
	bg       *syncutil.Group
	bgInline bool
	// mentionWorker is the single bounded worker that owns every mention-badge
	// write (P5-O05). It is nil until the composition root starts it
	// (app.startHub); with no worker, SendMessage resolves and writes mentions
	// inline through bg, so a directly-constructed service (every test) behaves
	// as before. An atomic pointer because the composition root starts it while
	// other goroutines may already be sending.
	mentionWorker atomic.Pointer[mentionWorker]
	// mentionEmitMu serializes each mention_count write with the frame it emits,
	// so frame order matches commit order across the coalesced worker flush and
	// the removal paths (P5-O05 / DP-27 ordering). Held across the write, the
	// notify and the visibility check inside it; job resolution stays outside.
	// See mentionWorker.emitMu and reverseMentionCounts.
	mentionEmitMu syncutil.Mutex
	// readStateNotifier delivers the read_state frame MoveReadPointer sends
	// under mentionEmitMu. nil leaves it off (see SetReadStateNotifier).
	readStateNotifier ReadStateNotifier
	// liveStatus returns userID's live status, "" when they hold no live
	// connection. It is wired by the ws layer (Hub.LiveStatus) after both are
	// constructed, so @here reads the same status the member list overlays
	// (ws/serve_ready.go presentableMembers) instead of users.status, which
	// keeps a *chosen* idle/dnd/invisible across a disconnect by design
	// (StampDisconnect only ever rewrites "online" -> "offline") and lags a
	// connect by up to one batched stamp flush (StampFlushInterval). nil (the
	// zero value, e.g. in tests and any caller with no hub) falls back to the
	// row.
	liveStatus func(userID int64) string
	// messageRequests is B5-6's first-contact gate and delivery-audience
	// filter (service/message_request.go), wired by service.New(). nil (the
	// zero value — every test and any caller built via NewMessageService
	// directly instead of service.New()) disables the gate entirely: every
	// one-to-one DM behaves exactly as it did before B5-6, which is what
	// keeps the large existing body of DM tests that construct
	// *MessageService directly green without themselves wiring it.
	messageRequests *MessageRequestService
	// afterFirstContactTrustCheck is a test seam (Codex review round 2,
	// P2-8): called from dmFirstContactGate once the recipient's trust of the
	// sender (read by GetDMDeliveryTargets) is false, before firstContact's
	// insert — same package as its test,
	// no exported setter, mirroring storage_quota.go's afterRecount. Nil in
	// production.
	afterFirstContactTrustCheck func()
	// beforeRequestPreviewLookup is a test seam (Codex review round 2, P1):
	// called from dmFirstContactGate right before canonicalRequestPreview's
	// DB read, with the message id about to be looked up, so a test can
	// delete the held message in that exact window and confirm the frame's
	// preview comes back nil rather than the deleted content. Nil in
	// production.
	beforeRequestPreviewLookup func(messageID int64)
	// pushNotifier is the Web Push dispatch hook (B5-11, behind HP-5). nil
	// (the zero value) means dispatch is off — either push.enabled or
	// push.dispatch_enabled is false — and SendMessage's hook call is
	// skipped entirely. The composition root installs a *PushDispatcher
	// here only when both keys are true.
	pushNotifier PushNotifier
	// mentionNotifier is the live taskbar/tray unread-badge hook (DP-27): it
	// delivers one per-user mention_count frame per reader whose badge a
	// mention actually raised. nil (the zero value — every test and any caller
	// with no hub) means no frame is pushed, exactly the pre-DP-27 behaviour.
	// The ws layer installs the hub-backed implementation in NewHub.
	mentionNotifier MentionCountNotifier
	// forward backs ForwardMessage (WP 6.9a); see message_forward.go.
	forward forwardDeps
	// poll backs CreatePoll (WP 6.9b); see message_poll.go.
	poll pollDeps
	// sticker reads a message's sticker block and a sticker's row (WP 8.8a);
	// nil disables sticker sends.
	sticker StickerStore
	// threads reads a forum post's thread for a retry (WP 6.9d); nil disables
	// forum posts. It is the ThreadStore slice, not a Store method.
	threads ThreadStore
}

// SetMessageRequests wires the first-contact gate and delivery-audience
// filter (service.New() calls this once at startup). See messageRequests'
// doc comment for what leaving it nil means.
func (s *MessageService) SetMessageRequests(mr *MessageRequestService) {
	s.messageRequests = mr
}

// SetLiveStatusLookup wires the live-status lookup @here's offline narrowing
// reads in place of users.status. Passing nil clears it. Safe to call once at
// startup (the ws layer, after constructing both the Hub and the Services) or
// from a test.
func (s *MessageService) SetLiveStatusLookup(liveStatus func(userID int64) string) {
	s.liveStatus = liveStatus
}

// SetPushNotifier installs the Web Push dispatch hook. The composition root
// calls this once, only when both push.enabled and push.dispatch_enabled
// are true; passing nil (or never calling it) leaves dispatch off, which is
// the compiled default (TestPushDispatch_OffByDefaultSendsNothing).
func (s *MessageService) SetPushNotifier(n PushNotifier) {
	s.pushNotifier = n
}

// backgroundJobTimeout bounds each job SendMessage hands to bg (the
// no-worker mention write and Web Push dispatch), so a wedged store or push
// service cannot hold its goroutine forever. It matches Notify's own cap. A
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
// through. service.New calls it; without it a forward that carries files is
// refused.
func (s *MessageService) SetUploads(u *UploadService) { s.forward.uploads = u }

// RunBackgroundInlineForTest makes the fallback mention write (used when no
// mention worker is running) and Web Push dispatch run synchronously on the
// calling goroutine, so tests can assert on the results right after
// SendMessage returns. Test-only.
func (s *MessageService) RunBackgroundInlineForTest() {
	s.bgInline = true
}

// StartMentionWorker creates and starts the single bounded mention-badge
// worker and routes SendMessage's mention bookkeeping through it (P5-O05).
// The composition root calls it once at start-up (app.startHub); tests
// normally leave it uncalled so SendMessage resolves and writes mentions
// inline and stays deterministic. ctx bounds the worker's loop; the returned
// func drains and stops it, and is the caller's (App.Close) job.
func (s *MessageService) StartMentionWorker(ctx context.Context) func(context.Context) {
	w := newMentionWorker(s.st)
	// Share the write+emit lock with the removal paths so a coalesced increment
	// flush can never be overtaken by an older decrement frame, or vice versa
	// (DP-27 ordering). The worker's own newMentionWorker lock is discarded.
	w.emitMu = &s.mentionEmitMu
	// The live unread-badge hook is installed by NewHub before this runs, so
	// capturing it here is enough; a nil hook means no hub and no pushes.
	if s.mentionNotifier != nil {
		w.notify = s.mentionNotifier.NotifyMentionCount
	}
	// Start before publishing: run sets started synchronously, so a sender that
	// sees the worker through mentionWorkerForSend never observes it as
	// not-started and drops a job.
	w.run(ctx)
	s.mentionWorker.Store(w)
	return w.stopAndDrain
}

// mentionWorkerForSend returns the active worker, or nil when none is running.
func (s *MessageService) mentionWorkerForSend() *mentionWorker {
	if s == nil {
		return nil
	}
	return s.mentionWorker.Load()
}

// FlushPendingMentionCounts applies any still-queued mention-badge job for
// msgIDs before the caller reverses those messages' increments. A removal path
// (DeleteMessage, PurgeMessages, erasure) must call this first so the
// increment and its reversal stay symmetric: a message removed inside the
// worker's coalesce window would otherwise be reversed before its increment
// landed, and the later flush would either raise a phantom badge or (with the
// liveness guard) be skipped and take a pre-existing genuine badge with it.
//
// A no-op when no worker is running: the inline fallback writes the increment
// on the send path, so it is already on disk before any removal runs. ctx only
// bounds the wait; the worker applies the jobs against its own loop context, so
// a cancelled caller context cannot drop the flush.
func (s *MessageService) FlushPendingMentionCounts(ctx context.Context, msgIDs []int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushMessages(ctx, msgIDs)
}

// flushChannelMentionCounts is FlushPendingMentionCounts for every queued job
// on one channel — PurgeMessages' pre-purge flush, which cannot name the ids
// until after the purge has run.
func (s *MessageService) flushChannelMentionCounts(ctx context.Context, channelID int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushChannel(ctx, channelID)
}

// FlushAllPendingMentionCounts applies every queued mention-badge job,
// ignoring the coalesce window. The erasure path calls it before its own
// reversal and message deletion, since the erasure deletes all of a user's
// messages and cannot cheaply name them first (P5-O05; see
// FlushPendingMentionCounts). A no-op without a worker.
func (s *MessageService) FlushAllPendingMentionCounts(ctx context.Context) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushNow(ctx)
}

// sanitizePass is one unescape-sanitize-unescape cycle. Both unescapes are
// load-bearing; do not drop either.
//   - Inner: bluemonday's StrictPolicy treats "&lt;img ...&gt;" as inert
//     escaped text and lets it through unchanged. Unescaping first turns
//     smuggled entity-encoded markup into real markup *before* bluemonday
//     sees it, so StrictPolicy actually strips it.
//   - Outer: bluemonday writes surviving text tokens through
//     html.EscapeString (Sanitize output is always HTML-escaped), so
//     without this, plain punctuation like don't/>/"/& would be persisted
//     and rendered as literal &#39;/&gt;/&#34;/&amp; entities.
func sanitizePass(s string) string {
	return html.UnescapeString(sanitizer.Sanitize(html.UnescapeString(s)))
}

// sanitizeToFixpoint repeats sanitizePass until it stops changing the
// string. One pass is not enough on its own, for two reasons:
//   - A multiply-encoded payload like "&amp;lt;script&amp;gt;" only has its
//     outermost layer peeled by a single inner unescape, so it survives the
//     first pass as still-escaped inert text and the *outer* unescape then
//     turns the one remaining layer into a live "<script>". A second pass
//     unescapes and strips it for real.
//   - bluemonday's StrictPolicy is only self-stable in *escaped* space (its
//     tokenizer decodes entities internally while reading a text node, then
//     re-escapes uniformly on write, so Sanitize(Sanitize(x)) == Sanitize(x)
//     always held, which is why the pre-fix code's fuzz idempotency check
//     never caught this). Emitting a literal outer-unescaped "<" breaks
//     that self-stability: e.g. bluemonday tag-strips the adversarial input
//     "<<script>script>alert(1)<</script>/script>" down to escaped text
//     "&lt;/script&gt;", and one outer unescape turns that into the literal
//     substring "</script>" — inert as *this* pass's output, but a real end
//     tag if it were ever sanitized again. Looping to a fixpoint here means
//     sanitizeContent's own output is always already stable, so re-running
//     it (which the edit path effectively does, on separately-submitted
//     content) is a true no-op instead of merely "safe once".
//
// It always terminates: bluemonday only ever removes characters or shortens
// escaped entities back down, so each pass's output length is
// non-increasing. The iteration bound is a defensive backstop pathological
// input can't actually reach, not what makes this safe.
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

// SanitizeText runs raw through the same unescape-sanitize-fixpoint pipeline
// as message content and profile free-text fields (see sanitizeToFixpoint):
// it strips HTML but leaves survivors as typed instead of persisting them as
// literal &#39;/&gt;/&amp; entities the way a bare bluemonday sanitizer.Sanitize
// call would. Exported for call sites outside this package that sanitize a
// single free-text field before storage — e.g. the username field on
// registration, which must canonicalize identically to how lookups treat it.
func SanitizeText(raw string) string {
	return sanitizeToFixpoint(raw)
}

// sanitizeContent validates and sanitizes message content.
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
