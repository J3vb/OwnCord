package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// GetAccessibleChannelIDs returns all channel IDs the user can read.
func (s *MessageService) GetAccessibleChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
	channels, err := s.st.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list channels: %w", ErrInternal, err)
	}

	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to get role: %w", ErrInternal, err)
	}

	var overrides map[int64]db.ChannelOverride
	if !permissions.HasAdmin(role.Permissions) {
		var overrideErr error
		overrides, overrideErr = s.st.GetChannelOverridesFor(ctx, role.ID, userID)
		if overrideErr != nil {
			return nil, fmt.Errorf("%w: failed to fetch channel overrides: %w", ErrInternal, overrideErr)
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
	//
	// A failed lookup must not silently shrink the accessible set to guild
	// channels only — SearchMessages (message_query.go) treats this list as
	// authoritative and would otherwise report a successful, DM-stripped
	// result instead of failing. Same posture as the ws sibling,
	// computeAllowedChannels in ws/serve.go.
	dmIDs, err := s.st.GetUserDMChannelIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch DM channels: %w", ErrInternal, err)
	}
	ids = append(ids, dmIDs...)

	return ids, nil
}

// ReadableChannelIDs is GetAccessibleChannelIDs narrowed to CONTENT (B5-7):
// the visible set minus any labelled channel the user has not acknowledged.
// Backs SearchMessages' global branch, so a hit inside an unacknowledged
// labelled channel is silently absent from results rather than returned —
// the leak path the plan calls out as the one that "would ship silently".
//
// Costs nothing beyond GetAccessibleChannelIDs when nothing in the visible
// set is labelled: the acknowledgement lookup only runs per labelled
// channel, and only when one is actually in the caller's visible set.
func (s *MessageService) ReadableChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
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
		// Fail closed: a lookup failure is treated as unacknowledged rather
		// than silently widening the readable set.
		ok, ackErr := s.st.HasNSFWAcknowledgement(ctx, userID, id)
		if ackErr == nil && ok {
			readable = append(readable, id)
		}
	}
	return readable, nil
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
	return s.checkSendPermission(ctx, userID, ch)
}

// checkSendPermission is permissions.CanSendMessage over the resolved subject:
// READ|SEND in the channel, MANAGE_MESSAGES on top for announcement channels,
// never into an archive; DM membership and no block. Every caller —
// SendMessage, EditMessage, CanPost, and typing via ChannelService — asks that
// one predicate, so none can drift (S-01, S-12).
func (s *MessageService) checkSendPermission(ctx context.Context, userID int64, ch *db.Channel) error {
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, true)
	if err != nil {
		return err
	}
	return denial(permissions.CanSendMessage(sub))
}

// channelSubject resolves what the channel predicates need for userID in ch:
// role bits and both override layers from the permission cache (a lookup
// failure or a missing role yields no bits — fail closed, as HasChannelPerm
// always has), the channel's flags, and for a DM its membership and, when
// withBlock is set, the two-party block state. The only error is a DM lookup
// failure, wrapped as ErrInternal; callers keep their own posture toward it
// (SendMessage reports it, typing drops silently).
func channelSubject(ctx context.Context, st Store, perms *PermissionService, userID int64, ch *db.Channel, withBlock bool) (permissions.Subject, error) {
	sub, err := perms.Subject(ctx, userID, ch.ID)
	if err != nil {
		sub = permissions.Subject{}
	}
	sub.Channel = permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived}
	if ch.Type != "dm" {
		return sub, nil
	}
	ok, dmErr := st.IsDMParticipant(ctx, userID, ch.ID)
	if dmErr != nil {
		return sub, fmt.Errorf("%w: failed to check DM participation: %w", ErrInternal, dmErr)
	}
	sub.DMParticipant = ok
	if ok && withBlock {
		switch blkErr := requireDMNotBlocked(ctx, st, userID, ch.ID); {
		case errors.Is(blkErr, ErrBlocked):
			sub.DMBlocked = true
		case blkErr != nil:
			return sub, blkErr
		}
	}
	return sub, nil
}

// denial maps a predicate verdict onto the service's error kinds: a block is
// ErrBlocked (its own client-visible code), every other refusal ErrForbidden
// carrying the predicate's reason.
func denial(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, permissions.ErrBlocked):
		return fmt.Errorf("%w: user is blocked", ErrBlocked)
	default:
		return fmt.Errorf("%w: %w", ErrForbidden, err)
	}
}

