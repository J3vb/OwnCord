package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// ─── Forum posts ────────────────────────────────────────────────
//
// A post is a thread under a forum with no starter message; its opening message
// is the thread's first message. CreateForumPost writes the thread, the
// message, the tags and the send receipt in one delivery transaction, so there
// is never a post without its opening message or the reverse.

// ForumPostParams is one forum_post_create.
type ForumPostParams struct {
	// ClientMessageID is required: a post is a send, and a lost acknowledgement
	// must never leave a second post behind.
	ClientMessageID string
	ChannelID       int64 // the forum
	UserID          int64
	Username        string
	Name            string // the title
	Content         string // raw opening message
	AttachmentIDs   []string
	TagIDs          []int64
}

// ForumPostResult is a committed (or replayed) post create.
type ForumPostResult struct {
	// Duplicate marks a retry answered from the receipt: nothing is announced.
	Duplicate bool
	MessageID int64
	// Thread is the post. Send is nil for a duplicate.
	Thread *db.ThreadInfo
	// Send is the result the chat_message and mention bookkeeping read; its
	// Channel is the post's thread row.
	Send *SendMessageResult
}

// fingerprint is the canonical JSON of the raw title and the sorted tag ids,
// which with the forum id, the raw text and the ordered uploads binds a retry to
// its receipt.
func (p ForumPostParams) fingerprint() (string, error) {
	tags := slices.Clone(p.TagIDs)
	slices.Sort(tags)
	b, err := json.Marshal(struct {
		Domain string
		Name   string
		Tags   []int64
	}{"forum_post", p.Name, tags})
	if err != nil {
		return "", fmt.Errorf("%w: fingerprint forum post: %w", ErrInternal, err)
	}
	return string(b), nil
}

