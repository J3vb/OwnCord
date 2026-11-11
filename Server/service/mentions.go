package service

import (
	"context"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// maxMentionsPerMessage caps the mentions one message resolves (user and role tokens
// together); the rest stay text, bounding the stored rows and read-state writes of a send.
const maxMentionsPerMessage = 20

// maxMentionCandidates caps the distinct tokens looked up per message, so a wall of @words is no unbounded
// query.
const maxMentionCandidates = 60

// everyoneToken and hereToken are reserved: a user named "everyone" is not resolvable by @everyone.
const (
	everyoneToken = "everyone"
	hereToken     = "here"
)

type mentionSet struct {
	// UserIDs is in order of first appearance, deduplicated and (after withReplyPing) capped
	// at maxMentionsPerMessage content ids plus the reply-ping target. Never nil.
	UserIDs []int64
	// Everyone reports an @everyone or @here that cleared MENTION_EVERYONE; without the bit the token has no
	// mention semantics.
	Everyone bool
	HereOnly bool
	// RoleIDs lists roles whose <@&id> resolved and cleared permissions.CanMentionRole, in
	// order, counting against the same cap. Never nil; empty in a DM.
	RoleIDs []int64
	// RoleUserIDs is every holder of a RoleIDs role, read once and only when non-empty. Feeds
	// badge, activity and push fan-out; never on the wire.
	RoleUserIDs []int64
	// ReplyPingUserID is the replied-to author a reply_ping added to UserIDs (0 for none); the cap never
	// displaces it.
	ReplyPingUserID int64
}

// withReplyPing finalizes the set: content mentions are capped at maxMentionsPerMessage
// not counting targetID, then targetID (when non-zero) is added unless already named.
// resolveMentions keeps one spare id so a target never costs another user their slot.
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

func (m mentionSet) reachIDs() []int64 {
	if len(m.RoleUserIDs) == 0 {
		return m.UserIDs
	}
	return slices.Concat(m.UserIDs, m.RoleUserIDs)
}

func (m mentionSet) fill(r *SendMessageResult) {
	r.Mentions, r.MentionRoles, r.RoleUserIDs = m.UserIDs, m.RoleIDs, m.RoleUserIDs
	r.MentionsEveryone, r.MentionsHere = m.Everyone, m.HereOnly
}

func (m mentionSet) pings() bool {
	return len(m.UserIDs) > 0 || len(m.RoleUserIDs) > 0 || m.Everyone
}

// resolveMentions turns sanitized content into a mentionSet. Unknown @words, and
// @everyone/@here without MENTION_EVERYONE, stay text; DMs have no @everyone or role
// semantics. <@id> tokens resolve like a typed @username (existing, unbanned user);
// whether that user can read the channel is decided where the badge is raised
// (mentionReaders). They come first in UserIDs, then @username mentions. A <@&id> token
// resolves to an existing role clearing CanMentionRole for the author, else stays text;
// holders are read once, only when a role resolved. Failures are logged and mean "no
// mentions": a message must not be rejected for a failed lookup. UserIDs may hold one id
// past the cap for a reply-ping target; withReplyPing applies the cap.
func (s *mentionState) resolveMentions(ctx context.Context, content string, authorID, channelID int64, isDM bool) mentionSet {
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

func (s *mentionState) addNameMentions(ctx context.Context, tokens []mentionCandidate, channelID int64, add func(int64)) {
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

// MentionReach is the per-reader mention rule: direct when uid is among the mentioned ids,
// broad for @everyone (or @here and the reader present). Uses db.BroadcastStatus, not
// == "offline": the column stores the chosen status, so an invisible reader holds
// "invisible" and a literal comparison would @here-ping them. liveStatus is read only for
// @here ("" means no live connection). The caller removes the author and their blockers.
func MentionReach(ids []int64, everyone, hereOnly bool, uid int64, liveStatus string) (direct, broad bool) {
	return MentionReachSet(MentionIDSet(ids), everyone, hereOnly, uid, liveStatus)
}

// MentionIDSet indexes a mention's ids so a fan-out tests each reader in O(1) with MentionReachSet.
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

// mentionEntries resolves a message's fan-out to the recipients whose badge it raises, as
// one batch entry (or none), so the worker can resolve at flush time; the read-state guard
// still runs inside the increment. Edits never call this: only the original insert raises
// a badge. The message is committed, so failures are logged, not surfaced.
func (s *mentionState) mentionEntries(ctx context.Context, channelID, msgID, authorID int64, set mentionSet, isDM bool, participantIDs []int64) []db.MentionBatchEntry {
	if !set.pings() {
		return nil
	}
	reach := MentionIDSet(set.reachIDs())

	var readers []db.MentionTarget
	var err error
	if !isDM && !set.Everyone && len(set.RoleUserIDs) == 0 {
		readers, err = s.mentionReadersAmong(ctx, channelID, set.UserIDs)
	} else {
		readers, err = s.mentionReaders(ctx, channelID, isDM, participantIDs)
	}
	if err != nil {
		slog.Error("MessageService.applyMentionCounts readers", "err", err, "channel_id", channelID)
		return nil
	}

	recipients := make(map[int64]struct{}, len(readers))
	for _, r := range readers {
		// The live status, when wired, stands in for the column, which keeps a chosen idle/dnd
		// across a disconnect and lags a connect by up to one stamp flush. A reader with no live
		// connection ("") is offline whatever the row says.
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

// mentionReaders lists the users who can read the channel, with the presence status @here
// filters on. Each role resolves with its own channel override and a member is a reader
// when ANY role reads (as permissions.MemberChannelPerms does; ListMentionTargetsByRoles
// lists a multi-role holder once). DMs skip the role walk: participation is membership.
func (s *mentionState) mentionReaders(ctx context.Context, channelID int64, isDM bool, participantIDs []int64) ([]db.MentionTarget, error) {
	if isDM {
		targets := make([]db.MentionTarget, 0, len(participantIDs))
		for _, pid := range participantIDs {
			targets = append(targets, db.MentionTarget{UserID: pid})
		}
		return targets, nil
	}

	readRoles, adminRoles, err := s.readingRoles(ctx, channelID)
	if err != nil {
		return nil, err
	}
	targets, err := s.st.ListMentionTargetsByRoles(ctx, readRoles)
	if err != nil {
		return nil, err
	}
	return s.applyUserOverridesToReaders(ctx, channelID, targets, adminRoles, nil)
}

// mentionReadersAmong is mentionReaders for a message that can reach only the named
// userIDs (no @everyone, @here or role mention): same rules, filtered to userIDs without
// walking every member holding a reading role.
func (s *mentionState) mentionReadersAmong(ctx context.Context, channelID int64, userIDs []int64) ([]db.MentionTarget, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	readRoles, adminRoles, err := s.readingRoles(ctx, channelID)
	if err != nil {
		return nil, err
	}
	ids := slices.Clone(userIDs)
	slices.Sort(ids)
	candidates, err := s.st.ListMentionTargetsByUserIDs(ctx, slices.Compact(ids))
	if err != nil {
		return nil, err
	}
	reads := make(map[int64]bool, len(readRoles))
	for _, id := range readRoles {
		reads[id] = true
	}
	byID := make(map[int64]db.MentionTarget, len(candidates))
	targets := make([]db.MentionTarget, 0, len(candidates))
	for _, t := range candidates {
		byID[t.UserID] = t
		if slices.ContainsFunc(t.RoleIDs, func(id int64) bool { return reads[id] }) {
			targets = append(targets, t)
		}
	}
	return s.applyUserOverridesToReaders(ctx, channelID, targets, adminRoles, byID)
}

func (s *mentionState) readingRoles(ctx context.Context, channelID int64) ([]int64, map[int64]bool, error) {
	roles, err := s.st.ListRoles(ctx)
	if err != nil {
		return nil, nil, err
	}
	overrides, err := s.st.GetChannelOverrides(ctx, channelID)
	if err != nil {
		return nil, nil, err
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
	return readRoles, adminRoles, nil
}

func holdsAdminRole(t db.MentionTarget, adminRoles map[int64]bool) bool {
	if adminRoles[t.RoleID] {
		return true
	}
	return slices.ContainsFunc(t.RoleIDs, func(id int64) bool { return adminRoles[id] })
}

// applyUserOverridesToReaders folds the per-user override layer (last in resolution
// order) into the role walk's readers: a user DENY of READ_MESSAGES drops a member their
// role admitted (unless ADMINISTRATOR, which bypasses every override); a user ALLOW adds
// one their role excluded; allow beats deny on the same bit, as
// permissions.EffectiveChannelPerms. among, when non-nil, is the only users a grant may
// add, already read (the direct-mention path); nil reads them here.
func (s *mentionState) applyUserOverridesToReaders(
	ctx context.Context, channelID int64, targets []db.MentionTarget, adminRoles map[int64]bool,
	among map[int64]db.MentionTarget,
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
	slices.Sort(missing)
	if among != nil {
		for _, uid := range missing {
			if t, ok := among[uid]; ok {
				kept = append(kept, t)
			}
		}
		return kept, nil
	}
	if len(missing) == 0 {
		return kept, nil
	}
	added, err := s.st.ListMentionTargetsByUserIDs(ctx, missing)
	if err != nil {
		return nil, err
	}
	return append(kept, added...), nil
}
