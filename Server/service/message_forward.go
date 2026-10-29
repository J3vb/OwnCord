package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// ForwardStore is the slice of the database ForwardMessage reads beyond Store:
// the source's own forward row (a forward of a forward keeps the original's
// fields) and the files to clone. *db.DB satisfies it. It is a slice interface
// declared here so Store, whose size is pinned, does not grow.
type ForwardStore interface {
	GetMessageForward(ctx context.Context, messageID int64) (*db.ForwardRow, error)
	ListForwardAttachments(ctx context.Context, messageID int64) ([]db.ForwardAttachment, error)
}

var _ ForwardStore = (*db.DB)(nil)

// ForwardInfo is the forward block a chat_message frame carries.
type ForwardInfo = db.ForwardInfo

// forwardDeps is what ForwardMessage needs beyond Store. store is read through
// a slice interface so Store does not grow (nil disables forwarding); uploads
// clones the files. afterClone is a test seam: called once the clones exist and
// before the read re-check and commit, so a test can delete the source or revoke
// the read in that exact window. Nil in production.
type forwardDeps struct {
	store      ForwardStore
	uploads    *UploadService
	afterClone func()
}

// forwardLimit and forwardWindow cap forwards per user: a forward fans a
// stored snapshot (and clones its files) into a channel, so it gets a tighter
// budget than a send on top of the send rate gate.
const (
	forwardLimit  = 5
	forwardWindow = 10 * time.Second
)

// ForwardParams is one forward: the message SourceMessageID is copied into
// TargetChannelID as a new message by UserID. One target per call, so each
// forward commits whole or not at all.
type ForwardParams struct {
	// ClientMessageID is required: forwards exist only for clients that retry
	// by receipt, so a lost acknowledgement never posts a second copy.
	ClientMessageID string
	UserID          int64
	Username        string
	TargetChannelID int64
	SourceMessageID int64
}

// forwardSnapshot is what the source gates produced: the message and its
// channel, the forward block the copy will carry, and the files to clone.
type forwardSnapshot struct {
	msg    *db.Message
	ch     *db.Channel
	origin db.ForwardRow
	files  []db.ForwardAttachment
}

// ForwardMessage copies a message the caller can read into a channel or DM
// they can post in, as an ordinary message by the caller carrying a
// "forwarded" marker. The text is stored as a snapshot and the files are
// cloned to the caller, so later edits or deletes of the original change
// nothing. Mentions never ping and no channel push is sent. Callers emit the
// events, exactly as for SendMessage, from the same SendMessageResult.
//
// The order is: the rate gate and a receipt lookup (a retry of an accepted
// forward is answered from its receipt before anything else), the forward
// limiter, the source read gate, the target gates, slow mode, then clone and
// commit.
func (s *MessageService) ForwardMessage(ctx context.Context, p ForwardParams) (*SendMessageResult, error) {
	ctx, done := traceCall(ctx, "service/message", "MessageService.ForwardMessage",
		telemetry.Int64("user_id", p.UserID),
		telemetry.Int64("channel_id", p.TargetChannelID),
	)
	defer done()

	if s.forward.store == nil {
		return nil, fmt.Errorf("%w: forwarding is not available", ErrInternal)
	}
	if p.ClientMessageID == "" || p.SourceMessageID <= 0 {
		return nil, fmt.Errorf("%w: client_message_id and message_id are required", ErrBadRequest)
	}
	sp := SendMessageParams{
		ClientMessageID: p.ClientMessageID, ChannelID: p.TargetChannelID,
		UserID: p.UserID, Username: p.Username, ForwardOf: p.SourceMessageID,
	}
	delivery, retry, err := s.answerSendRetry(ctx, sp)
	if err != nil || retry != nil {
		return retry, err
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("forward", p.UserID), forwardLimit, forwardWindow) {
		return nil, ErrRateLimited
	}
	snap, err := s.forwardSource(ctx, p)
	if err != nil {
		return nil, err
	}
	target, err := s.forwardTarget(ctx, sp, snap)
	if err != nil {
		return nil, err
	}
	if err := s.checkMessageSlowMode(ctx, sp, target); err != nil {
		return nil, err
	}
	return s.commitForward(ctx, p, sp, delivery, snap, target)
}

