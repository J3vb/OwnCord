package admin

import (
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/config"
)

// events.json detail: a record's attributes, so a coded failure carries its
// reason. Two rules apply, keys first:
//
//   - An attribute whose key names an identifier, a person, an address, a
//     location, a credential or request data (supportIdentifyingKey) is
//     dropped whatever its value. Only string, number and boolean values
//     survive; groups and lists (resolved LogValuers such as db.User) are
//     dropped.
//   - Every surviving string is reduced to an allowlist (supportScrub): only
//     words in supportVocabulary, single characters, short numbers and
//     punctuation are kept, and every run of other words, with the path or
//     host punctuation joining them, becomes one [x]. Before that, values
//     that a kept word could otherwise expose are masked whole: identifying
//     keys embedded in the text as JSON or key=value pairs (LiveKit's own log
//     fields), credentials after a label or auth scheme, IP addresses, and
//     the values the server knows to be identifying (registered usernames and
//     display names, the server name, the hosts of configured addresses).
//
// What remains readable is error vocabulary, so a path, host, name or secret
// survives only where every word of it is itself an error-message word. The
// free-form message itself is still never kept: only its fixed event code.

const (
	supportDetailMaxKeys  = 8
	supportDetailMaxValue = 1024
	// supportDetailBudget bounds the serialized detail across all of
	// events.json, so supportMaxBytes is never reached however long or
	// numerous the attributes are. Newer events keep their detail first.
	supportDetailBudget = 128 << 10
)

// Substrings that make a key identifying anywhere in it, and whole words
// (split on non-alphanumerics) that do so only on their own.
var (
	supportIdentifyingParts = []string{
		"user", "name", "mail", "addr", "remote", "host", "path", "dir", "file", "url", "uri",
		"token", "secret", "key", "pass", "cookie", "session", "auth", "cred", "participant",
		"identity", "room", "channel", "nick", "phone", "origin", "referer", "domain", "endpoint",
		"query", "body", "content", "text", "note", "label", "value", "stored", "backup", "upload",
		"recipient", "sender", "actor", "target", "peer", "client", "member", "owner",
	}
	supportIdentifyingWords = []string{"data", "id", "ids", "sid", "pid", "ip", "ips"}
)

