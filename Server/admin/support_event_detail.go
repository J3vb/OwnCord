package admin

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// events.json detail: a record's attributes, so a coded failure carries its
// reason. Two rules apply, keys first:
//
//   - An attribute whose key names an identifier, a person, an address, a
//     location or a credential (supportIdentifyingKey) is dropped whatever its
//     value. Only string, number and boolean values survive; groups and lists
//     (resolved LogValuers such as db.User) are dropped.
//   - Every surviving string is scrubbed (supportScrub): URLs, emails, paths,
//     IP addresses, token-like runs and hostnames are replaced by a fixed
//     placeholder, and identifying keys embedded in the text as JSON or
//     key=value pairs (LiveKit's own log fields) are redacted by the same key
//     rule.
//
// A username or hostname written as a bare word in prose, with no key or
// dotted form to recognise, cannot be told apart from other text and is not
// caught. The free-form message itself is still never kept: only its fixed
// event code.

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
	// A run long enough to be a credential, session id, UUID or JWT. It must
	// mix letters and digits, so long snake_case words survive.
	supportTokenPattern = regexp.MustCompile(`[A-Za-z0-9_\-+/=.]{20,}`)
	supportHostPattern  = regexp.MustCompile(`(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b`)
	// Dotted names ending in these are source or data files, not hosts.
	supportFileExtensions = []string{"go", "rs", "ts", "js", "mjs", "json", "yaml", "yml", "toml", "txt", "log", "sql", "db", "md", "html", "css", "exe", "dll", "so", "sock", "pem", "crt", "zip"}
)

func supportScrub(s string) string {
	s = supportURLPattern.ReplaceAllString(s, "[url]")
	s = supportEmailPattern.ReplaceAllString(s, "[email]")
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
	s = supportPathPattern.ReplaceAllString(s, "${1}[path]")
	s = supportIPv6Pattern.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Trim(m, ":") == "" {
			return m
		}
		return "[ip]"
	})
	s = supportIPv4Pattern.ReplaceAllString(s, "[ip]")
	s = supportTokenPattern.ReplaceAllStringFunc(s, func(m string) string {
		if strings.ContainsAny(m, "0123456789") && strings.IndexFunc(m, func(r rune) bool { return r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' }) >= 0 {
			return "[token]"
		}
		return m
	})
	return supportHostPattern.ReplaceAllStringFunc(s, func(m string) string {
		if slices.Contains(supportFileExtensions, strings.ToLower(m[strings.LastIndexByte(m, '.')+1:])) {
			return m
		}
		return "[host]"
	})
}

// supportDetail returns the kept attributes of one record's attrs JSON, or nil
// when none survive.
func supportDetail(attrs string) map[string]any {
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
			out[key] = supportTruncate(supportScrub(v))
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
func supportAttachDetail(events []supportEvent, attrs []string) {
	used := 0
	for i := len(events) - 1; i >= 0; i-- {
		detail := supportDetail(attrs[i])
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
