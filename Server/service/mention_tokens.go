package service

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// mentionTokenRe finds every mention form in one pass. The first alternative is the
// id form: "<@123>" (user, group 2 the id) or "<@&5>" (role, group 1 is "&"),
// tried first at each position so the "<" of "<@7>" is never the preceding
// character of a legacy @7 token.
// The second alternative is the legacy @token standing alone as a word. Group 3 is
// the preceding character, which must be start-of-string or a non-word non-@ rune
// ("mail@example" and "@@name" never resolve); group 4 is the token; group 5
// captures a trailing "@" so "@bob@example.com" is rejected whole. The token
// charset is letters, digits, underscore, dot and hyphen: usernames may hold any
// printable rune, but only this subset is addressable without a delimiter.
var mentionTokenRe = regexp.MustCompile(`<@(&?)([0-9]{1,18})>|(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{1,64})(@?)`)

// mentionCandidate is one @token and the username spellings it may resolve to,
// in preference order. Trailing sentence punctuation is stripped in the second
// spelling so "@bob." resolves to bob when no user is named "bob.".
type mentionCandidate struct {
	spellings []string
}

// parsedMentions is every token of a message, from one regex pass.
type parsedMentions struct {
	// Tokens are the legacy @username candidates: lowercased, distinct and
	// ordered by first appearance. The reserved @everyone / @here are reported
	// below and never resolved as usernames.
	Tokens []mentionCandidate
	// UserIDs and RoleIDs are the ids of <@id> and <@&id> tokens, distinct and
	// in order of appearance. Ids that are not positive are dropped.
	UserIDs []int64
	RoleIDs []int64
	// Everyone and Here report the reserved tokens.
	Everyone, Here bool

	seenName map[string]struct{}
	seenUser map[int64]struct{}
	seenRole map[int64]struct{}
}

// size is how many distinct tokens of all forms have been kept.
func (p *parsedMentions) size() int { return len(p.Tokens) + len(p.UserIDs) + len(p.RoleIDs) }

// addID keeps one <@id> (role false) or <@&id> (role true) token.
func (p *parsedMentions) addID(digits string, role bool) {
	id, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || id <= 0 {
		return
	}
	seen, list := p.seenUser, &p.UserIDs
	if role {
		seen, list = p.seenRole, &p.RoleIDs
	}
	if _, dup := seen[id]; !dup {
		seen[id] = struct{}{}
		*list = append(*list, id)
	}
}

// addName keeps one legacy @token (already known not to be address-shaped).
func (p *parsedMentions) addName(token string) {
	// db.LowerASCII, not strings.ToLower: usernames.username is only
	// COLLATE NOCASE, which folds ASCII A-Z only. A Unicode fold here
	// (e.g. 'É' -> 'é') would desync this token from GetUserIDsByUsernames'
	// equally ASCII-folded map key, so a username holding an uppercase
	// non-ASCII letter could never resolve.
	raw := db.LowerASCII(token)
	switch raw {
	case everyoneToken:
		p.Everyone = true
		return
	case hereToken:
		p.Here = true
		return
	}
	if _, dup := p.seenName[raw]; dup {
		return
	}
	p.seenName[raw] = struct{}{}
	spellings := []string{raw}
	if trimmed := strings.TrimRight(raw, ".-"); trimmed != "" && trimmed != raw {
		spellings = append(spellings, trimmed)
	}
	p.Tokens = append(p.Tokens, mentionCandidate{spellings: spellings})
}

// parseMentionTokens extracts the mention tokens of a message in one pass over
// the content. At most maxMentionCandidates distinct tokens of all forms are
// kept.
func parseMentionTokens(content string) parsedMentions {
	out := parsedMentions{
		seenName: make(map[string]struct{}),
		seenUser: make(map[int64]struct{}),
		seenRole: make(map[int64]struct{}),
	}
	for _, m := range mentionTokenRe.FindAllStringSubmatch(content, -1) {
		switch {
		case m[2] != "": // <@id> or <@&id>
			out.addID(m[2], m[1] == "&")
		case m[5] == "@":
			// address-shaped, e.g. "@bob@example.com"
		default:
			out.addName(m[4])
		}
		if out.size() >= maxMentionCandidates {
			break
		}
	}
	return out
}
