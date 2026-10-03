package config

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// maxMiB is the largest MiB value that still fits an int64 after the byte
// helpers shift by 20.
const maxMiB = math.MaxInt64 >> 20

// Service-owned limits redeclared here so config need not import service (an
// import cycle): server.name's byte cap matches service (settings_values.go),
// and upload.max_size_mb's cap matches service.MaxUploadSizeMB.
const (
	maxServerNameBytes = 100
	maxUploadSizeMB    = 10240
)

// editableRules is the single registry of panel-editable keys. Each entry
// validates one JSON-decoded value and returns the normalised Go value to
// store. Adding a key is one row here plus a rule; the exact-inventory test
// pins the set at 50. The 27 excluded keys (secrets, host paths, the
// listener/TLS identity, the panel perimeter, the update source, pprof, and
// the live upload lists) are deliberately absent.
var editableRules = map[string]func(any) (any, error){
	// Integers.
	"attention.delivery_drops_per_min":          intRule(1, 1_000_000),
	"attention.disk_warn_free_mb":               intRule(0, maxMiB),
	"attention.reconnects_per_min":              intRule(1, 1_000_000),
	"attention.writer_wait_ms_per_min":          intRule(1, 60_000),
	"database.max_readers":                      intRule(0, 64),
	"event_persistence.batch_flush_ms":          intRule(1, 60_000),
	"event_persistence.batch_size":              intRule(1, 10_000),
	"event_persistence.pruner_interval_minutes": intRule(1, 10_080),
	"event_persistence.replay_cold_limit":       intRule(0, 1_000_000),
	"event_persistence.replay_ring_size":        intRule(1, 1_000_000),
	"event_persistence.retention_hours":         intRule(1, 8_760),
	"moderation.action_retention_days":          intRule(0, 3_650),
	"moderation.report_retention_days":          intRule(0, 3_650),
	"plugins.cpu_budget_ms":                     intRule(1, 60_000),
	"plugins.max_memory_mb":                     intRule(1, 4_096),
	"push.subscription_ttl_days":                intRule(1, 3_650),
	"security.expensive_auth_concurrency":       intRule(0, 4_096),
	"server.max_ws_connections":                 intRule(0, 1_000_000),
	"server.min_free_disk_mb":                   intRule(0, maxMiB),
	"server.waf_paranoia_level":                 intRule(1, 4),
	"upload.max_size_mb":                        intRule(1, maxUploadSizeMB),
	"upload.user_quota_mb":                      intRule(0, maxMiB),
	"voice.udp_port":                            udpPortRule,

	// Booleans.
	"event_persistence.enabled":          boolRule,
	"plugins.enabled":                    boolRule,
	"push.dispatch_enabled":              boolRule,
	"push.enabled":                       boolRule,
	"server.browser_client_enabled":      boolRule,
	"server.reachability_report_enabled": boolRule,
	"server.waf_enabled":                 boolRule,
	"telemetry.enabled":                  boolRule,
	"telemetry.otlp_insecure":            boolRule,
	"voice.advertise_internal_ip":        boolRule,
	"voice.auto_download_livekit":        boolRule,

	// Floats.
	"security.auth_rate_limit_multiplier": authMultiplierRule,

	// Enums.
	"logging.level":       enumRule("debug", "info", "warn", "error"),
	"server.waf_crs_mode": enumRule("off", "detect", "block"),
	"telemetry.exporter":  enumRule("none", "prometheus", "otlp"),
	"voice.quality":       enumRule("low", "medium", "high"),

	// Strings.
	"server.name":             serverNameRule,
	"push.contact":            contactRule,
	"telemetry.otlp_endpoint": otlpEndpointRule,
	"telemetry.service_name":  serviceNameRule,
	"voice.livekit_url":       liveKitURLRule,
	"voice.livekit_version":   liveKitVersionRule,
	"voice.node_ip":           nodeIPRule,

	// Lists.
	"server.allowed_origins":               listRule(checkOrigin),
	"server.metrics_allowed_cidrs":         listRule(checkCIDR),
	"server.livekit_webhook_allowed_cidrs": listRule(checkCIDR),
	"plugins.http_allowlist":               listRule(checkHostname),
}

// boolRule accepts a JSON boolean only.
func boolRule(v any) (any, error) {
	b, ok := v.(bool)
	if !ok {
		return nil, fmt.Errorf("want a boolean")
	}
	return b, nil
}

// intRule accepts a whole number inside [min, max].
func intRule(min, max int) func(any) (any, error) {
	return func(v any) (any, error) {
		n, ok := wholeInt(v)
		if !ok {
			return nil, fmt.Errorf("want a whole number")
		}
		if n < min || n > max {
			return nil, fmt.Errorf("want an integer in [%d, %d]", min, max)
		}
		return n, nil
	}
}

