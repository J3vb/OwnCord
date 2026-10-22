package service

import (
	"context"
	"log/slog"
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// maxMentionsPerMessage caps how many mentions one message can resolve, user
// tokens (@name and <@id>) and role tokens (<@&id>) together. Tokens past the
// cap stay plain text, bounding both the stored rows and the read-state writes
// a single send can trigger.
const maxMentionsPerMessage = 20

// maxMentionCandidates caps how many distinct tokens (of all three forms) are
// looked up per message, so a wall of @words cannot turn one send into an unbounded query.
const maxMentionCandidates = 60

// everyoneToken and hereToken are reserved: a user literally named "everyone"
// is not resolvable by @everyone.
const (
	everyoneToken = "everyone"
	hereToken     = "here"
)

// mentionSet is the resolved mention state of one message.
type mentionSet struct {
	// UserIDs is ordered by first appearance in the content, deduplicated and,
	// once withReplyPing has run, capped at maxMentionsPerMessage content ids
	// plus the reply-ping target. Never nil.
	UserIDs []int64
	// Everyone reports an @everyone or @here that cleared the MENTION_EVERYONE
	// gate. Without the bit the token keeps no mention semantics at all.
	Everyone bool
	// HereOnly narrows an Everyone fan-out to users who are not offline. It is
	// set when @here matched and @everyone did not.
	HereOnly bool
	// RoleIDs lists the roles whose <@&id> token resolved and cleared
	// permissions.CanMentionRole, in order of appearance. They count against
	// the same cap as UserIDs. Never nil. Empty in a DM, where roles have no
	// meaning.
	RoleIDs []int64
	// RoleUserIDs is every holder of a role in RoleIDs, read once and only when
	// RoleIDs is non-empty. It feeds the badge, activity and push fan-out and
	// is never put on the wire: `mentions` stays the explicit user ids.
	RoleUserIDs []int64
	// ReplyPingUserID is the replied-to author a reply_ping added to UserIDs,
	// 0 for none. UserIDs holds at most maxMentionsPerMessage content mentions
	// plus this one, and the target is never displaced by the cap.
	ReplyPingUserID int64
}

// withReplyPing finalizes the set: the content mentions are capped at
// maxMentionsPerMessage without counting targetID, then targetID (when
// non-zero) is added if the content did not already name it. resolveMentions
// keeps one spare id so a target among the content mentions never costs
// another user their slot. Every caller passes the set through here, with 0
// when there is no reply ping.
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

// reachIDs is every user the message pings directly: the explicit mentions
// plus the holders of a pinged role. MentionReach takes this set.
func (m mentionSet) reachIDs() []int64 {
	if len(m.RoleUserIDs) == 0 {
		return m.UserIDs
	}
	return slices.Concat(m.UserIDs, m.RoleUserIDs)
}

// fill copies the explicit and role mentions and the @everyone verdict onto a
// send result.
func (m mentionSet) fill(r *SendMessageResult) {
	r.Mentions, r.MentionRoles, r.RoleUserIDs = m.UserIDs, m.RoleIDs, m.RoleUserIDs
	r.MentionsEveryone, r.MentionsHere = m.Everyone, m.HereOnly
}

// pings reports whether the message can raise any badge or push at all.
func (m mentionSet) pings() bool {
	return len(m.UserIDs) > 0 || len(m.RoleUserIDs) > 0 || m.Everyone
}

// resolveMentions turns sanitized content into a mentionSet. Unknown @words
// resolve to nothing and stay plain text, and @everyone/@here without the
// MENTION_EVERYONE bit on this channel does the same. DM channels have no
// @everyone semantics — there is no permission surface to answer to — and no
// role semantics either, so a <@&id> token in a DM stays text.
//
// <@id> tokens resolve like a typed @username: to a user who exists and is not
// banned. Whether that user can read the channel is decided later, where the
// badge is raised (mentionReaders), exactly as for @username. They come first
// in UserIDs, then the @username mentions, each in order of appearance.
//
// A <@&id> token resolves to a role that exists and clears
// permissions.CanMentionRole for the author; otherwise it stays text and is
// listed nowhere. Holders are read once, and only when a role resolved.
//
// Resolution failures are logged and treated as "no mentions": a message must
// not be rejected because its mention lookup failed.
//
// UserIDs may hold one id past the cap, for a reply-ping target among them;
// withReplyPing applies the cap.
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

// addNameMentions resolves the legacy @username tokens, in order, through add.
// A lookup failure is logged and leaves the tokens as text.
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
// reader's status shows them present). db.BroadcastStatus, not a bare
// == "offline": the column stores the status the user *chose*, so an invisible
// reader holds "invisible" and a literal comparison would ping them with @here
// — the one thing "appear offline" is meant to stop. liveStatus is read only
// for @here; "" means no live connection. The author and the author's blockers
// are removed by the caller.
func MentionReach(ids []int64, everyone, hereOnly bool, uid int64, liveStatus string) (direct, broad bool) {
	direct = slices.Contains(ids, uid)
	if everyone {
		broad = !hereOnly || (liveStatus != "" && db.BroadcastStatus(liveStatus) != db.StatusOffline)
	}
	return direct, broad
}

// mentionEntries resolves a message's fan-out to the recipients whose mention
// badge it raises, as one batch entry (or none). It is the resolution half of
// the old per-send applyMentionCounts, split out so the mention worker can
// resolve at flush time — after the coalesce window — and write many messages'
// entries in one transaction. The read-state guard still runs inside the
// increment, so a read that lands during the window still no-ops.
//
// Edits deliberately never call this: a mention that was already counted must
// not be counted twice, and the simplest rule that guarantees it is that only
// the original insert can raise a badge.
//
// The message is already committed by the time this runs, so failures are
// logged rather than surfaced — a lost badge must not fail a delivered send.
func (s *MessageService) mentionEntries(ctx context.Context, channelID, msgID, authorID int64, set mentionSet, isDM bool, participantIDs []int64) []db.MentionBatchEntry {
	if !set.pings() {
		return nil
	}
	reach := set.reachIDs()

	readers, err := s.mentionReaders(ctx, channelID, isDM, participantIDs)
	if err != nil {
		slog.Error("MessageService.applyMentionCounts readers", "err", err, "channel_id", channelID)
		return nil
	}

	recipients := make(map[int64]struct{}, len(readers))
	for _, r := range readers {
		// The live status, when wired, stands in for the column: the row
		// keeps a *chosen* idle/dnd across a disconnect by design
		// (StampDisconnect only ever rewrites "online" -> "offline") and
		// lags a connect by up to one batched stamp flush. A reader with
		// no live connection ("") is offline whatever the row says, the
		// read path's rule (ws/serve_ready.go presentableMembers).
		status := ""
		if set.Everyone && set.HereOnly {
			status = r.Status
			if s.liveStatus != nil {
				status = s.liveStatus(r.UserID)
			}
		}
		if direct, broad := MentionReach(reach, set.Everyone, set.HereOnly, r.UserID, status); direct || broad {
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
// status @here filters on. Each role is resolved with its own channel override
// and a member is a reader when ANY role they hold reads (the roles are OR'd,
// as permissions.MemberChannelPerms does; ListMentionTargetsByRoles joins
// user_roles, so a holder of several roles is listed once). DM participation is
// membership, not permissions, so DMs skip the role walk entirely.
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

// holdsAdminRole reports whether any role the target holds has ADMINISTRATOR.
// The role-only walk never sees the top-role mirror alone: a member holding
// Administrator in a lower-ranked role bypasses the per-user deny too.
func holdsAdminRole(t db.MentionTarget, adminRoles map[int64]bool) bool {
	if adminRoles[t.RoleID] {
		return true
	}
	return slices.ContainsFunc(t.RoleIDs, func(id int64) bool { return adminRoles[id] })
}

// applyUserOverridesToReaders folds the per-user override layer into a reader
// set the role walk produced. The layer is last in the resolution order, so it
// moves members in both directions:
//
//   - a user DENY of READ_MESSAGES drops a member their role admitted (unless
//     they hold ADMINISTRATOR, which bypasses every override), and
//   - a user ALLOW of READ_MESSAGES adds a member their role excluded.
//
// A user allow also beats a user deny on the same bit, matching
// permissions.EffectiveChannelPerms.
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
	// Deterministic order so the fan-out (and its tests) do not depend on map
	// iteration order.
	slices.Sort(missing)
	added, err := s.st.ListMentionTargetsByUserIDs(ctx, missing)
	if err != nil {
		return nil, err
	}
	return append(kept, added...), nil
}
