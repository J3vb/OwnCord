package service

import (
	"context"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// maxMentionsPerMessage caps the mentions one message resolves (user tokens and
// role tokens together); tokens past it stay text, bounding the stored rows and
// read-state writes of a send.
const maxMentionsPerMessage = 20

// maxMentionCandidates caps the distinct tokens looked up per message, so a wall
// of @words cannot become an unbounded query.
const maxMentionCandidates = 60

// everyoneToken and hereToken are reserved: a user named "everyone" is not
// resolvable by @everyone.
const (
	everyoneToken = "everyone"
	hereToken     = "here"
)

type mentionSet struct {
	// UserIDs is ordered by first appearance, deduplicated and (after withReplyPing)
	// capped at maxMentionsPerMessage content ids plus the reply-ping target. Never nil.
	UserIDs []int64
	// Everyone reports an @everyone or @here that cleared the MENTION_EVERYONE gate;
	// without the bit the token has no mention semantics.
	Everyone bool
	// HereOnly narrows an Everyone fan-out to non-offline users: @here matched, @everyone did not.
	HereOnly bool
	// RoleIDs lists roles whose <@&id> token resolved and cleared
	// permissions.CanMentionRole, in order, counting against the same cap. Never nil;
	// empty in a DM.
	RoleIDs []int64
	// RoleUserIDs is every holder of a role in RoleIDs, read once and only when
	// non-empty. It feeds badge, activity and push fan-out and never goes on the wire.
	RoleUserIDs []int64
	// ReplyPingUserID is the replied-to author a reply_ping added to UserIDs (0 for
	// none); the cap never displaces it.
	ReplyPingUserID int64
}

// withReplyPing finalizes the set: content mentions are capped at
// maxMentionsPerMessage not counting targetID, then targetID (when non-zero) is
// added unless the content already named it. resolveMentions keeps one spare id
// so a target among the content mentions never costs another user their slot.
// Every caller passes through here, with 0 for no reply ping.
func (m mentionSet) withReplyPing(targetID int64) mentionSet {
	m.ReplyPingUserID = targetID
	ids := make([]int64, 0, len(m.UserIDs)+1)
	content, named := 0, false
	room := max(maxMentionsPerMessage-len(m.RoleIDs), 0)
	for _, id := range m.UserIDs {
		if targetID != 0 && id == targetID {
			named = true
			ids = append(ids, id)
			continue
		}
		if content == room {
			continue
		}
		content++
		ids = append(ids, id)
	}
	if targetID != 0 && !named {
		ids = append(ids, targetID)
	}
	m.UserIDs = ids
	return m
}

// reachIDs is every user the message pings directly: explicit mentions plus
// holders of a pinged role (MentionReach's input).
func (m mentionSet) reachIDs() []int64 {
	if len(m.RoleUserIDs) == 0 {
		return m.UserIDs
	}
	return slices.Concat(m.UserIDs, m.RoleUserIDs)
}

// fill copies the mentions and the @everyone verdict onto a send result.
func (m mentionSet) fill(r *SendMessageResult) {
	r.Mentions, r.MentionRoles, r.RoleUserIDs = m.UserIDs, m.RoleIDs, m.RoleUserIDs
	r.MentionsEveryone, r.MentionsHere = m.Everyone, m.HereOnly
}

// pings reports whether the message can raise any badge or push.
func (m mentionSet) pings() bool {
	return len(m.UserIDs) > 0 || len(m.RoleUserIDs) > 0 || m.Everyone
}

// resolveMentions turns sanitized content into a mentionSet. Unknown @words, and
// @everyone/@here without MENTION_EVERYONE on the channel, stay plain text. DMs
// have no @everyone or role semantics, so <@&id> stays text there. <@id> tokens
// resolve like a typed @username (an existing, unbanned user); whether that user
// can read the channel is decided where the badge is raised (mentionReaders). They
// come first in UserIDs, then @username mentions, each in order of appearance. A
// <@&id> token resolves to an existing role that clears permissions.CanMentionRole
// for the author, else stays text; holders are read once, only when a role
// resolved. Failures are logged and mean "no mentions": a message must not be
// rejected for a failed lookup. UserIDs may hold one id past the cap for a
// reply-ping target; withReplyPing applies the cap.
func (s *MessageService) resolveMentions(ctx context.Context, content string, authorID, channelID int64, isDM bool) mentionSet {
	set := mentionSet{UserIDs: []int64{}, RoleIDs: []int64{}}

	parsed := parseMentionTokens(content)
	if (parsed.Everyone || parsed.Here) && !isDM &&
		s.perms.HasChannelPerm(ctx, authorID, channelID, permissions.ReadMessages|permissions.MentionEveryone) {
		set.Everyone = true
		set.HereOnly = parsed.Here && !parsed.Everyone
	}
	if len(parsed.RoleIDs) > 0 && !isDM {
		s.resolveRoleMentions(ctx, &set, parsed.RoleIDs, authorID, channelID)
	}
	room := max(maxMentionsPerMessage-len(set.RoleIDs), 0)
	seen := make(map[int64]struct{}, len(parsed.Tokens)+len(parsed.UserIDs))
	add := func(id int64) {
		if _, dup := seen[id]; !dup && len(set.UserIDs) <= room {
			seen[id] = struct{}{}
			set.UserIDs = append(set.UserIDs, id)
		}
	}
	for _, id := range s.resolveIDMentions(ctx, parsed.UserIDs, channelID) {
		add(id)
	}
	s.addNameMentions(ctx, parsed.Tokens, channelID, add)
	return set
}

// addNameMentions resolves legacy @username tokens, in order, through add; a
// lookup failure is logged and leaves them as text.
func (s *MessageService) addNameMentions(ctx context.Context, tokens []mentionCandidate, channelID int64, add func(int64)) {
	if len(tokens) == 0 {
		return
	}
	lookup := make([]string, 0, len(tokens)*2)
	for _, t := range tokens {
		lookup = append(lookup, t.spellings...)
	}
	byName, err := s.st.GetUserIDsByUsernames(ctx, lookup)
	if err != nil {
		slog.Error("MessageService.resolveMentions GetUserIDsByUsernames", "err", err, "channel_id", channelID)
		return
	}
	for _, t := range tokens {
		for _, spelling := range t.spellings {
			if id, ok := byName[spelling]; ok {
				add(id)
				break
			}
		}
	}
}

// MentionReach is the per-reader mention rule: direct when uid is among the
// mentioned ids, broad when the message pinged @everyone (or @here and the
// reader is present). It uses db.BroadcastStatus, not == "offline": the column
// stores the status the user chose, so an invisible reader holds "invisible" and a
// literal comparison would @here-ping them, the thing "appear offline" prevents.
// liveStatus is read only for @here ("" means no live connection). The caller
// removes the author and the author's blockers.
func MentionReach(ids []int64, everyone, hereOnly bool, uid int64, liveStatus string) (direct, broad bool) {
	return MentionReachSet(MentionIDSet(ids), everyone, hereOnly, uid, liveStatus)
}

// MentionIDSet indexes a mention's ids so a fan-out over many readers tests each
// in O(1) with MentionReachSet.
func MentionIDSet(ids []int64) map[int64]struct{} {
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return set
}

// MentionReachSet is MentionReach over a prebuilt MentionIDSet.
func MentionReachSet(ids map[int64]struct{}, everyone, hereOnly bool, uid int64, liveStatus string) (direct, broad bool) {
	_, direct = ids[uid]
	if everyone {
		broad = !hereOnly || (liveStatus != "" && db.BroadcastStatus(liveStatus) != db.StatusOffline)
	}
	return direct, broad
}

// mentionEntries resolves a message's fan-out to the recipients whose badge it
// raises, as one batch entry (or none). Split out so the mention worker can
// resolve at flush time, after the coalesce window, and write many entries in one
// transaction; the read-state guard still runs inside the increment. Edits never
// call this: only the original insert raises a badge, which guarantees a counted
// mention is not counted twice. The message is already committed, so failures are
// logged, not surfaced.
func (s *MessageService) mentionEntries(ctx context.Context, channelID, msgID, authorID int64, set mentionSet, isDM bool, participantIDs []int64) []db.MentionBatchEntry {
	if !set.pings() {
		return nil
	}
	reach := MentionIDSet(set.reachIDs())

	readers, err := s.mentionReaders(ctx, channelID, isDM, participantIDs)
	if err != nil {
		slog.Error("MessageService.applyMentionCounts readers", "err", err, "channel_id", channelID)
		return nil
	}

	recipients := make(map[int64]struct{}, len(readers))
	for _, r := range readers {
		// The live status, when wired, stands in for the column, which keeps a chosen
		// idle/dnd across a disconnect and lags a connect by up to one batched stamp
		// flush. A reader with no live connection ("") is offline whatever the row says
		// (ws/serve_ready.go presentableMembers).
		status := ""
		if set.Everyone && set.HereOnly {
			status = r.Status
			if s.liveStatus != nil {
				status = s.liveStatus(r.UserID)
			}
		}
		if direct, broad := MentionReachSet(reach, set.Everyone, set.HereOnly, r.UserID, status); direct || broad {
			recipients[r.UserID] = struct{}{}
		}
	}
	delete(recipients, authorID)
	if len(recipients) == 0 {
		return nil
	}

	blockers, err := s.st.ListBlockersOf(ctx, authorID)
	if err != nil {
		slog.Error("MessageService.applyMentionCounts ListBlockersOf", "err", err, "user_id", authorID)
		return nil // Fail closed: a badge from a blocked user is worse than no badge.
	}
	for _, b := range blockers {
		delete(recipients, b)
	}
	if len(recipients) == 0 {
		return nil
	}

	ids := make([]int64, 0, len(recipients))
	for id := range recipients {
		ids = append(ids, id)
	}
	return []db.MentionBatchEntry{{MsgID: msgID, UserIDs: ids}}
}

// mentionReaders lists the users who can read the channel, with the presence
// status @here filters on. Each role resolves with its own channel override and a
// member is a reader when ANY role they hold reads (OR'd, as
// permissions.MemberChannelPerms does; ListMentionTargetsByRoles joins user_roles
// so a multi-role holder is listed once). DM participation is membership, so DMs
// skip the role walk.
func (s *MessageService) mentionReaders(ctx context.Context, channelID int64, isDM bool, participantIDs []int64) ([]db.MentionTarget, error) {
	if isDM {
		targets := make([]db.MentionTarget, 0, len(participantIDs))
		for _, pid := range participantIDs {
			targets = append(targets, db.MentionTarget{UserID: pid})
		}
		return targets, nil
	}

	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, err
	}
	overrides, err := s.st.GetChannelOverrides(ctx, channelID)
	if err != nil {
		return nil, err
	}

	readRoles := make([]int64, 0, len(roles))
	adminRoles := make(map[int64]bool, len(roles))
	for _, r := range roles {
		if r == nil {
			continue
		}
		o := overrides[r.ID]
		eff := permissions.EffectivePerms(r.Permissions, o.Allow, o.Deny)
		if permissions.HasAdmin(r.Permissions) {
			adminRoles[r.ID] = true
		}
		if permissions.HasAdmin(r.Permissions) || eff&permissions.ReadMessages != 0 {
			readRoles = append(readRoles, r.ID)
		}
	}
	targets, err := s.st.ListMentionTargetsByRoles(ctx, readRoles)
	if err != nil {
		return nil, err
	}
	return s.applyUserOverridesToReaders(ctx, channelID, targets, adminRoles)
}