func supportIdentifyingKey(key string) bool {
	// "userID", "pID", "remoteIP": the camel-case suffix is lost to ToLower.
	for _, suffix := range []string{"ID", "Id", "IDs", "IP", "IPs"} {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	lower := strings.ToLower(key)
	for _, part := range supportIdentifyingParts {
		if strings.Contains(lower, part) {
			return true
		}
	}
	words := strings.FieldsFunc(lower, func(r rune) bool { return (r < 'a' || r > 'z') && (r < '0' || r > '9') })
	return slices.ContainsFunc(words, func(w string) bool { return slices.Contains(supportIdentifyingWords, w) })
}

var (
	supportJSONKeyPattern = regexp.MustCompile(`"([A-Za-z0-9_.-]+)"\s*:\s*`)
	supportKVPattern      = regexp.MustCompile(`\b([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s,]+)`)
	// A credential after its label runs to the next "," or ";", so a
	// password with spaces is masked whole; after an auth scheme it is the
	// next word.
	supportCredentialPattern = regexp.MustCompile(`(?i)\b(authorization|password|passwd|pwd|secret|token|api[_-]?key|credentials?)(\s*[:=]\s*)("[^"]*"|[^,;\r\n]+)`)
	supportSchemePattern     = regexp.MustCompile(`(?i)\b(bearer|basic|digest)\s+[^\s,;]+`)
	// Short numbers are kept, so addresses are masked before the allowlist.
	supportIPv6Pattern = regexp.MustCompile(`(?i)\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?`)
	supportIPv4Pattern = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	// A port, status code or duration: up to five digits and an optional unit.
	supportNumberPattern = regexp.MustCompile(`^\d{1,5}(?:ns|us|µs|ms|s|m|h|b|kb|mb|gb)?$`)
)

var supportVocabularySet = func() map[string]bool {
	set := map[string]bool{}
	for w := range strings.FieldsSeq(supportVocabulary) {
		set[w] = true
	}
	return set
}()

// supportKnownValues lists the identifying values the server holds: the given
// registered names plus the name and addresses in its configuration.
func supportKnownValues(cfg *config.Config, names []string) []string {
	out := slices.Clone(names)
	if cfg == nil {
		return out
	}
	out = append(out, cfg.Server.Name, cfg.Voice.NodeIP, cfg.TLS.Domain)
	for _, addr := range append([]string{cfg.Voice.LiveKitURL}, cfg.Server.AllowedOrigins...) {
		if u, err := url.Parse(addr); err == nil {
			out = append(out, u.Hostname())
		}
	}
	return out
}

// supportKnown holds the identifying values to redact in two tries: names
// split into lowercase word tokens, and names with no letters or digits ("!!",
// "[]", an emoji) by their bytes. A match walks one trie path, so any number
// of names, however many share a first word, costs O(name length) per
// position. Matching is by whole words, so a name of any length is redacted
// without mangling the words that contain it. It catches a name that is also a
// vocabulary word, which the allowlist would keep.
type supportKnown struct {
	words, literals supportTrie
}

type supportTrie struct {
	next map[string]*supportTrie
	end  bool
}

func (t *supportTrie) add(keys ...string) {
	for _, key := range keys {
		if t.next[key] == nil {
			if t.next == nil {
				t.next = map[string]*supportTrie{}
			}
			t.next[key] = &supportTrie{}
		}
		t = t.next[key]
	}
	t.end = true
}

var (
	supportWordPattern  = regexp.MustCompile(`[\p{L}\p{N}_]+`)
	supportAlnumPattern = regexp.MustCompile(`[\p{L}\p{N}]+`)
)

// newSupportKnown returns nil when no value is left.
func newSupportKnown(values []string) *supportKnown {
	k := &supportKnown{}
	for _, v := range values {
		words := supportWordPattern.FindAllString(strings.ToLower(v), -1)
		if v = strings.TrimSpace(v); len(words) == 0 && v != "" {
			bytes := make([]string, len(v))
			for i := 0; i < len(v); i++ {
				bytes[i] = v[i : i+1]
			}
			k.literals.add(bytes...)
		} else if len(words) > 0 {
			k.words.add(words...)
		}
	}
	if k.words.next == nil && k.literals.next == nil {
		return nil
	}
	return k
}

func (k *supportKnown) scrub(s string) string {
	if k == nil {
		return s
	}
	spans := supportWordPattern.FindAllStringIndex(s, -1)
	words := make([]string, len(spans))
	for i, sp := range spans {
		words[i] = strings.ToLower(s[sp[0]:sp[1]])
	}
	var b strings.Builder
	last := 0
	for i := 0; i < len(words); i++ {
		n := 0
		for j, t := i, &k.words; j < len(words); j++ {
			if t = t.next[words[j]]; t == nil {
				break
			}
			if t.end {
				n = j - i + 1
			}
		}
		if n == 0 {
			continue
		}
		b.WriteString(s[last:spans[i][0]])
		b.WriteString("[x]")
		last = spans[i+n-1][1]
		i += n - 1
	}
	b.WriteString(s[last:])
	return k.scrubLiterals(b.String())
}

// scrubLiterals masks the names with no letters or digits. One is masked only
// between structural separators or the ends of s, so it never splits a
// compound: a name "." or "/" cannot unjoin a host or path, and a name "[]" or
// "::" is masked before supportAllowlist splits it into kept separators.
func (k *supportKnown) scrubLiterals(s string) string {
	bounded := func(i int) bool {
		r, _ := utf8.DecodeRuneInString(s[i:])
		return i == len(s) || supportStructural(r)
	}
	var b strings.Builder
	last := 0
	for i := 0; i < len(s); {
		n := 0
		if r, _ := utf8.DecodeLastRuneInString(s[:i]); i == 0 || supportStructural(r) {
			for j, t := i, &k.literals; j < len(s); j++ {
				if t = t.next[s[j:j+1]]; t == nil {
					break
				}
				if t.end && bounded(j+1) {
					n = j + 1 - i
				}
			}
		}
		if n == 0 {
			_, size := utf8.DecodeRuneInString(s[i:])
			i += size
			continue
		}
		b.WriteString(s[last:i])
		b.WriteString("[x]")
		i += n
		last = i
	}
	b.WriteString(s[last:])
	return b.String()
}

// supportMaskJSON masks the value of each identifying key embedded in s as
// JSON, an array or object whole.
func supportMaskJSON(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range supportJSONKeyPattern.FindAllStringSubmatchIndex(s, -1) {
		if m[0] < last || !supportIdentifyingKey(s[m[2]:m[3]]) {
			continue
		}
		b.WriteString(s[last:m[1]])
		b.WriteString(`"[x]"`)
		last = m[1] + supportJSONValueLen(s[m[1]:])
	}
	b.WriteString(s[last:])
	return b.String()
}

// supportJSONValueLen returns the length of the JSON value s starts with: a
// string, an array or object to its closing bracket (all of s when it is
// unclosed), or a bare scalar up to a comma, closing bracket or space.
func supportJSONValueLen(s string) int {
	depth, quoted := 0, false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case quoted && c == '\\':
			i++
		case quoted:
			quoted = c != '"'
			if !quoted && depth == 0 {
				return i + 1
			}
		case c == '"':
			quoted = true
		case c == '[' || c == '{':
			depth++
		case c == ']' || c == '}':
			if depth == 0 {
				return i
			}
			if depth--; depth == 0 {
				return i + 1
			}
		case depth == 0 && (c == ',' || unicode.IsSpace(rune(c))):
			return i
		}
	}
	return len(s)
}

