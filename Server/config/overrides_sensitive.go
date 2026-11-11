package config

import (
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/J3vb/OwnCord/Server/clientip"
)

// secretKeys is the set of panel-editable keys whose value is write-only: settable or clearable, but never
// in any response, log line or audit row. The exact-set test pins it.
var secretKeys = map[string]bool{
	"gif.api_key":              true,
	"github.token":             true,
	"voice.livekit_api_key":    true,
	"voice.livekit_api_secret": true,
}

// confirmKeys is the set of keys whose wrong value can lock the owner out of the panel, move the server's
// data or make it execute a host file. A PATCH naming one must carry it in X-OwnCord-Confirm. The exact-set
// test pins it.
var confirmKeys = map[string]bool{
	"backup.dir":                 true,
	"database.path":              true,
	"plugins.directory":          true,
	"server.admin_allowed_cidrs": true,
	"server.port":                true,
	"server.restart_mode":        true,
	"server.trusted_proxies":     true,
	"tls.acme_cache_dir":         true,
	"tls.cert_file":              true,
	"tls.domain":                 true,
	"tls.key_file":               true,
	"tls.mode":                   true,
	"upload.storage_dir":         true,
	"voice.livekit_binary":       true,
}

// IsSecret reports whether a panel-editable key is write-only.
func IsSecret(key string) bool { return secretKeys[key] }

// SecretAllowsEmpty reports whether a secret key's rule accepts an empty string, so the panel offers "Clear
// value" only where valid. It asks the rule itself so the classification cannot drift from validation.
func SecretAllowsEmpty(key string) bool {
	if !secretKeys[key] {
		return false
	}
	rule, ok := editableRules[key]
	if !ok {
		return false
	}
	_, err := rule("")
	return err == nil
}

// RequiresConfirmation reports whether a PATCH naming key must carry the typed-confirmation header.
func RequiresConfirmation(key string) bool { return confirmKeys[key] }

// secretRule validates a write-only secret: a string with no control characters or whitespace, within [min,
// max] bytes; messages never echo the value.
func secretRule(min, max int) func(any) (any, error) {
	return func(v any) (any, error) {
		s, err := cleanString(v)
		if err != nil {
			return nil, err
		}
		if strings.ContainsAny(s, " \t\r\n") {
			return nil, fmt.Errorf("must not contain whitespace")
		}
		if len(s) < min || len(s) > max {
			return nil, fmt.Errorf("must be %d to %d bytes", min, max)
		}
		return s, nil
	}
}

// liveKitKeyRule refuses an empty key (Load regenerates one every boot) and the public placeholder
// credentials.
func liveKitKeyRule(v any) (any, error) {
	raw, err := secretRule(3, 255)(v)
	if err != nil {
		return nil, err
	}
	key := raw.(string)
	if key == DefaultLiveKitAPIKey || strings.HasPrefix(key, placeholderCredentialPrefix) {
		return nil, fmt.Errorf("must not be the default or placeholder credentials")
	}
	return key, nil
}

// liveKitSecretRule refuses an empty secret and the public placeholder credentials.
func liveKitSecretRule(v any) (any, error) {
	raw, err := secretRule(32, 512)(v)
	if err != nil {
		return nil, err
	}
	secret := raw.(string)
	if secret == DefaultLiveKitAPISecret || strings.HasPrefix(secret, placeholderCredentialPrefix) {
		return nil, fmt.Errorf("must not be the default or placeholder credentials")
	}
	return secret, nil
}

var githubOwnerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)

func githubOwnerRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if !githubOwnerRe.MatchString(s) {
		return nil, fmt.Errorf("must be a GitHub owner name (letters, digits, hyphens)")
	}
	return s, nil
}

var githubRepoRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

func githubRepoRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s == "." || s == ".." || !githubRepoRe.MatchString(s) {
		return nil, fmt.Errorf("must be a GitHub repository name")
	}
	return s, nil
}

// portRule accepts a listen port minus LiveKit's API (7880), TCP media (7881) and pprof (6060) ports.
func portRule(v any) (any, error) {
	n, ok := wholeInt(v)
	if !ok || n < 1 || n > 65535 {
		return nil, fmt.Errorf("want an integer in [1, 65535]")
	}
	if n == 7880 || n == 7881 || n == 6060 {
		return nil, fmt.Errorf("%d is reserved", n)
	}
	return n, nil
}

// tlsDomainRule accepts an empty domain or a bare hostname: at most 253 bytes, no scheme, port or path.
func tlsDomainRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s == "" {
		return s, nil
	}
	if len(s) > 253 || !isHostname(s) || net.ParseIP(s) != nil {
		return nil, fmt.Errorf("must be empty or a hostname with no scheme or port")
	}
	return s, nil
}

func isHostname(s string) bool {
	if strings.ContainsAny(s, ":/") {
		return false
	}
	for label := range strings.SplitSeq(s, ".") {
		if !isHostLabel(label) {
			return false
		}
	}
	return true
}

func isHostLabel(label string) bool {
	if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, r := range label {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return false
	}
	return true
}

// pathRule accepts a clean, non-empty path; relative paths stay allowed since the defaults are relative.
func pathRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if err := checkPath(s); err != nil {
		return nil, err
	}
	return s, nil
}

func checkPath(s string) error {
	if s == "" {
		return fmt.Errorf("must be a non-empty path")
	}
	if len(s) > 4096 {
		return fmt.Errorf("must be at most 4096 bytes")
	}
	if strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 }) {
		return fmt.Errorf("must not contain control characters")
	}
	clean := filepath.FromSlash(s)
	if filepath.Clean(clean) != clean {
		return fmt.Errorf("must be a clean path")
	}
	return nil
}

func liveKitBinaryRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s == "" {
		return s, nil
	}
	if err := checkPath(s); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(s) {
		return nil, fmt.Errorf("must be an absolute path")
	}
	if !strings.Contains(strings.ToLower(filepath.Base(s)), "livekit") {
		return nil, fmt.Errorf("must name a livekit binary")
	}
	return s, nil
}

// checkTrustedProxy rejects an entry covering every address: it would let any client forge X-Forwarded-For
// past the perimeter and rate limits.
func checkTrustedProxy(s string) error {
	if err := checkCIDR(s); err != nil {
		return err
	}
	if _, found := clientip.FirstCatchAll([]string{s}); found {
		return fmt.Errorf("entry %q must not trust every address", s)
	}
	return nil
}
