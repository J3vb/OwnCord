package admin

import (
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/config"
)

// events.json detail: a record's attributes, so a coded failure carries its
// reason. Two rules apply, keys first:
//
//   - An attribute whose key names an identifier, a person, an address, a
//     location or a credential (supportIdentifyingKey) is dropped whatever its
//     value. Only string, number and boolean values survive; groups and lists
//     (resolved LogValuers such as db.User) are dropped.
//   - Every surviving string is scrubbed (supportScrub): URLs, emails, paths,
//     IP addresses, token-like runs, credentials after an auth scheme or a
//     password/token label, and hostnames are replaced by a fixed
//     placeholder, and identifying keys embedded in the text as JSON or
//     key=value pairs (LiveKit's own log fields) are redacted by the same key
//     rule.
//
// Values the server already knows to be identifying (registered usernames and
// display names, the server name, the hosts of configured addresses) are also
// redacted wherever they appear in text. An unregistered bare word in free text
// (a name that is not an account, a hostname without a dot or port) cannot be
// told apart from other text and is not caught. The free-form message itself is
// still never kept: only its fixed event code.

const (
	supportDetailMaxKeys  = 8
	supportDetailMaxValue = 256
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
	supportIdentifyingWords = []string{"id", "ids", "sid", "pid", "ip", "ips"}
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
	supportURLPattern    = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]+`)
	supportEmailPattern  = regexp.MustCompile(`[^\s@"'<>(){}\[\],;:]+@[^\s@"'<>(){}\[\],;:]+`)
	supportJSONKVPattern = regexp.MustCompile(`"([A-Za-z0-9_.-]+)"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\s]+)`)
	supportKVPattern     = regexp.MustCompile(`\b([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s,]+)`)
	// A path starts at the beginning, after whitespace, a quote, "=" or an
	// opening bracket, so a source reference like "rtc/participant.go:12"
	// survives while "/home/alice/data" does not.
	supportPathPattern = regexp.MustCompile(`(^|[\s"'=(\[])((?:[A-Za-z]:)?(?:[\\/][^\s\\/:"'<>,;()\[\]{}]+){2,}[\\/]?)`)
	supportIPv6Pattern = regexp.MustCompile(`(?i)\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?`)
	supportIPv4Pattern = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	// A run long enough to be a credential, session id, UUID or JWT.
	supportTokenPattern = regexp.MustCompile(`[A-Za-z0-9_\-+/=.]{20,}`)
	// Everything after a home directory root up to a quote or the end, so a
	// space in a name cannot leave a fragment.
	supportHomePattern = regexp.MustCompile(`(?i)(?:/home/|/Users/|[A-Za-z]:\\Users\\)[^"'\r\n]*`)
	// "nas:7880": a single-label host with a port. A leading "." or "/" is
	// excluded so "participant.go:12" stays a source reference.
	supportHostPortPattern = regexp.MustCompile(`(^|[^\w./-])([A-Za-z][\w-]*):(\d{2,5})\b`)
	supportLocalhost       = regexp.MustCompile(`(?i)\blocalhost\b`)
	supportHostPattern     = regexp.MustCompile(`(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b`)
	// Dotted names ending in these are source or data files, not hosts.
	supportFileExtensions = []string{"go", "ts", "js", "mjs", "json", "yaml", "yml", "toml", "txt", "log", "sql", "db", "html", "css", "exe", "dll", "sock", "pem", "crt"}
)

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
// length is redacted without mangling the words that contain it.
type supportKnown map[string][][]string

var supportWordPattern = regexp.MustCompile(`[\p{L}\p{N}_]+`)

// newSupportKnown returns nil when no value has a word in it.
func newSupportKnown(values []string) supportKnown {
	k := supportKnown{}
	for _, v := range values {
		words := supportWordPattern.FindAllString(strings.ToLower(v), -1)
		if len(words) > 0 {
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
		b.WriteString("[name]")
		last = spans[i+n-1][1]
		i += n - 1
	}
	b.WriteString(s[last:])
	return b.String()
}

// A credential following its scheme or label: "Bearer x", "password: x",
// "token Xy9q". After a bare label (no ":" or "="), only a word that looks
// like a token (a digit, an upper-case letter or a symbol) is taken, so
// "token expired" stays readable.
var (
	supportCredentialPattern = regexp.MustCompile(`(?i)\b(authorization|password|passwd|pwd|secret|token|api[_-]?key|credentials?)(\s*[:=]\s*|\s+)((?:(?:bearer|basic|digest)\s+)?(?:"[^"]*"|[^\s,;]+))`)
	supportSchemePattern     = regexp.MustCompile(`(?i)\b(bearer|basic|digest)\s+([^\s,;\[]\S*)`)
)

func supportScrubCredentials(s string) string {
	s = supportCredentialPattern.ReplaceAllStringFunc(s, func(m string) string {
		sub := supportCredentialPattern.FindStringSubmatch(m)
		value := sub[3]
		if strings.HasPrefix(value, "[") || strings.TrimSpace(sub[2]) == "" && strings.IndexFunc(value, func(r rune) bool { return r < 'a' || r > 'z' }) < 0 {
			return m
		}
		return sub[1] + sub[2] + "[redacted]"
	})
	return supportSchemePattern.ReplaceAllString(s, "${1} [redacted]")
}

func supportScrub(s string, known supportKnown) string {
	s = supportURLPattern.ReplaceAllString(s, "[url]")
	s = supportEmailPattern.ReplaceAllString(s, "[email]")
	s = known.scrub(s)
	s = supportJSONKVPattern.ReplaceAllStringFunc(s, func(m string) string {
		sub := supportJSONKVPattern.FindStringSubmatch(m)
		if !supportIdentifyingKey(sub[1]) {
			return m
		}
		return `"` + sub[1] + `"` + sub[2] + `"[redacted]"`
	})
	s = supportKVPattern.ReplaceAllStringFunc(s, func(m string) string {
		sub := supportKVPattern.FindStringSubmatch(m)
		if !supportIdentifyingKey(sub[1]) {
			return m
		}
		return sub[1] + "=[redacted]"
	})
	s = supportHomePattern.ReplaceAllString(s, "[path]")
	s = supportPathPattern.ReplaceAllString(s, "${1}[path]")
	s = supportIPv6Pattern.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Trim(m, ":") == "" {
			return m
		}
		return "[ip]"
	})
	s = supportIPv4Pattern.ReplaceAllString(s, "[ip]")
	s = supportTokenPattern.ReplaceAllString(s, "[token]")
	s = supportScrubCredentials(s)
	s = supportHostPortPattern.ReplaceAllString(s, "${1}[host]:${3}")
	s = supportLocalhost.ReplaceAllString(s, "[host]")
	return supportHostPattern.ReplaceAllStringFunc(s, func(m string) string {
		if slices.Contains(supportFileExtensions, strings.ToLower(m[strings.LastIndexByte(m, '.')+1:])) {
			return m
		}
		return "[host]"
	})
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

func supportTruncate(s string) string {
	if len(s) <= supportDetailMaxValue {
		return s
	}
	cut := supportDetailMaxValue
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
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
