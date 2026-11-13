package linkpreview

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxLinksPerMessage is how many links of one message get a card, the count the client draws.
const MaxLinksPerMessage = 5

// Link is one link of a message, in the form that is fetched and stored.
type Link struct {
	// URL is the normalised link.
	URL string
	// Hash is the URLHash of URL.
	Hash string
}

// Links returns the distinct links of a message that get a card: those ExtractURLs finds that
// NormalizeURL accepts, at most MaxLinksPerMessage, in the order they appear.
func Links(content string) []Link {
	var out []Link
	seen := make(map[string]struct{}, MaxLinksPerMessage)
	for _, raw := range ExtractURLs(content) {
		hash, norm, err := URLHash(raw)
		if err != nil {
			continue
		}
		if _, dup := seen[hash]; dup {
			continue
		}
		seen[hash] = struct{}{}
		out = append(out, Link{URL: norm, Hash: hash})
		if len(out) == MaxLinksPerMessage {
			break
		}
	}
	return out
}

// ExtractURLs returns the http and https links in a message's text that the client previews. It
// mirrors extractUrls in Client/src/features/messaging/content/media.ts step for step, and its
// regular expressions in contentRegex.ts, so server and client agree on which links a message
// has. Code blocks and spans, masked links, spoilers and <angle> links are removed first, in
// that order; the links left have sentence punctuation stripped as the linkifier does.
func ExtractURLs(content string) []string {
	s := removeCodeBlocks(content)
	s = removeInlineCode(s)
	s = removeMaskedLinks(s)
	s = removeSpoilers(s)
	s = removeAngleLinks(s)
	return scanURLs(s)
}

