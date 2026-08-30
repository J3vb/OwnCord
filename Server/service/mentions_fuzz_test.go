package service

import (
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// fuzzSpellingRe mirrors the token charset mentionTokenRe captures: letters,
// digits, underscore, dot and hyphen, 1-64 runes. Every candidate spelling
// parseMentionTokens returns must match it -- if it doesn't, the parser
// leaked something outside its own documented token shape.
var fuzzSpellingRe = regexp.MustCompile(`^[\p{L}\p{N}_.-]{1,64}$`)

// FuzzParseMentionTokens shakes out panics and contract violations in
// parseMentionTokens: unicode, RTL overrides, combining marks, null bytes,
// pathological runs of "@", and address-shaped text that must never yield a
// bare mention.
func FuzzParseMentionTokens(f *testing.F) {
	seeds := []string{
		"",
		"@bob",
		"@@bob",
		"@@@",
		"mail@example.com",
		"a@b",
		"@a@b@c",
		"@bob@example.com",
		"@everyone",
		"@here",
		"@EVERYONE",
		"@Here",
		strings.Repeat("@", 10000),
		strings.Repeat("@a", 5000),
		"@bob.",
		"@bob-",
		"@bob_baz.qux",
		"\U0001F642@bob\U0001F642", // emoji either side of the token
		" @bob ",
		"cafe\u0301@bob",   // combining acute accent (e + U+0301)
		"\u202e@bob\u202e", // RTL override (U+202E)
		"\u200f@bob",       // RTL mark (U+200F)
		"@\u0301",          // bare combining mark as the token itself
		"@bob\x00carol",    // embedded NUL
		strings.Repeat("a", 2000) + "@" + strings.Repeat("b", 2000),
		"@" + strings.Repeat("x", 100),
		"@" + strings.Repeat("x", 63) + "y" + strings.Repeat("z", 63),
		"(@bob), @carol!",
		"@" + strings.Repeat("\U0001F600", 100),
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, content string) {
		tokens, everyone, here := parseMentionTokens(content)

		if len(tokens) > maxMentionCandidates {
			t.Fatalf("token count %d exceeds cap %d", len(tokens), maxMentionCandidates)
		}

		seen := make(map[string]bool, len(tokens))
		for _, tok := range tokens {
			if len(tok.spellings) == 0 {
				t.Fatalf("candidate with zero spellings for content %q", content)
			}
			for _, sp := range tok.spellings {
				if sp == "" {
					t.Fatalf("empty spelling in candidate for content %q", content)
				}
				if strings.Contains(sp, "@") {
					t.Fatalf("spelling %q retained an '@' -- address-shaped text leaked a mention (content %q)", sp, content)
				}
				// db.LowerASCII, not strings.ToLower: parseMentionTokens folds
				// ASCII only, because usernames.username is COLLATE NOCASE and a
				// Unicode fold would desync the token from
				// GetUserIDsByUsernames' equally ASCII-folded map key (OC-0131).
				if sp != db.LowerASCII(sp) {
					t.Fatalf("spelling %q is not ASCII-lowercased", sp)
				}
				if !fuzzSpellingRe.MatchString(sp) {
					t.Fatalf("spelling %q outside the token charset (content %q)", sp, content)
				}
				if sp == everyoneToken || sp == hereToken {
					t.Fatalf("reserved token %q leaked into resolvable candidates", sp)
				}
			}
			primary := tok.spellings[0]
			if seen[primary] {
				t.Fatalf("duplicate candidate %q returned (content %q)", primary, content)
			}
			seen[primary] = true
		}

		// @everyone/@here flags must only ever be set for the literal reserved
		// words; the substring check is a necessary (not sufficient) condition
		// that still catches a parser gone wrong on unrelated input.
		lower := strings.ToLower(content)
		if everyone && !strings.Contains(lower, everyoneToken) {
			t.Fatalf("everyone=true but content has no %q substring: %q", everyoneToken, content)
		}
		if here && !strings.Contains(lower, hereToken) {
			t.Fatalf("here=true but content has no %q substring: %q", hereToken, content)
		}
	})
}
