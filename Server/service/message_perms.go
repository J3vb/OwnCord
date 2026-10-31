package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// GetAccessibleChannelIDs returns all channel IDs the user can read.
func (s *messageReads) GetAccessibleChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}

	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to get role: %w", ErrInternal, err)
	}

	grants := permissions.MemberGrants{Perms: role.Perms}
	if !permissions.HasAdmin(role.Perms) {
		var overrideErr error
		grants, overrideErr = s.st.GetMemberGrants(ctx, userID)
		if overrideErr != nil {
			return nil, fmt.Errorf("%w: failed to fetch channel overrides: %w", ErrInternal, overrideErr)
		}
		grants.Perms = role.Perms
	}

	// Single visibility predicate shared with REST ListVisibleChannels and the ws
	// ready payload, so no site can drift.
	visibleIDs := s.perms.Checker().VisibleChannelIDs(grants, channelRefs(channels))
	var ids []int64
	for i := range channels {
		if visibleIDs[channels[i].ID] {
			ids = append(ids, channels[i].ID)
		}
	}

	// Include the user's DM channels; only IDs are needed, so skip the full DM
	// query's preview/unread work. A failed lookup must not silently shrink the set
	// to guild channels: SearchMessages (message_query.go) treats this list as
	// authoritative and would report a DM-stripped result instead of failing (as the
	// ws sibling computeAllowedChannels does).
	dmIDs, err := s.st.GetUserDMChannelIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch DM channels: %w", ErrInternal, err)
	}
	ids = append(ids, dmIDs...)

	return ids, nil
}

// ReadableChannelIDs is GetAccessibleChannelIDs narrowed to CONTENT: the visible
// set minus any labelled channel the user has not acknowledged. It backs
// SearchMessages' global branch, so a hit in an unacknowledged labelled channel is
// absent rather than returned. The acknowledgement lookup runs only per labelled
// channel in the visible set.
func (s *messageReads) ReadableChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
	ids, err := s.GetAccessibleChannelIDs(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return ids, nil
	}

	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}
	nsfwByID := make(map[int64]bool, len(channels))
	for i := range channels {
		if channels[i].NSFW {
			nsfwByID[channels[i].ID] = true
		}
	}
	if len(nsfwByID) == 0 {
		return ids, nil
	}

	readable := ids[:0]
	for _, id := range ids {
		if !nsfwByID[id] {
			readable = append(readable, id)
			continue
		}
		// Fail closed: a lookup failure counts as unacknowledged.
		ok, ackErr := s.st.HasNSFWAcknowledgement(ctx, userID, id)
		if ackErr == nil && ok {
			readable = append(readable, id)
		}
	}
	return readable, nil
}

// CanPost reports whether userID may post into channelID with the same checks as
// a real send (channel permissions; DM membership and block status), so gates
// outside the send flow (the plugin broadcast path) share this policy.
func (s *MessageService) CanPost(ctx context.Context, userID, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return s.checkSendPermission(ctx, userID, ch)
}

// ChannelIsDM reports whether channelID is a DM. The plugin broadcast path
// (ws/handlers_command.go) uses it to pick the sender-aware DM audience: a slash
// command's broadcast is a DM interaction and must not bypass the first-contact
// gate via channel fan-out.
func (s *messageReads) ChannelIsDM(ctx context.Context, channelID int64) (bool, error) {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil {
		return false, err
	}
	if ch == nil {
		return false, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return ch.Type == "dm", nil
}

// checkSendPermission is permissions.CanSendMessage over the resolved subject:
// READ|SEND, MANAGE_MESSAGES for announcement channels, never into an archive;
// DM membership and no block. SendMessage, EditMessage, CanPost and typing all
// ask this one predicate.
func (s *MessageService) checkSendPermission(ctx context.Context, userID int64, ch *db.Channel) error {
	if err := s.checkSendVerdict(ctx, userID, ch); err != nil {
		return err
	}
	// A forum holds no messages: its posts are threads, created through the forum
	// post path (checkSendVerdict alone). Refused after the permission verdict so a
	// caller who cannot read the forum learns nothing about its type; the messages
	// trigger (migration 075) is the schema backstop.
	if ch.Type == db.ForumTypeName {
		return fmt.Errorf("%w: a forum holds no messages, post in one of its posts", ErrBadRequest)
	}
	return nil
}

// checkSendVerdict is CanSendMessage over ch for userID mapped onto service
// errors: the part of checkSendPermission a forum post create shares.
func (s *MessageService) checkSendVerdict(ctx context.Context, userID int64, ch *db.Channel) error {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if err != nil {
		return err
	}
	return denial(permissions.CanSendMessage(sub))
}

// subjectStore is what channelSubject and readSubject read beyond the permission service.
type subjectStore interface {
	dmReachStore
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error)
}