// removeMatches deletes the spans match reports. match(s, i) returns the end of a match
// starting at i, or -1; after a match scanning resumes at its end, after a miss at i+1.
func removeMatches(s string, match func(s string, i int) int) string {
	var b strings.Builder
	last := 0
	for i := 0; i < len(s); {
		end := match(s, i)
		if end < 0 {
			i++
			continue
		}
		b.WriteString(s[last:i])
		last = end
		if end == i {
			i++
			continue
		}
		i = end
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

// removeCodeBlocks drops ```...``` spans (CODE_BLOCK_REGEX).
func removeCodeBlocks(s string) string {
	return removeMatches(s, func(s string, i int) int {
		if !strings.HasPrefix(s[i:], "```") {
			return -1
		}
		j := strings.Index(s[i+3:], "```")
		if j < 0 {
			return -1
		}
		return i + 3 + j + 3
	})
}

// removeInlineCode drops `...` spans of one or more non-backtick characters (INLINE_CODE_REGEX).
func removeInlineCode(s string) string {
	return removeMatches(s, func(s string, i int) int {
		if s[i] != '`' {
			return -1
		}
		j := strings.IndexByte(s[i+1:], '`')
		if j <= 0 {
			return -1
		}
		return i + 1 + j + 1
	})
}

// jsSpace is the JavaScript \s class, which differs from unicode.IsSpace at U+0085 and U+FEFF.
func jsSpace(r rune) bool {
	if r == 0x85 {
		return false
	}
	return r == 0xFEFF || unicode.IsSpace(r)
}

// removeMaskedLinks drops [text](url) spans (MASKED_LINK_REGEX).
func removeMaskedLinks(s string) string {
	return removeMatches(s, matchMasked)
}

func matchMasked(s string, i int) int {
	if s[i] != '[' {
		return -1
	}
	j := i + 1
	for j < len(s) && s[j] != ']' && s[j] != '\n' {
		j++
	}
	if j == i+1 || j >= len(s) || s[j] != ']' {
		return -1
	}
	j++
	if j >= len(s) || s[j] != '(' {
		return -1
	}
	j++
	groups := 0
	for j < len(s) {
		r, n := utf8.DecodeRuneInString(s[j:])
		switch {
		case r == '(':
			k := j + 1
			for k < len(s) {
				r2, n2 := utf8.DecodeRuneInString(s[k:])
				if r2 == '(' || r2 == ')' || jsSpace(r2) {
					break
				}
				k += n2
			}
			if k >= len(s) || s[k] != ')' {
				return -1
			}
			j = k + 1
		case r == ')' || jsSpace(r):
			if groups == 0 || r != ')' {
				return -1
			}
			return j + 1
		default:
			j += n
		}
		groups++
	}
	return -1
}

// removeSpoilers drops ||hidden|| spans (SPOILER_REGEX): an opener not followed by a third
// pipe, one or more characters where a backslash takes the next one with it and "||" ends the
// span, then the closer.
func removeSpoilers(s string) string {
	return removeMatches(s, func(s string, i int) int {
		if !strings.HasPrefix(s[i:], "||") || (i+2 < len(s) && s[i+2] == '|') {
			return -1
		}
		j, items := i+2, 0
		for j < len(s) {
			if s[j] == '\\' {
				if j+1 >= len(s) {
					break
				}
				j += 2
			} else if strings.HasPrefix(s[j:], "||") {
				break
			} else {
				j++
			}
			items++
		}
		if items == 0 || !strings.HasPrefix(s[j:], "||") {
			return -1
		}
		return j + 2
	})
}

// removeAngleLinks drops <http(s)://...> spans that are not escaped by an odd run of
// backslashes (ANGLE_URL_REGEX), the way an author asks for no preview.
func removeAngleLinks(s string) string {
	return removeMatches(s, func(s string, i int) int {
		if s[i] != '<' || backslashesBefore(s, i)%2 == 1 {
			return -1
		}
		rest := s[i+1:]
		if len(rest) < 4 || !strings.EqualFold(rest[:4], "http") {
			return -1
		}
		rest = rest[4:]
		n := 4
		if rest != "" && (rest[0] == 's' || rest[0] == 'S') {
			rest, n = rest[1:], n+1
		}
		if !strings.HasPrefix(rest, "://") {
			return -1
		}
		j := i + 1 + n + 3
		start := j
		for j < len(s) {
			r, w := utf8.DecodeRuneInString(s[j:])
			if r == '<' || r == '>' || jsSpace(r) {
				break
			}
			j += w
		}
		if j == start || j >= len(s) || s[j] != '>' {
			return -1
		}
		return j + 1
	})
}

func backslashesBefore(s string, i int) int {
	n := 0
	for i-n-1 >= 0 && s[i-n-1] == '\\' {
		n++
	}
	return n
}

// scanURLs finds https?://[^\s<>"']+ runs (URL_REGEX) and strips their trailing punctuation.
func scanURLs(s string) []string {
	var out []string
	for i := 0; i < len(s); {
		j := strings.Index(s[i:], "http")
		if j < 0 {
			break
		}
		i += j
		k := i + 4
		if k < len(s) && s[k] == 's' {
			k++
		}
		if !strings.HasPrefix(s[k:], "://") {
			i++
			continue
		}
		k += 3
		start := k
		for k < len(s) {
			r, w := utf8.DecodeRuneInString(s[k:])
			if jsSpace(r) || r == '<' || r == '>' || r == '"' || r == '\'' {
				break
			}
			k += w
		}
		if k == start {
			i++
			continue
		}
		out = append(out, stripTrailingPunctuation(s[i:k]))
		i = k
	}
	return out
}

// stripTrailingPunctuation is stripUrlTrailingPunctuation in contentRegex.ts: it drops trailing
// sentence punctuation, giving back one ")" that balances a "(" earlier in the link.
func stripTrailingPunctuation(raw string) string {
	stripped := strings.TrimRight(raw, ".,;:!?)")
	if len(raw) > len(stripped) && raw[len(stripped)] == ')' &&
		strings.Count(stripped, "(") > strings.Count(stripped, ")") {
		stripped += ")"
	}
	if stripped == "" {
		return raw
	}
	return stripped
}