// cleanPostTags validates a post's tag set against its forum: ids are positive
// and distinct, at most db.MaxPostTags, and at least one when the forum
// requires a tag. Whether each id is a tag of the forum is the writer
// transaction's check (db.ErrForumTagUnknown), so a delete that commits first
// wins. A nil forum checks the shape only (count, ids), which a caller can do
// before it has read the forum.
func cleanPostTags(forum *db.Channel, ids []int64) ([]int64, error) {
	if len(ids) > db.MaxPostTags {
		return nil, fmt.Errorf("%w: a post takes at most %d tags", ErrBadRequest, db.MaxPostTags)
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 || seen[id] {
			return nil, fmt.Errorf("%w: tag_ids must be distinct positive ids", ErrBadRequest)
		}
		seen[id] = true
	}
	if forum != nil && forum.Forum != nil && forum.Forum.RequireTag && len(ids) == 0 {
		return nil, fmt.Errorf("%w: this forum requires a tag on every post", ErrBadRequest)
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, nil
}

// forumPostError maps the delivery transaction's forum errors; the rest are
// the shared delivery mapping.
func forumPostError(err error) error {
	switch {
	case errors.Is(err, db.ErrForumGone):
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	case errors.Is(err, db.ErrForumTagUnknown):
		return fmt.Errorf("%w: unknown tag", ErrBadRequest)
	default:
		return messageDeliveryError(err)
	}
}

// CreateForumPost creates a post and its opening message as the caller. The
// send gates apply to the forum unchanged (READ and SEND, not timed out, not
// archived, ATTACH_FILES for uploads, the forum's slow mode), on top of the
// thread_create budget: a post is a thread, and one bucket stops alternating
// between the two.
//
// The order is: the chat rate gate and a receipt lookup (a retry of a committed
// post is answered before anything else), the create budget, the forum and send
// gates, validation, slow mode, then the one transaction. Callers emit the
// events from the result, as for SendMessage.
func (s *MessageService) CreateForumPost(ctx context.Context, p ForumPostParams) (*ForumPostResult, error) {
	ctx, done := traceCall(ctx, "service/message", "MessageService.CreateForumPost",
		telemetry.Int64("user_id", p.UserID),
		telemetry.Int64("channel_id", p.ChannelID),
	)
	defer done()

	if s.threads == nil {
		return nil, fmt.Errorf("%w: forums are not available", ErrInternal)
	}
	if p.ClientMessageID == "" {
		return nil, fmt.Errorf("%w: client_message_id is required", ErrBadRequest)
	}
	fp, err := p.fingerprint()
	if err != nil {
		return nil, err
	}
	sp := SendMessageParams{
		ClientMessageID: p.ClientMessageID, ChannelID: p.ChannelID, UserID: p.UserID, Username: p.Username,
		Content: p.Content, AttachmentIDs: p.AttachmentIDs, ForumPost: fp,
	}
	delivery, retry, err := s.answerSendRetry(ctx, sp)
	if err != nil {
		return nil, err
	}
	if retry != nil {
		return s.forumPostReplay(ctx, p.UserID, retry.MessageID)
	}
	// Shape checks cost no token: a malformed request never spends the budget,
	// as in ThreadService.Create. The forum-dependent ones follow the gates.
	if _, err := cleanThreadName(p.Name); err != nil {
		return nil, err
	}
	if _, err := cleanPostTags(nil, p.TagIDs); err != nil {
		return nil, err
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("thread_create", p.UserID), threadCreateLimit, threadCreateWindow) {
		return nil, ErrRateLimited
	}
	forum, in, content, err := s.forumPostGates(ctx, p)
	if err != nil {
		return nil, err
	}
	if err := s.checkMessageSlowMode(ctx, sp, forum); err != nil {
		return nil, err
	}
	mentions := s.resolveMentions(ctx, content, p.UserID, p.ChannelID, false).withReplyPing(0)
	mentions = s.loadRoleHolders(ctx, mentions, p.ChannelID)
	delivery.Content, delivery.ForumPost = content, in
	delivery.MentionedUserIDs, delivery.MentionsEveryone = mentions.UserIDs, mentions.Everyone
	delivery.MentionedRoleIDs = mentions.RoleIDs
	saved, err := s.st.CreateMessageDelivery(ctx, *delivery)
	if err != nil {
		return nil, forumPostError(err)
	}
	if saved.Duplicate {
		return s.forumPostReplay(ctx, p.UserID, saved.Message.ID)
	}
	return s.forumPostResult(ctx, sp, saved, content, mentions), nil
}

// forumPostGates is every refusal that writes nothing: the channel is a forum
// the caller may send in, the title and tags are valid, the text is sanitised,
// and uploads need ATTACH_FILES. It returns the forum, the post to write and
// the sanitised text.
func (s *MessageService) forumPostGates(ctx context.Context, p ForumPostParams) (*db.Channel, *db.ForumPostInput, string, error) {
	forum, err := s.st.GetChannel(ctx, p.ChannelID)
	if err != nil {
		return nil, nil, "", fmt.Errorf("%w: load forum: %w", ErrInternal, err)
	}
	if forum == nil || forum.Type == "dm" {
		return nil, nil, "", fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if err := s.checkSendVerdict(ctx, p.UserID, forum); err != nil {
		return nil, nil, "", err
	}
	if forum.Type != db.ForumTypeName {
		return nil, nil, "", fmt.Errorf("%w: posts are created in forum channels", ErrBadRequest)
	}
	name, err := cleanThreadName(p.Name)
	if err != nil {
		return nil, nil, "", err
	}
	tags, err := cleanPostTags(forum, p.TagIDs)
	if err != nil {
		return nil, nil, "", err
	}
	content, err := sanitizeContent(p.Content, len(p.AttachmentIDs) > 0)
	if err != nil {
		return nil, nil, "", err
	}
	if len(p.AttachmentIDs) > 0 && !s.perms.HasChannelPerm(ctx, p.UserID, p.ChannelID, permissions.AttachFiles) {
		return nil, nil, "", fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
	}
	minutes := DefaultForumAutoArchiveMinutes
	if forum.Forum != nil && forum.Forum.DefaultAutoArchiveMinutes != 0 {
		minutes = forum.Forum.DefaultAutoArchiveMinutes
	}
	return forum, &db.ForumPostInput{Name: name, AutoArchiveMinutes: minutes, TagIDs: tags}, content, nil
}

// DefaultForumAutoArchiveMinutes is the idle period of a post in a forum whose
// settings name none (the column default, migration 075).
const DefaultForumAutoArchiveMinutes = 4320

// forumPostReplay answers a retry of a committed post: the receipt names the
// opening message, whose channel is the post. The thread is read as it is now,
// but only for a caller who can still see the forum: one who has lost it gets
// the acknowledgement without the thread body, as ThreadService.Create does.
func (s *MessageService) forumPostReplay(ctx context.Context, userID, messageID int64) (*ForumPostResult, error) {
	msg, err := s.st.GetMessage(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forum post: %w", ErrInternal, err)
	}
	if msg == nil || msg.Deleted {
		return nil, ErrDeletedMessage
	}
	t, err := s.threads.GetThread(ctx, msg.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forum post: %w", ErrInternal, err)
	}
	if t == nil {
		return nil, ErrDeletedMessage
	}
	if !s.canViewForum(ctx, userID, t.ParentID) {
		return &ForumPostResult{Duplicate: true, MessageID: messageID}, nil
	}
	return &ForumPostResult{Duplicate: true, MessageID: messageID, Thread: t}, nil
}

// canViewForum reports whether the user can still see the forum. Any read
// failure answers false: the caller then gets the bare acknowledgement.
func (s *MessageService) canViewForum(ctx context.Context, userID, forumID int64) bool {
	forum, err := s.st.GetChannel(ctx, forumID)
	if err != nil || forum == nil {
		return false
	}
	sub, err := channelSubject(ctx, s.st, s.perms, userID, forum, false)
	return err == nil && permissions.CanViewChannel(sub) == nil
}

// forumPostResult builds the result of a committed post and runs its
// post-commit work on the uncancellable tail: attachments read-back, mention
// badges and push, all addressed to the post's thread.
func (s *MessageService) forumPostResult(ctx context.Context, sp SendMessageParams, saved *db.MessageDelivery, content string, mentions mentionSet) *ForumPostResult {
	bgCtx := context.WithoutCancel(ctx)
	msg, thread := saved.Message, saved.Thread
	var attachments []db.AttachmentInfo
	if len(sp.AttachmentIDs) > 0 {
		m, err := s.st.GetAttachmentsByMessageIDs(bgCtx, []int64{msg.ID})
		if err != nil {
			slog.Error("forum post attachments lookup", "err", err, "msg_id", msg.ID)
		}
		attachments = m[msg.ID]
	}
	postCh, err := s.st.GetChannel(bgCtx, thread.ID)
	if err != nil || postCh == nil {
		slog.Error("forum post channel lookup", "err", err, "thread_id", thread.ID)
		postCh = &db.Channel{ID: thread.ID, Type: "thread", Thread: db.ChannelThread{ParentID: thread.ParentID}}
	}
	send := &SendMessageResult{
		MessageID: msg.ID, Timestamp: msg.Timestamp, Content: content, Channel: postCh,
		Attachments: attachments, SkippedAttachmentIDs: skippedAttachmentIDs(sp.AttachmentIDs, saved.LinkedAttachmentIDs),
	}
	mentions.fill(send)
	threadID, authorID := thread.ID, sp.UserID
	if mentions.pings() {
		s.dispatchMentionBadges(bgCtx, mentionJob{
			enqueueAt: time.Now(), channelID: threadID, msgID: msg.ID,
			apply: func(ctx context.Context) []db.MentionBatchEntry {
				return s.mentionEntries(ctx, threadID, msg.ID, authorID, mentions, false, nil)
			},
		})
	}
	if s.pushNotifier != nil {
		candidates := mentions.reachIDs()
		s.runBackground(bgCtx, "push dispatch", func(ctx context.Context) {
			ctx, cancel := context.WithTimeout(ctx, backgroundJobTimeout)
			defer cancel()
			s.pushNotifier.Notify(ctx, threadID, authorID, candidates)
		})
	}
	slog.Debug("forum post created", "user", sp.Username, "forum_id", sp.ChannelID, "thread_id", threadID, "msg_id", msg.ID)
	return &ForumPostResult{MessageID: msg.ID, Thread: thread, Send: send}
}

// isPostOpening reports whether msgID is the opening message of the forum post
// ch: an edit of it changes the preview the forum list shows, so the
// post's viewers hear a thread_changed. A read failure answers false; the
// edit is already committed and the list catches up on the next change.
func (s *MessageService) isPostOpening(ctx context.Context, ch *db.Channel, msgID int64) bool {
	if s.threads == nil || !ch.IsThread() {
		return false
	}
	// Only a forum's posts have an opening message: a parent-type read is
	// cheaper than the thread read with its post block, and most edits are not
	// in a thread at all.
	parent, err := s.st.GetChannel(ctx, ch.Thread.ParentID)
	if err != nil || parent == nil || parent.Type != db.ForumTypeName {
		return false
	}
	t, err := s.threads.GetThread(ctx, ch.ID)
	return err == nil && t != nil && t.Post != nil && t.Post.FirstMessage != nil && t.Post.FirstMessage.ID == msgID
}
