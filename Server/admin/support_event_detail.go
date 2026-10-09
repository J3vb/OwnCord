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
	supportJSONKVPattern = regexp.MustCompile(`"([A-Za-z0-9_.-]+)"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\s]+)`)
	supportKVPattern     = regexp.MustCompile(`\b([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s,]+)`)
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
	for _, w := range strings.Fields(supportVocabulary) {
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

// supportKnown holds the identifying values to redact, each split into
// lowercase word tokens and indexed by its first token, so any number of names
// costs O(words) per value. Matching is by whole words, so a name of any
// length is redacted without mangling the words that contain it. It catches a
// name that is also a vocabulary word, which the allowlist would keep.
type supportKnown map[string][][]string

var (
	supportWordPattern  = regexp.MustCompile(`[\p{L}\p{N}_]+`)
	supportAlnumPattern = regexp.MustCompile(`[\p{L}\p{N}]+`)
)

// newSupportKnown returns nil when no value is left.
func newSupportKnown(values []string) supportKnown {
	k := supportKnown{}
	for _, v := range values {
		words := supportWordPattern.FindAllString(strings.ToLower(v), -1)
		// A name with no letters or digits ("!!", an emoji) is kept whole
		// under "" and masked by supportAllowlist when it is a whole compound.
		if v = strings.TrimSpace(v); len(words) == 0 && v != "" {
			k[""] = append(k[""], []string{v})
		} else if len(words) > 0 {
			k[words[0]] = append(k[words[0]], words)
		}
	}
	if len(k) == 0 {
		return nil
	}
	return k
}

func (k supportKnown) scrub(s string) string {
	if len(k) == 0 {
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
		for _, name := range k[words[i]] {
			if len(name) > n && i+len(name) <= len(words) && slices.Equal(name, words[i:i+len(name)]) {
				n = len(name)
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
	return b.String()
}

func supportScrub(s string, known supportKnown) string {
	s = supportJSONKVPattern.ReplaceAllStringFunc(s, func(m string) string {
		sub := supportJSONKVPattern.FindStringSubmatch(m)
		if !supportIdentifyingKey(sub[1]) {
			return m
		}
		return `"` + sub[1] + `"` + sub[2] + `"[x]"`
	})
	s = supportKVPattern.ReplaceAllStringFunc(s, func(m string) string {
		sub := supportKVPattern.FindStringSubmatch(m)
		if !supportIdentifyingKey(sub[1]) {
			return m
		}
		return sub[1] + "=[x]"
	})
	s = supportCredentialPattern.ReplaceAllString(s, "${1}${2}[x]")
	s = supportSchemePattern.ReplaceAllString(s, "${1} [x]")
	s = supportIPv6Pattern.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Trim(m, ":") == "" {
			return m
		}
		return "[x]"
	})
	s = supportIPv4Pattern.ReplaceAllString(s, "[x]")
	return supportAllowlist(known.scrub(s), known[""])
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

func supportKeepCompound(c string, literals [][]string) bool {
	if slices.ContainsFunc(literals, func(l []string) bool { return l[0] == c }) {
		return false
	}
	if supportJoinedPattern.MatchString(c) && !slices.Contains(supportSlashWords, strings.ToLower(c)) {
		return false
	}
	return !slices.ContainsFunc(supportAlnumPattern.FindAllString(c, -1), func(w string) bool { return !supportKeepWord(w) })
}

// supportAllowlist replaces each compound that is not kept with [x]; masked
// compounds separated only by spaces ("Private Project") become one [x].
func supportAllowlist(s string, literals [][]string) string {
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
		case supportKeepCompound(compound, literals):
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
func supportDetail(attrs string, known supportKnown) map[string]any {
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
func supportAttachDetail(events []supportEvent, attrs []string, known supportKnown) {
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