// udpPortRule accepts a port number, minus LiveKit's own API (7880) and TCP
// media (7881) ports, which must not collide with the WebRTC media port.
func udpPortRule(v any) (any, error) {
	n, ok := wholeInt(v)
	if !ok || n < 0 || n > 65535 {
		return nil, fmt.Errorf("want an integer in [0, 65535]")
	}
	if n == 7880 || n == 7881 {
		return nil, fmt.Errorf("%d is reserved for LiveKit", n)
	}
	return n, nil
}

// wholeInt converts a JSON number to an int only when it has no fractional
// part, so 1.5 is rejected rather than truncated.
func wholeInt(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case float64:
		if t == math.Trunc(t) && t >= -1e15 && t <= 1e15 {
			return int(t), true
		}
	}
	return 0, false
}

// authMultiplierRule accepts 0 (the default) or a value in [0.1, 100].
func authMultiplierRule(v any) (any, error) {
	var f float64
	switch t := v.(type) {
	case int:
		f = float64(t)
	case float64:
		f = t
	default:
		return nil, fmt.Errorf("want a number")
	}
	if f != 0 && (f < 0.1 || f > 100) {
		return nil, fmt.Errorf("want 0 or a number in [0.1, 100]")
	}
	return f, nil
}

// enumRule accepts one of the listed strings.
func enumRule(allowed ...string) func(any) (any, error) {
	return func(v any) (any, error) {
		s, err := cleanString(v)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(allowed, s) {
			return nil, fmt.Errorf("want one of %s", strings.Join(allowed, ", "))
		}
		return s, nil
	}
}

// cleanString requires a JSON string with no control characters. Every string
// value passes through it, because values flow into logs.
func cleanString(v any) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("want a string")
	}
	if strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 }) {
		return "", fmt.Errorf("must not contain control characters")
	}
	return s, nil
}

func serverNameRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	s = strings.TrimSpace(s)
	if len(s) > maxServerNameBytes {
		return nil, fmt.Errorf("must be at most %d bytes", maxServerNameBytes)
	}
	if s == "" {
		return nil, fmt.Errorf("must not be empty")
	}
	return s, nil
}

func contactRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if len(s) > 254 {
		return nil, fmt.Errorf("must be at most 254 bytes")
	}
	if strings.ContainsAny(s, " \t\r\n") {
		return nil, fmt.Errorf("must not contain whitespace")
	}
	return s, nil
}

func serviceNameRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s == "" || len(s) > 100 {
		return nil, fmt.Errorf("must be 1 to 100 bytes")
	}
	return s, nil
}

func otlpEndpointRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s == "" {
		return s, nil
	}
	if _, _, err := net.SplitHostPort(s); err != nil {
		return nil, fmt.Errorf("must be host:port")
	}
	return s, nil
}

func liveKitURLRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
		return nil, fmt.Errorf("must be a ws:// or wss:// URL")
	}
	return s, nil
}

var liveKitVersionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func liveKitVersionRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s != "" && !liveKitVersionRe.MatchString(s) {
		return nil, fmt.Errorf("must be empty or a version like 1.13.7")
	}
	return s, nil
}

func nodeIPRule(v any) (any, error) {
	s, err := cleanString(v)
	if err != nil {
		return nil, err
	}
	if s != "" && net.ParseIP(s) == nil {
		return nil, fmt.Errorf("must be empty or an IP address")
	}
	return s, nil
}

// listRule accepts a list of strings (at most 100, each at most 255 bytes)
// whose entries all pass check.
func listRule(check func(string) error) func(any) (any, error) {
	return func(v any) (any, error) {
		items, ok := toStringSlice(v)
		if !ok {
			return nil, fmt.Errorf("want a list of strings")
		}
		if len(items) > 100 {
			return nil, fmt.Errorf("want at most 100 entries")
		}
		for _, item := range items {
			if len(item) > 255 {
				return nil, fmt.Errorf("entry %q is over 255 bytes", item)
			}
			if strings.ContainsFunc(item, func(r rune) bool { return r < 0x20 }) {
				return nil, fmt.Errorf("entry %q has control characters", item)
			}
			if err := check(item); err != nil {
				return nil, err
			}
		}
		return items, nil
	}
}

func toStringSlice(v any) ([]string, bool) {
	switch t := v.(type) {
	case []string:
		return t, true
	case []any:
		out := make([]string, 0, len(t))
		for _, entry := range t {
			s, ok := entry.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	default:
		return nil, false
	}
}

func checkOrigin(s string) error {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("entry %q must be an http(s) origin with no path", s)
	}
	return nil
}

func checkCIDR(s string) error {
	if _, _, err := net.ParseCIDR(s); err != nil {
		return fmt.Errorf("entry %q must be CIDR notation (address/prefix)", s)
	}
	return nil
}

func checkHostname(s string) error {
	if s == "" || strings.ContainsAny(s, "/:* \t") {
		return fmt.Errorf("entry %q must be a bare hostname", s)
	}
	return nil
}
