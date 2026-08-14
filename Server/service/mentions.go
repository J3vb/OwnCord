package service

import (
	"context"
	"log/slog"
	"regexp"
	"slices"
	"strings"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// maxMentionsPerMessage caps how many usernames one message can resolve.
// Tokens past the cap stay plain text, bounding both the stored rows and the
// read-state writes a single send can trigger.
const maxMentionsPerMessage = 20

// maxMentionCandidates caps how many distinct @tokens are looked up per
// message, so a wall of @words cannot turn one send into an unbounded query.
const maxMentionCandidates = 60

// mentionTokenRe matches an @token that stands alone as a word. Group 1 is the
// preceding character, which must be start-of-string or a non-word non-@ rune
// ("mail@example" and "@@name" never resolve); group 2 is the token; group 3
// captures a trailing "@" so address-shaped text like "@bob@example.com" is
// rejected as a whole rather than half-matched. The token charset is letters,
// digits, underscore, dot and hyphen — usernames may hold any printable rune,
// but only this subset is addressable without an explicit delimiter.
var mentionTokenRe = regexp.MustCompile(`(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{1,64})(@?)`)

// everyoneToken and hereToken are reserved: a user literally named "everyone"
// is not resolvable by @everyone.
const (
	everyoneToken = "everyone"
	hereToken     = "here"
)

// mentionSet is the resolved mention state of one message.
type mentionSet struct {
	// UserIDs is ordered by first appearance in the content, deduplicated and
	// capped at maxMentionsPerMessage. Never nil.
	UserIDs []int64
	// Everyone reports an @everyone or @here that cleared the MENTION_EVERYONE
	// gate. Without the bit the token keeps no mention semantics at all.
	Everyone bool
	// HereOnly narrows an Everyone fan-out to users who are not offline. It is
	// set when @here matched and @everyone did not.
	HereOnly bool
}

// mentionCandidate is one @token and the username spellings it may resolve to,
// in preference order. Trailing sentence punctuation is stripped in the second
// spelling so "@bob." resolves to bob when no user is named "bob.".
type mentionCandidate struct {
	spellings []string
}

// parseMentionTokens extracts the @tokens of a message. Returned tokens are
// lowercased, distinct and ordered by first appearance; the reserved
// @everyone / @here tokens are reported separately and never resolved as
// usernames.
func parseMentionTokens(content string) (tokens []mentionCandidate, everyone, here bool) {
	seen := make(map[string]struct{})
	for _, m := range mentionTokenRe.FindAllStringSubmatch(content, -1) {
		if m[3] == "@" {
			continue // address-shaped, e.g. "@bob@example.com"
		}
		raw := strings.ToLower(m[2])
		switch raw {
		case everyoneToken:
			everyone = true
			continue
		case hereToken:
			here = true
			continue
		}
		if _, dup := seen[raw]; dup {
			continue
		}
		seen[raw] = struct{}{}
		spellings := []string{raw}
		if trimmed := strings.TrimRight(raw, ".-"); trimmed != "" && trimmed != raw {
			spellings = append(spellings, trimmed)
		}
		tokens = append(tokens, mentionCandidate{spellings: spellings})
		if len(tokens) >= maxMentionCandidates {
			break
		}
	}
	return tokens, everyone, here
}

// resolveMentions turns sanitized content into a mentionSet. Unknown @words
// resolve to nothing and stay plain text, and @everyone/@here without the
// MENTION_EVERYONE bit on this channel does the same. DM channels have no
// @everyone semantics — there is no permission surface to answer to.
//
// Resolution failures are logged and treated as "no mentions": a message must
// not be rejected because its mention lookup failed.
func (s *MessageService) resolveMentions(ctx context.Context, content string, authorID, channelID int64, isDM bool) mentionSet {
	set := mentionSet{UserIDs: []int64{}}

	tokens, everyone, here := parseMentionTokens(content)
	if (everyone || here) && !isDM &&
		s.perms.HasChannelPerm(ctx, authorID, channelID, permissions.ReadMessages|permissions.MentionEveryone) {
		set.Everyone = true
		set.HereOnly = here && !everyone
	}
	if len(tokens) == 0 {
		return set
	}

	lookup := make([]string, 0, len(tokens)*2)
	for _, t := range tokens {
		lookup = append(lookup, t.spellings...)
	}
	byName, err := s.st.GetUserIDsByUsernames(ctx, lookup)
	if err != nil {
		slog.Error("MessageService.resolveMentions GetUserIDsByUsernames", "err", err, "channel_id", channelID)
		return set
	}

	seen := make(map[int64]struct{}, len(tokens))
	for _, t := range tokens {
		for _, spelling := range t.spellings {
			id, ok := byName[spelling]
			if !ok {
				continue
			}
			if _, dup := seen[id]; !dup {
				seen[id] = struct{}{}
				set.UserIDs = append(set.UserIDs, id)
			}
			break
		}
		if len(set.UserIDs) >= maxMentionsPerMessage {
			break
		}
	}
	return set
}

// applyMentionCounts increments read_states.mention_count for every user the
// message mentions who can see the channel, except the author and except users
// who have blocked the author. @everyone reaches every reader; @here reaches
// only readers who are not offline.
//
// Edits deliberately never call this: a mention that was already counted must
// not be counted twice, and the simplest rule that guarantees it is that only
// the original insert can raise a badge.
//
// The message is already committed by the time this runs, so failures are
// logged rather than surfaced — a lost badge must not fail a delivered send.
func (s *MessageService) applyMentionCounts(ctx context.Context, channelID, msgID, authorID int64, set mentionSet, isDM bool, participantIDs []int64) {
	if len(set.UserIDs) == 0 && !set.Everyone {
		return
	}

	readers, err := s.mentionReaders(ctx, channelID, isDM, participantIDs)
	if err != nil {
		slog.Error("MessageService.applyMentionCounts readers", "err", err, "channel_id", channelID)
		return
	}

	recipients := make(map[int64]struct{}, len(readers))
	if set.Everyone {
		for _, r := range readers {
			// db.BroadcastStatus, not a bare == "offline": the column stores the
			// status the user *chose*, so an invisible reader holds "invisible"
			// here and a literal comparison would ping them with @here — the one
			// thing "appear offline" is meant to stop. Collapsing first makes
			// @here agree with what everyone else can see of that reader.
			if set.HereOnly && db.BroadcastStatus(r.Status) == db.StatusOffline {
				continue
			}
			recipients[r.UserID] = struct{}{}
		}
	}
	if len(set.UserIDs) > 0 {
		// Build the reader set once instead of scanning readers per mentioned
		// uid: that nested loop was O(mentions x readers), which gets
		// expensive on a channel with many readers.
		readerIDs := make(map[int64]struct{}, len(readers))
		for _, r := range readers {
			readerIDs[r.UserID] = struct{}{}
		}
		for _, uid := range set.UserIDs {
			if _, ok := readerIDs[uid]; ok {
				recipients[uid] = struct{}{}
			}
		}
	}
	delete(recipients, authorID)
	if len(recipients) == 0 {
		return
	}

	blockers, err := s.st.ListBlockersOf(ctx, authorID)
	if err != nil {
		slog.Error("MessageService.applyMentionCounts ListBlockersOf", "err", err, "user_id", authorID)
		return // Fail closed: a badge from a blocked user is worse than no badge.
	}
	for _, b := range blockers {
		delete(recipients, b)
	}
	if len(recipients) == 0 {
		return
	}

	ids := make([]int64, 0, len(recipients))
	for id := range recipients {
		ids = append(ids, id)
	}
	if err := s.st.IncrementMentionCounts(ctx, channelID, msgID, ids); err != nil {
		slog.Error("MessageService.applyMentionCounts IncrementMentionCounts", "err", err, "channel_id", channelID)
	}
}

// mentionReaders lists the users who can read the channel, with the presence
// status @here filters on. DM participation is membership, not permissions, so
// DMs skip the role walk entirely.
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
		if revoked[t.UserID] && !adminRoles[t.RoleID] {
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