// forwardSource is gate 1: the source must be a live ordinary message in a
// channel the forwarder can read the content of. Every refusal is the same
// NOT_FOUND an unknown id gets, so a forwarder learns nothing about a message
// or channel they cannot read. It also collects the forward block (the
// original's fields when the source is itself a forward) and the files.
func (s *MessageService) forwardSource(ctx context.Context, p ForwardParams) (*forwardSnapshot, error) {
	notFound := fmt.Errorf("%w: message not found", ErrNotFound)
	msg, err := s.st.GetMessage(ctx, p.SourceMessageID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forward source: %w", ErrInternal, err)
	}
	if msg == nil || msg.Deleted || msg.Kind != db.MessageKindUser {
		return nil, notFound
	}
	ch, err := s.st.GetChannel(ctx, msg.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forward source channel: %w", ErrInternal, err)
	}
	if ch == nil {
		return nil, notFound
	}
	if err := permissions.CanReadContent(readSubject(ctx, s.st, s.perms, p.UserID, ch)); err != nil {
		return nil, notFound
	}
	// A poll cannot be forwarded (WP 6.9b): a copy would carry only the fallback
	// text and drop the voting. After the read gate, so it leaks nothing.
	if s.poll.store != nil {
		meta, err := s.poll.store.GetPollMeta(ctx, msg.ID)
		if err != nil {
			return nil, fmt.Errorf("%w: read forward source: %w", ErrInternal, err)
		}
		if meta != nil {
			return nil, fmt.Errorf("%w: a poll cannot be forwarded", ErrBadRequest)
		}
	}
	if err := s.refuseStickerMessage(ctx, msg.ID, "a sticker message cannot be forwarded"); err != nil {
		return nil, err
	}
	origin := db.ForwardRow{SourceMessageID: &msg.ID, SourceChannelID: msg.ChannelID, SourceTimestamp: msg.Timestamp}
	prior, err := s.forward.store.GetMessageForward(ctx, msg.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forward source: %w", ErrInternal, err)
	}
	if prior != nil {
		origin = *prior
		if origin.SourceMessageID != nil {
			orig, err := s.st.GetMessage(ctx, *origin.SourceMessageID)
			if err != nil {
				return nil, fmt.Errorf("%w: read forward original: %w", ErrInternal, err)
			}
			if orig == nil || orig.Deleted {
				origin.SourceMessageID = nil
			}
		}
	}
	files, err := s.forward.store.ListForwardAttachments(ctx, msg.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forward source files: %w", ErrInternal, err)
	}
	return &forwardSnapshot{msg: msg, ch: ch, origin: origin, files: files}, nil
}