// channelSubject resolves what the channel predicates need for userID in ch: role
// bits, both override layers, the channel's flags, and for a DM its membership
// and, when withBlock is set, the block state. A perms.Subject failure (timeout
// lookup included) is PROPAGATED, not collapsed into a zero Subject: that fails
// closed for a non-DM channel, but a DM's CanSendMessage/CanAddReaction consult
// DMParticipant/DMBlocked/TimedOut, not RolePerms, so a substituted
// TimedOut=false would let a DM message or reaction through while the timeout
// state was unknown. Every caller fails closed on this error.
func channelSubject(ctx context.Context, st subjectStore, perms *PermissionService, userID int64, ch *db.Channel, withBlock bool) (permissions.Subject, error) {
	sub, err := perms.Subject(ctx, userID, ch.ID)
	if err != nil {
		return permissions.Subject{}, fmt.Errorf("%w: failed to resolve permissions: %w", ErrInternal, err)
	}
	sub.Channel = permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived,
		AuthorityID: ch.Thread.ParentID, ThreadLocked: ch.Thread.Locked}
	if ch.Type != "dm" {
		return sub, nil
	}
	ok, dmErr := st.IsDMParticipant(ctx, userID, ch.ID)
	if dmErr != nil {
		return sub, fmt.Errorf("%w: failed to check DM participation: %w", ErrInternal, dmErr)
	}
	sub.DMParticipant = ok
	if ok && withBlock {
		switch blkErr := RequireDMReachable(ctx, storeDMReader{st}, userID, ch.ID); {
		case errors.Is(blkErr, ErrBlocked):
			sub.DMBlocked = true
		case blkErr != nil:
			return sub, blkErr
		}
	}
	return sub, nil
}

// denial maps a predicate verdict onto service errors: a block is ErrBlocked (its
// own client-visible code), everything else ErrForbidden with the predicate's reason.
func denial(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, permissions.ErrBlocked):
		return fmt.Errorf("%w: %s", ErrBlocked, dmUnreachableText)
	case errors.Is(err, permissions.ErrTimedOut):
		return fmt.Errorf("%w: user is timed out", ErrTimedOut)
	default:
		return fmt.Errorf("%w: %w", ErrForbidden, err)
	}
}

// requireNotTimedOut is CanSendMessage's timeout clause for writes a timeout
// refuses that have no channel predicate: creating a DM or group DM, renaming a
// group DM, ringing a DM call, pinning in a DM, setting a custom status.
// Administrators are exempt, as for a send.
func requireNotTimedOut(ctx context.Context, perms *PermissionService, userID int64) error {
	sub, err := perms.Subject(ctx, userID, 0)
	if err != nil {
		return fmt.Errorf("%w: failed to resolve permissions: %w", ErrInternal, err)
	}
	if sub.TimedOut {
		return denial(permissions.ErrTimedOut)
	}
	return nil
}

// readSubject resolves what CanReadContent needs for userID in ch. Unlike
// channelSubject, a DM lookup failure folds into "not a participant" so an
// outsider learns nothing about a DM's existence even on a transient failure.
//
// Archived is deliberately NOT propagated into Channel: docs/protocol.md
// documents "History stays readable" for an archived channel, CanViewChannel
// (called first by CanReadContent) refuses an archived channel outright, and this
// read gate must not withdraw that guarantee. Only the WRITE gate
// (requireChannelWritable) and the visibility/audience predicates see the flag.
//
// The NSFW acknowledgement is resolved live (never cached), only for a labelled
// channel.
func readSubject(ctx context.Context, st subjectStore, perms *PermissionService, userID int64, ch *db.Channel) permissions.Subject {
	sub, err := perms.Subject(ctx, userID, ch.ID)
	if err != nil {
		sub = permissions.Subject{}
	}
	sub.Channel = permissions.ChannelRef{ID: ch.ID, Type: ch.Type, NSFW: ch.NSFW, AuthorityID: ch.Thread.ParentID}
	switch {
	case ch.Type == "dm":
		ok, dmErr := st.IsDMParticipant(ctx, userID, ch.ID)
		sub.DMParticipant = dmErr == nil && ok
	case ch.NSFW:
		ok, ackErr := st.HasNSFWAcknowledgement(ctx, userID, ch.ID)
		sub.NSFWAcknowledged = ackErr == nil && ok
	}
	return sub
}

// readContentDenial maps a CanReadContent verdict onto service errors.
// ErrNotDMParticipant becomes ErrNotFound ("a DM an outsider is not in does not
// exist"); ErrNSFWUnacknowledged wraps both ErrForbidden (ordinary FORBIDDEN
// handling) and the permissions sentinel (so callers can match
// NSFW_ACKNOWLEDGEMENT_REQUIRED); everything else is ErrForbidden with the
// predicate's reason.
func readContentDenial(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, permissions.ErrNotDMParticipant):
		return fmt.Errorf("%w: access denied", ErrNotFound)
	case errors.Is(err, permissions.ErrNSFWUnacknowledged):
		return fmt.Errorf("%w: %w", ErrForbidden, permissions.ErrNSFWUnacknowledged)
	default:
		return fmt.Errorf("%w: %w", ErrForbidden, err)
	}
}