func supportScrub(s string, known *supportKnown) string {
	s = supportMaskJSON(s)
	s = supportKVPattern.ReplaceAllStringFunc(s, func(m string) string {
		sub := supportKVPattern.FindStringSubmatch(m)
		if !supportIdentifyingKey(sub[1]) {
			return m
		}
		return sub[1] + "=[x]"
	})
	s = supportCredentialPattern.ReplaceAllString(s, "${1}${2}[x]")
	s = supportSchemePattern.ReplaceAllString(s, "${1} [x]")
	s = supportIPv4Pattern.ReplaceAllString(s, "[x]")
	s = supportIPv6Pattern.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Trim(m, ":") == "" {
			return m
		}
		return "[x]"
	})
	return supportAllowlist(known.scrub(s))
}

// supportStructural separators, like spaces, split a value into compounds;
// they stay visible and shape an error ("dial tcp [x]:7880: connect"). A
// compound ("nas", "not_found", "i/o") is kept only when every word in it is.
func supportStructural(r rune) bool {
	return unicode.IsSpace(r) || strings.ContainsRune(`:,;"'()[]{}=<>`, r)
}

func supportKeepWord(w string) bool {
	return utf8.RuneCountInString(w) == 1 || supportVocabularySet[strings.ToLower(w)] || supportNumberPattern.MatchString(strings.ToLower(w))
}

// A compound joined by a path, host or address separator ("/backup",
// "backups/archive.zip", "chat.example.rs", "a@b") is masked whole even when
// its words are vocabulary, except the few slash words of error text.
var (
	supportJoinedPattern = regexp.MustCompile(`[/\\@]|\pL\.\pL`)
	supportSlashWords    = []string{"i/o", "n/a", "and/or"}
)

func supportKeepCompound(c string) bool {
	if supportJoinedPattern.MatchString(c) && !slices.Contains(supportSlashWords, strings.ToLower(c)) {
		return false
	}
	return !slices.ContainsFunc(supportAlnumPattern.FindAllString(c, -1), func(w string) bool { return !supportKeepWord(w) })
}

// supportAllowlist replaces each compound that is not kept with [x]; masked
// compounds separated only by spaces ("Private Project") become one [x].
func supportAllowlist(s string) string {
	var b strings.Builder
	spaces := ""    // spaces after a masked compound, written only if a kept one follows
	masked := false // the last compound written was [x]
	for s != "" {
		if r, size := utf8.DecodeRuneInString(s); supportStructural(r) {
			if masked && unicode.IsSpace(r) {
				spaces += s[:size]
			} else {
				b.WriteString(spaces + s[:size])
				spaces, masked = "", false
			}
			s = s[size:]
			continue
		}
		end := strings.IndexFunc(s, supportStructural)
		if end < 0 {
			end = len(s)
		}
		compound := s[:end]
		s = s[end:]
		switch {
		case supportKeepCompound(compound):
			b.WriteString(spaces + compound)
			masked = false
		case !masked:
			b.WriteString(spaces + "[x]")
			masked = true
		}
		spaces = ""
	}
	b.WriteString(spaces)
	return b.String()
}

// supportDetail returns the kept attributes of one record's attrs JSON, or nil
// when none survive.
func supportDetail(attrs string, known *supportKnown) map[string]any {
	var raw map[string]any
	if attrs == "" || json.Unmarshal([]byte(attrs), &raw) != nil {
		return nil
	}
	keys := make([]string, 0, len(raw))
	for key := range raw {
		if len(key) <= 64 && !supportIdentifyingKey(key) {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	out := map[string]any{}
	for _, key := range keys {
		if len(out) == supportDetailMaxKeys {
			break
		}
		switch v := raw[key].(type) {
		case bool, float64:
			out[key] = v
		case string:
			out[key] = supportTruncate(supportScrub(v, known))
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// supportTruncate keeps the head and the tail of an over-long value, since a
// log line carries its error field last.
func supportTruncate(s string) string {
	if len(s) <= supportDetailMaxValue {
		return s
	}
	head, tail := supportDetailMaxValue/2, len(s)-supportDetailMaxValue/2
	for head > 0 && !utf8.RuneStart(s[head]) {
		head--
	}
	for tail < len(s) && !utf8.RuneStart(s[tail]) {
		tail++
	}
	return s[:head] + "…" + s[tail:]
}

// supportAttachDetail fills Detail on events, newest first, until
// supportDetailBudget is spent; older events past it keep only their code.
func supportAttachDetail(events []supportEvent, attrs []string, known *supportKnown) {
	used := 0
	for i := len(events) - 1; i >= 0; i-- {
		detail := supportDetail(attrs[i], known)
		if detail == nil {
			continue
		}
		data, err := json.Marshal(detail)
		if err != nil || used+len(data) > supportDetailBudget {
			continue
		}
		used += len(data)
		events[i].Detail = detail
	}
}
