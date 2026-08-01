package service

import (
	"context"
	"fmt"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

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
		overrides, overrideErr = s.st.GetChannelOverridesFor(ctx, role.ID, userID)
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