// holdsAdminRole reports whether any role the target holds has ADMINISTRATOR; a
// member with Administrator in a lower-ranked role also bypasses the per-user deny.
func holdsAdminRole(t db.MentionTarget, adminRoles map[int64]bool) bool {
	if adminRoles[t.RoleID] {
		return true
	}
	return slices.ContainsFunc(t.RoleIDs, func(id int64) bool { return adminRoles[id] })
}

// applyUserOverridesToReaders folds the per-user override layer (last in the
// resolution order) into the role walk's readers, in both directions:
//
//   - a user DENY of READ_MESSAGES drops a member their role admitted (unless
//     they hold ADMINISTRATOR, which bypasses every override);
//   - a user ALLOW adds a member their role excluded.
//
// A user allow beats a user deny on the same bit, as permissions.EffectiveChannelPerms.
func (s *MessageService) applyUserOverridesToReaders(
	ctx context.Context, channelID int64, targets []db.MentionTarget, adminRoles map[int64]bool,
) ([]db.MentionTarget, error) {
	userOv, err := s.st.GetChannelUserOverrides(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if len(userOv) == 0 {
		return targets, nil
	}

	granted := make([]int64, 0, len(userOv))
	revoked := make(map[int64]bool, len(userOv))
	for uid, o := range userOv {
		switch {
		case o.UserAllow&permissions.ReadMessages != 0:
			granted = append(granted, uid)
		case o.UserDeny&permissions.ReadMessages != 0:
			revoked[uid] = true
		}
	}

	kept := make([]db.MentionTarget, 0, len(targets))
	present := make(map[int64]bool, len(targets))
	for _, t := range targets {
		if revoked[t.UserID] && !holdsAdminRole(t, adminRoles) {
			continue
		}
		present[t.UserID] = true
		kept = append(kept, t)
	}

	missing := make([]int64, 0, len(granted))
	for _, uid := range granted {
		if !present[uid] {
			missing = append(missing, uid)
		}
	}
	if len(missing) == 0 {
		return kept, nil
	}
	// Sorted so the fan-out (and its tests) do not depend on map order.
	slices.Sort(missing)
	added, err := s.st.ListMentionTargetsByUserIDs(ctx, missing)
	if err != nil {
		return nil, err
	}
	return append(kept, added...), nil
}
