package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// MentionIDStore is the slice of the database the id and role mention forms
// read beyond Store. A store without it (a test fake) resolves @username
// tokens only; the id forms stay plain text.
type MentionIDStore interface {
	GetReachableUserIDs(ctx context.Context, ids []int64) ([]int64, error)
	ListUserIDsByRoles(ctx context.Context, roleIDs []int64) ([]int64, error)
}

var _ MentionIDStore = (*db.DB)(nil)

// resolveIDMentions returns the <@id> tokens that name a reachable user (one
// that exists and is not banned), in token order. A read failure is logged and
// leaves the tokens as text.
func (s *mentionState) resolveIDMentions(ctx context.Context, ids []int64, channelID int64) []int64 {
	if len(ids) == 0 || s.mentionIDs == nil {
		return nil
	}
	found, err := s.mentionIDs.GetReachableUserIDs(ctx, ids)
	if err != nil {
		slog.Error("MessageService.resolveMentions GetReachableUserIDs", "err", err, "channel_id", channelID)
		return nil
	}
	reachable := make(map[int64]struct{}, len(found))
	for _, id := range found {
		reachable[id] = struct{}{}
	}
	out := make([]int64, 0, len(found))
	for _, id := range ids {
		if _, ok := reachable[id]; ok {
			out = append(out, id)
		}
	}
	return out
}

// resolveRoleMentions fills set.RoleIDs with the pinged roles that exist and
// clear the gate. The roles read and
// the author's Subject are fetched only here, so a message without a role token
// pays neither. A read failure leaves the tokens as plain text.
func (s *mentionState) resolveRoleMentions(ctx context.Context, set *mentionSet, tokens []int64, authorID, channelID int64) {
	if s.mentionIDs == nil {
		return
	}
	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		slog.Error("MessageService.resolveMentions ListRoles", "err", err, "channel_id", channelID)
		return
	}
	byID := make(map[int64]*db.Role, len(roles))
	for _, r := range roles {
		if r != nil {
			byID[r.ID] = r
		}
	}
	var author permissions.Subject
	haveAuthor := false
	for _, id := range tokens {
		r, ok := byID[id]
		if !ok || len(set.RoleIDs) >= maxMentionsPerMessage {
			continue
		}
		if !r.Mentionable && !haveAuthor {
			var subErr error
			if author, subErr = s.perms.Subject(ctx, authorID, channelID); subErr != nil {
				slog.Error("MessageService.resolveMentions Subject", "err", subErr, "channel_id", channelID)
			}
			haveAuthor = true // a failed read leaves the zero Subject, which refuses
		}
		if permissions.CanMentionRole(author, r.Mentionable) == nil {
			set.RoleIDs = append(set.RoleIDs, id)
		}
	}
}

// loadRoleHolders reads every holder of set.RoleIDs once and returns the set
// with RoleUserIDs filled. Only a send calls it: an edit never raises a badge,
// so it does not pay the read. Nothing is read when no role resolved; a read
// failure is logged and leaves the roles listed with no holders to ping.
func (s *mentionState) loadRoleHolders(ctx context.Context, set mentionSet, channelID int64) mentionSet {
	if len(set.RoleIDs) == 0 || s.mentionIDs == nil {
		return set
	}
	holders, err := s.mentionIDs.ListUserIDsByRoles(ctx, set.RoleIDs)
	if err != nil {
		slog.Error("MessageService.resolveMentions ListUserIDsByRoles", "err", err, "channel_id", channelID)
		return set
	}
	set.RoleUserIDs = holders
	return set
}
