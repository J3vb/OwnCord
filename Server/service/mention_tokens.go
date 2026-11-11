package service

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
)

// mentionTokenRe finds every mention form in one pass. Alternative one is the id form
// "<@123>" (user; group 2 the id) or "<@&5>" (role; group 1 "&"), tried first so the "<"
// of "<@7>" is never the preceding character of a legacy @7. Alternative two is the
// legacy @token as a word: group 3 the preceding character (start or a non-word non-@
// rune, so "mail@example" and "@@name" never resolve), group 4 the token, group 5 a
// trailing "@" so "@bob@example.com" is rejected whole. Charset: letters, digits, _, . and -
// (usernames may hold any printable rune, but only this is addressable without a delimiter).
var mentionTokenRe = regexp.MustCompile(`<@(&?)([0-9]{1,18})>|(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{1,64})(@?)`)

type mentionCandidate struct {
	spellings []string
}

type parsedMentions struct {
	// Tokens are the legacy @username candidates: lowercased, distinct, in order of first
	// appearance. Reserved @everyone / @here are reported below, never resolved as usernames.
	Tokens []mentionCandidate
	// UserIDs and RoleIDs are the ids of <@id> and <@&id> tokens, distinct, in order; non-positive ids are
	// dropped.
	UserIDs        []int64
	RoleIDs        []int64
	Everyone, Here bool

	seenName map[string]struct{}
	seenUser map[int64]struct{}
	seenRole map[int64]struct{}
}

func (p *parsedMentions) size() int { return len(p.Tokens) + len(p.UserIDs) + len(p.RoleIDs) }

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

func (p *parsedMentions) addName(token string) {
	// db.LowerASCII, not strings.ToLower: usernames.username is COLLATE NOCASE, which folds
	// ASCII only. A Unicode fold here would desync this token from GetUserIDsByUsernames'
	// ASCII-folded map key, so a username with an uppercase non-ASCII letter could never resolve.
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
		default:
			out.addName(m[4])
		}
		if out.size() >= maxMentionCandidates {
			break
		}
	}
	return out
}