// requireChannelWritable refuses a write against an archived non-DM channel.
// Archived was once consulted only by the visibility predicate, which hid a
// channel without protecting it: a custom client, or a stock client racing the
// archiving channel_delete, could keep writing to an archive. History stays
// readable. DMs have no archive flag and are exempt; ch == nil is "nothing to
// check" and the caller's own nil handling decides. It is the single gate for
// every write sink: checkSendPermission (so SendMessage, EditMessage, CanPost),
// plus DeleteMessage, handleReaction, SetMessagePinned and PurgeMessages, which
// call it directly.
func requireChannelWritable(ch *db.Channel) error {
	if ch == nil || ch.Type == "dm" || !ch.Archived {
		return nil
	}
	return fmt.Errorf("%w: channel is archived", ErrForbidden)
}

// dmUnreachableText is the one sentence every refused 1:1 interaction carries,
// so the sender cannot tell the causes apart.
const dmUnreachableText = "you can't message this user"

// DMBlockReader is the read set the 1:1 reachability check needs; Store and
// consumer-side seams (ws.DispatchReader) satisfy it.
type DMBlockReader interface {
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMRecipient(ctx context.Context, channelID, userID int64) (*db.User, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
	DMRefusesSender(ctx context.Context, recipientID, senderID int64) (bool, error)
}

// DMPrivacyReader is the privacy read the check adds. It is deliberately not part
// of Store (the Store method ratchet); storeDMReader reaches it from a store.
type DMPrivacyReader interface {
	DMRefusesSender(ctx context.Context, recipientID, senderID int64) (bool, error)
}

// dmReachStore is the part of DMBlockReader a store serves directly.
type dmReachStore interface {
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMRecipient(ctx context.Context, channelID, userID int64) (*db.User, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
}

// storeDMReader lets a store stand in as a DMBlockReader. A store without
// DMPrivacyReader (a test double) fails closed with an error rather than skipping
// the check.
type storeDMReader struct{ dmReachStore }

func (r storeDMReader) DMRefusesSender(ctx context.Context, recipientID, senderID int64) (bool, error) {
	p, ok := r.dmReachStore.(DMPrivacyReader)
	if !ok {
		return false, errors.New("store has no DM privacy read")
	}
	return p.DMRefusesSender(ctx, recipientID, senderID)
}

// RequireDMReachable reports ErrBlocked when userID cannot reach the other
// participant of DM channelID: they blocked each other in either direction, or
// the other participant turned off DMs from members and does not trust userID
// (trusted_senders, any source). Both causes return the same error.
//
// It is the single block-check implementation, called from every DM sink (send,
// edit, react, pin, typing, call rings via DMService.RingTargets) and from voice
// join/token-refresh (ws/voice_join.go); st only needs to be a DMBlockReader.
// Enforcing it on send alone left a blocked user an open channel: an edit fans
// MessageEditedDMEvent out to every participant, and reactions and typing did the
// same.
//
// Callers keep their own IsDMParticipant check: its failure mode differs per
// sink (ErrForbidden edit, ErrBadRequest reactions, ErrNotFound pins so a foreign
// DM stays hidden), and flattening it would change client-visible status codes.
// A failed read of the recipient's privacy state fails closed as ErrInternal,
// never ErrBlocked. A GetDMRecipient failure or a DM with no other participant
// is "not blocked" (both the block check and privacy read are skipped), carrying
// over the send path's posture rather than newly failing closed on all sinks.
//
// Group DMs are exempt (Discord's rule): there is no single "other party", and
// dropping one member's messages for another would leave two members reading
// different conversations. Blocks are enforced at group creation
// (DMService.CreateGroupDM) instead.
func RequireDMReachable(ctx context.Context, st DMBlockReader, userID, channelID int64) error {
	isGroup, gErr := st.IsGroupDM(ctx, channelID)
	if gErr == nil && isGroup {
		return nil
	}

	recipient, err := st.GetDMRecipient(ctx, channelID, userID)
	if err != nil || recipient == nil {
		return nil //nolint:nilerr // carries over checkSendPermission's posture: a lookup failure or a DM with no other participant is not a block
	}
	blocked, blkErr := st.IsEitherBlocked(ctx, userID, recipient.ID)
	if blkErr != nil {
		return fmt.Errorf("%w: failed to check block status: %w", ErrInternal, blkErr)
	}
	if blocked {
		return fmt.Errorf("%w: %s", ErrBlocked, dmUnreachableText)
	}
	refused, refErr := st.DMRefusesSender(ctx, recipient.ID, userID)
	if refErr != nil {
		return fmt.Errorf("%w: failed to check DM privacy: %w", ErrInternal, refErr)
	}
	if refused {
		return fmt.Errorf("%w: %s", ErrBlocked, dmUnreachableText)
	}
	return nil
}