// readSubject resolves what CanReadContent needs for userID in ch: role bits
// and overrides from the permission cache, the channel's flags, and for a DM
// the participant flag. Unlike channelSubject (the send path's builder) a DM
// lookup failure folds into "not a participant" rather than surfacing as an
// internal error — requireChannelRead's long-standing posture that an
// outsider learns nothing about a DM's existence, even on a transient
// failure.
//
// Archived is deliberately NOT propagated into Channel — docs/protocol.md's
// channel_update section documents "History stays readable" for an archived
// channel as a locked contract; CanViewChannel (which CanReadContent calls
// first) refuses an archived channel outright, and this read gate must not
// silently withdraw that documented guarantee as a side effect of adding the
// NSFW check. Only the WRITE gate (requireChannelWritable) and the
// visibility/audience predicates (CanViewChannel's own direct callers) see
// the real flag.
//
// The NSFW acknowledgement is resolved live (never cached) and only when the
// channel is actually labelled — an unlabelled channel's read costs nothing
// beyond what channelSubject already costs.
func readSubject(ctx context.Context, st Store, perms *PermissionService, userID int64, ch *db.Channel) permissions.Subject {
	sub, err := perms.Subject(ctx, userID, ch.ID)
	if err != nil {
		sub = permissions.Subject{}
	}
	sub.Channel = permissions.ChannelRef{ID: ch.ID, Type: ch.Type, NSFW: ch.NSFW}
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

// readContentDenial maps a CanReadContent verdict onto the service's error
// kinds. ErrNotDMParticipant becomes ErrNotFound, matching requireChannelRead
// and SearchMessages' long-standing "a DM an outsider is not in does not
// exist" posture; ErrNSFWUnacknowledged wraps BOTH ErrForbidden (so ordinary
// FORBIDDEN handling still applies) and the permissions sentinel itself (so a
// caller that wants the specific NSFW_ACKNOWLEDGEMENT_REQUIRED code can match
// it with errors.Is); everything else (missing READ_MESSAGES, archived) is
// ErrForbidden carrying the predicate's own reason.
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
// `archived` used to be consulted only by the visibility predicate
// (VisibleChannelIDs / RefreshChannelVisibility), so it hid a channel without
// protecting it: any caller that still held the id — a custom client, or a
// stock client racing the channel_delete that archiving triggers — could keep
// posting, editing, reacting, pinning, or bulk-deleting in an archive
// indefinitely. History stays readable; only writes are refused.
//
// DMs carry no archive flag/concept and are exempt. ch == nil is treated as
// "nothing to check" rather than a panic — the caller's own nil handling (a
// failed channel lookup) decides what happens next.
//
// Single shared gate for every write sink: checkSendPermission (so
// SendMessage, EditMessage and CanPost inherit it), plus DeleteMessage,
// handleReaction, SetMessagePinned and PurgeMessages, which route their own
// permission checks and so call it directly instead.
func requireChannelWritable(ch *db.Channel) error {
	if ch == nil || ch.Type == "dm" || !ch.Archived {
		return nil
	}
	return fmt.Errorf("%w: channel is archived", ErrForbidden)
}

// DMBlockReader is the narrow read set the block check needs — Store
// satisfies it, and so do consumer-side seams (ws.DispatchReader) that
// carry just these three reads.
type DMBlockReader interface {
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMRecipient(ctx context.Context, channelID, userID int64) (*db.User, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
}

// RequireDMNotBlocked is the exported form of requireDMNotBlocked so callers
// outside the service package (voice join/token-refresh, ws/voice_join.go)
// can share this single block-check implementation — same group-DM exemption,
// same "lookup failure is not a block" posture — instead of reimplementing it
// against the raw DB. st only needs to be a DMBlockReader; *db.DB and Store
// both satisfy it.
func RequireDMNotBlocked(ctx context.Context, st DMBlockReader, userID, channelID int64) error {
	return requireDMNotBlocked(ctx, st, userID, channelID)
}

// requireDMNotBlocked reports ErrBlocked when userID and the other participant
// of DM channelID have blocked each other in either direction.
//
// It is the single block-check implementation, called from every DM
// interaction sink — send, edit, react, pin, typing and call rings
// (DMService.RingTargets). Enforcing it on the
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
//
// Group DMs are exempt, which is Discord's rule and the only coherent one for
// a shared room: there is no single "the other party" to be blocked by, and
// dropping one member's messages for one other member would leave the two of
// them reading different conversations under the same name. Blocks are instead
// enforced when the group is *created* (DMService.CreateGroupDM), where the
// question "may these two be in a room together" still has one answer.
func requireDMNotBlocked(ctx context.Context, st DMBlockReader, userID, channelID int64) error {
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
		return fmt.Errorf("%w: user is blocked", ErrBlocked)
	}
	return nil
}