// forwardTarget is gates 2 to 4: the forwarder may post in the target (the
// same predicate a send asks, so a DM block, a timeout and an archive are all
// covered), may attach files there when the source has any, and a source in a
// labelled (NSFW) channel goes only to another labelled channel, because the
// age gate is enforced per channel and a DM or an unlabelled channel would
// bypass it.
func (s *MessageService) forwardTarget(ctx context.Context, sp SendMessageParams, snap *forwardSnapshot) (*db.Channel, error) {
	target, err := s.st.GetChannel(ctx, sp.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("%w: read forward target: %w", ErrInternal, err)
	}
	if target == nil {
		return nil, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if err := s.checkSendPermission(ctx, sp.UserID, target); err != nil {
		return nil, err
	}
	isDM := target.Type == "dm"
	if !isDM && len(snap.files) > 0 && !s.perms.HasChannelPerm(ctx, sp.UserID, sp.ChannelID, permissions.AttachFiles) {
		return nil, fmt.Errorf("%w: missing ATTACH_FILES permission", ErrForbidden)
	}
	if snap.ch.NSFW && (isDM || !target.NSFW) {
		return nil, fmt.Errorf("%w: a message from a labelled channel can only be forwarded to another labelled channel", ErrForbidden)
	}
	return target, nil
}

// commitForward clones the files, re-checks read access, and commits the
// message, its forward row, its receipt and the clone links in one
// transaction (the source is re-read inside it, so a delete that commits
// first wins). Anything that fails after the clones exist discards them, which
// returns their bytes to the forwarder's quota.
func (s *MessageService) commitForward(ctx context.Context, p ForwardParams, sp SendMessageParams, delivery *db.MessageDeliveryParams, snap *forwardSnapshot, target *db.Channel) (*SendMessageResult, error) {
	var cloned *ClonedFiles
	if len(snap.files) > 0 {
		if s.forward.uploads == nil {
			return nil, fmt.Errorf("%w: file storage is not available for forwarding", ErrInternal)
		}
		var err error
		if cloned, err = s.forward.uploads.CloneAttachments(ctx, p.UserID, snap.files); err != nil {
			return nil, err
		}
	}
	committed := false
	defer func() {
		if !committed {
			cloned.Discard(ctx)
		}
	}()
	var cloneIDs []string
	if cloned != nil {
		cloneIDs = cloned.IDs
	}
	if snap.msg.Content == "" && len(cloneIDs) == 0 {
		return nil, errAllAttachmentsSkipped()
	}
	if hook := s.forward.afterClone; hook != nil {
		hook()
	}
	// Read access is asked again as late as it can be: the permission model is
	// not readable from inside the writer transaction, so this closes all but
	// the commit's own instant. The transaction re-reads the source row.
	if err := s.forwardStillReadable(ctx, p.UserID, snap.msg.ChannelID); err != nil {
		return nil, err
	}
	delivery.Content = snap.msg.Content
	delivery.AttachmentIDs = cloneIDs
	delivery.Forward = &db.ForwardRow{
		SourceMessageID: snap.origin.SourceMessageID, SourceChannelID: snap.origin.SourceChannelID,
		SourceTimestamp: snap.origin.SourceTimestamp, ForwardedID: snap.msg.ID,
	}
	sp.AttachmentIDs = cloneIDs
	// No mention set: a forward never pings, whatever @names its text holds.
	msg, attachments, _, duplicate, err := s.persistMessage(ctx, sp, snap.msg.Content, mentionSet{}, delivery)
	if err != nil {
		return nil, err
	}
	committed = !duplicate
	if duplicate {
		// Lost a race with an identical retry: the winner's clones are linked,
		// ours are surplus and the deferred Discard takes them back out.
		return &SendMessageResult{MessageID: msg.ID, Timestamp: msg.Timestamp, Duplicate: true}, nil
	}
	return s.forwardResult(ctx, sp, msg, attachments, snap, target), nil
}

// forwardStillReadable re-asks gate 1's read question for the source channel.
func (s *MessageService) forwardStillReadable(ctx context.Context, userID, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil {
		return fmt.Errorf("%w: re-read forward source channel: %w", ErrInternal, err)
	}
	if ch == nil {
		return fmt.Errorf("%w: message not found", ErrNotFound)
	}
	if err := permissions.CanReadContent(readSubject(ctx, s.st, s.perms, userID, ch)); err != nil {
		return fmt.Errorf("%w: message not found", ErrNotFound)
	}
	return nil
}

// forwardResult builds the SendMessageResult of a committed forward and runs
// its post-commit work: the DM side effects (a first-contact request is staged
// for an untrusted 1:1 recipient instead of delivering) and, for a DM target
// only, push. No mention badge and no channel push: nothing was mentioned.
func (s *MessageService) forwardResult(ctx context.Context, sp SendMessageParams, msg *db.Message, attachments []db.AttachmentInfo, snap *forwardSnapshot, target *db.Channel) *SendMessageResult {
	isDM := target.Type == "dm"
	result := &SendMessageResult{
		MessageID: msg.ID, Timestamp: msg.Timestamp, Content: snap.msg.Content,
		IsDM: isDM, Channel: target, Attachments: attachments, Mentions: []int64{},
		ThreadJoined: msg.ThreadJoined,
		Forward: &db.ForwardInfo{
			SourceChannelID: snap.origin.SourceChannelID, SourceMessageID: snap.origin.SourceMessageID,
			SourceTimestamp: snap.origin.SourceTimestamp,
		},
	}
	if !isDM {
		return result
	}
	if !s.sendMessageDMSideEffects(ctx, sp, result) {
		return result
	}
	s.pushDMParticipants(ctx, sp, result)
	slog.Debug("message forwarded", "user", sp.Username, "channel_id", sp.ChannelID, "msg_id", msg.ID)
	return result
}
