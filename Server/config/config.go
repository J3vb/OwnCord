// Package config provides configuration loading for the OwnCord server.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"net"
	"os"
	"slices"
	"strings"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/providers/structs"
	"github.com/knadh/koanf/v2"
	goyaml "go.yaml.in/yaml/v3"
)

// Config holds the full server configuration.
type Config struct {
	Server           ServerConfig           `koanf:"server"`
	Database         DatabaseConfig         `koanf:"database"`
	Backup           BackupConfig           `koanf:"backup"`
	Security         SecurityConfig         `koanf:"security"`
	TLS              TLSConfig              `koanf:"tls"`
	Upload           UploadConfig           `koanf:"upload"`
	Voice            VoiceConfig            `koanf:"voice"`
	GitHub           GitHubConfig           `koanf:"github"`
	EventPersistence EventPersistenceConfig `koanf:"event_persistence"`
	Telemetry        TelemetryConfig        `koanf:"telemetry"`
	Plugins          PluginsConfig          `koanf:"plugins"`
	GIF              GIFConfig              `koanf:"gif"`
	Logging          LoggingConfig          `koanf:"logging"`
	Moderation       ModerationConfig       `koanf:"moderation"`
	Push             PushConfig             `koanf:"push"`
}

// ModerationConfig holds the report queue's retention window (B5-8, plan
// decision 7/scorecard Question 3 decision 2).
type ModerationConfig struct {
	// ReportRetentionDays bounds report CONTENT — evidence, notes and the
	// free-text detail — deleted this many days after a report closes; the
	// row itself is kept indefinitely (S5-d: the outcome is durable, the
	// content is bounded). 0 means never prune content. Open reports
	// (closed_at IS NULL) are never touched by this window.
	ReportRetentionDays int `koanf:"report_retention_days"`
	// ActionRetentionDays retires warning rows this many days after
	// acknowledged_at and timeout rows the same number of days after
	// expires_at/lifted_at (B5-9, scorecard decision 5), unless an appeal
	// references them. Ban, kick and removal rows stay with the account —
	// they are not on this clock. 0 means never retire.
	ActionRetentionDays int `koanf:"action_retention_days"`
}

// LoggingConfig controls server log verbosity. Level gates both stdout and
// the in-memory ring buffer that backs the admin panel's live log view, so
// suppressed levels cost nothing anywhere on the hot path.
type LoggingConfig struct {
	// Level is the minimum level logged: "debug" | "info" | "warn" |
	// "error". Override at runtime without editing config.yaml via the
	// OWNCORD_LOGGING_LEVEL environment variable.
	Level string `koanf:"level"`
}

// ParseLevel maps a config log-level string to a slog.Level. It is
// case-insensitive and treats "" as info. The bool is false for an
// unrecognised value (in which case slog.LevelInfo is returned and the caller
// should warn) so a typo doesn't silently disable logging.
func ParseLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, true
	case "", "info":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}

// GIFConfig holds the credentials for the server-side GIF (Klipy) proxy.
//
// The API key is deliberately server-only: the client never receives it and
// never talks to api.klipy.com directly, it calls /api/v1/gif/* on its own
// server instead. An empty APIKey means the feature is OFF — the proxy
// endpoints answer 503 GIF_DISABLED and the client hides the picker.
type GIFConfig struct {
	APIKey string `koanf:"api_key"`
}

// PushConfig is the owner gate for Web Push subscription storage (B5-4,
// plan decision 9) and dispatch (B5-11, HP-5 scorecard Question 6). Enabled
// is false by default — with it false, every route under /api/v1/push
// answers 503 PUSH_DISABLED after authentication, and nothing is written.
// Turning it off again later keeps existing subscription rows (nothing
// dispatches to them regardless of DispatchEnabled while Enabled is false);
// the staleness sweep still runs.
type PushConfig struct {
	// Enabled is the owner opt-in for subscription storage. Routes are
	// always mounted; this only gates whether they do anything.
	Enabled bool `koanf:"enabled"`
	// SubscriptionTTLDays is the staleness window: a subscription whose
	// last_seen_at is older than this many days is removed by the
	// maintenance sweep. Clients keep a row alive by re-POSTing the same
	// endpoint (an upsert that bumps last_seen_at). Default 90, bounded to
	// [1, 3650] in boundedKeys.
	SubscriptionTTLDays int `koanf:"subscription_ttl_days"`
	// DispatchEnabled is the SECOND, separate owner opt-in dispatch needs on
	// top of Enabled (plan decision 9): storage on with dispatch off is the
	// B5-4 state, and an operator who enabled storage before dispatch
	// existed does not acquire it on upgrade. Turning this on makes the
	// server open outbound HTTPS connections to the push service named in
	// each stored subscription's endpoint — see
	// docs/architecture/diagnostics.md's egress table. False by default;
	// dispatch runs only when Enabled and DispatchEnabled are both true.
	DispatchEnabled bool `koanf:"dispatch_enabled"`
	// Contact is the operator contact a VAPID JWT's "sub" claim names
	// (RFC 8292), sent as "mailto:"+Contact. Empty (the default) omits the
	// claim entirely — some push services require a contact and will refuse
	// a request without one, which is the operator's decision to make.
	Contact string `koanf:"contact"`
}

// EventPersistenceConfig (Phase B Step 7) controls the tiered event log used
// for WebSocket reconnection replay.
type EventPersistenceConfig struct {
	// Enabled toggles cold-storage persistence. When false the server falls
	// back to ring-buffer-only behaviour (Phase A semantics).
	Enabled bool `koanf:"enabled"`
	// RetentionHours is how long persisted events are kept before pruning.
	RetentionHours int `koanf:"retention_hours"`
	// BatchSize is the maximum number of events per persister flush.
	BatchSize int `koanf:"batch_size"`
	// BatchFlushMs is the maximum delay between persister flushes.
	BatchFlushMs int `koanf:"batch_flush_ms"`
	// PrunerIntervalMinutes is how often the pruner goroutine wakes up.
	PrunerIntervalMinutes int `koanf:"pruner_interval_minutes"`
	// ReplayRingSize is the capacity of the in-memory reconnect replay ring.
	// Reconnects whose gap exceeds it fall to the persisted event log.
	ReplayRingSize int `koanf:"replay_ring_size"`
	// ReplayColdLimit caps how many persisted events a single reconnect may
	// replay; beyond it the client gets a full resync. This is the budget
	// that decides how long a disconnect can be bridged by replay.
	ReplayColdLimit int `koanf:"replay_cold_limit"`
}

// TelemetryConfig (Phase B Step 8) controls the OpenTelemetry exporter.
type TelemetryConfig struct {
	// Enabled toggles the OTel SDK. When false the server uses no-op
	// tracer/meter providers and the legacy /metrics endpoint stays the
	// only metrics surface.
	Enabled bool `koanf:"enabled"`
	// Exporter is "none" | "prometheus" | "otlp".
	Exporter string `koanf:"exporter"`
	// OTLPEndpoint is the gRPC endpoint when Exporter == "otlp".
	OTLPEndpoint string `koanf:"otlp_endpoint"`
	// OTLPInsecure disables TLS for the OTLP gRPC connection. Only set
	// true in development / private-network deployments. Defaults to false
	// (TLS required) to avoid transmitting trace/metric data in plaintext.
	OTLPInsecure bool `koanf:"otlp_insecure"`
	// ServiceName is the resource service.name attribute.
	ServiceName string `koanf:"service_name"`
}

// PluginsConfig (Phase C Step 9) controls the Wazero plugin runtime.
type PluginsConfig struct {
	// Enabled toggles plugin loading at startup.
	Enabled bool `koanf:"enabled"`
	// Directory is the on-disk directory scanned for plugin packages.
	Directory string `koanf:"directory"`
	// MaxMemoryMB caps a single plugin's WASM linear memory.
	MaxMemoryMB int `koanf:"max_memory_mb"`
	// CPUBudgetMs caps a single plugin invocation's CPU time.
	CPUBudgetMs int `koanf:"cpu_budget_ms"`
	// HTTPAllowlist enumerates host suffixes plugins may reach via host_http.
	HTTPAllowlist []string `koanf:"http_allowlist"`
}

// GitHubConfig holds GitHub API settings for update checking.
//
// Owner/Repo point at the public releases repository. Server and client
// update checks fetch release assets from this repo, so it must stay
// publicly readable even when the source repository is private.
type GitHubConfig struct {
	Token string `koanf:"token"`
	Owner string `koanf:"owner"`
	Repo  string `koanf:"repo"`
}

// VoiceConfig holds LiveKit server connection and voice quality settings.
type VoiceConfig struct {
	LiveKitAPIKey     string `koanf:"livekit_api_key"`    // LiveKit API key
	LiveKitAPISecret  string `koanf:"livekit_api_secret"` // LiveKit API secret
	LiveKitURL        string `koanf:"livekit_url"`        // LiveKit server WebSocket URL (e.g. ws://localhost:7880)
	LiveKitBinaryPath string `koanf:"livekit_binary"`     // path to livekit-server binary; empty = don't auto-start
	// AutoDownloadLiveKit downloads a pinned, checksum-verified livekit-server
	// release from the official LiveKit GitHub releases into
	// <data_dir>/livekit/ and runs it as the companion process, when no
	// livekit_binary is configured. Fresh installs enable this in the
	// generated config.yaml so voice works out of the box; the compiled-in
	// default stays false so existing configs keep their behaviour.
	AutoDownloadLiveKit bool `koanf:"auto_download_livekit"`
	// LiveKitVersion overrides the pinned livekit-server release version used
	// by auto-download (e.g. "1.13.5"). Empty = the built-in pin.
	LiveKitVersion string `koanf:"livekit_version"`
	NodeIP         string `koanf:"node_ip"` // public IP for WebRTC ICE candidates; empty = auto-detect
	// AdvertiseInternalIP makes LiveKit advertise internal (LAN) host candidates
	// in addition to the external node_ip mapping, so clients on the local
	// network can connect while remote clients use the public IP.
	AdvertiseInternalIP bool   `koanf:"advertise_internal_ip"`
	Quality             string `koanf:"quality"` // low | medium | high
}

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port              int      `koanf:"port"`
	Name              string   `koanf:"name"`
	DataDir           string   `koanf:"data_dir"`
	AllowedOrigins    []string `koanf:"allowed_origins"`
	TrustedProxies    []string `koanf:"trusted_proxies"`
	AdminAllowedCIDRs []string `koanf:"admin_allowed_cidrs"`
	WAFEnabled        bool     `koanf:"waf_enabled"` // Enable Coraza WAF (default: false)
	// BrowserClientEnabled is the owner opt-in for hosting a browser client
	// from this server. It is false by default and this build ships no
	// browser assets, so enabling it hosts nothing yet — the bundle, its
	// route and its own CSP are B8's (BG-01, plan decision 10). The key
	// exists now because a disabled-by-default hosting surface is a security
	// property, and proving it before the assets exist is far cheaper than
	// proving it after; Server/api/browser_hosting_posture_test.go is that
	// proof.
	BrowserClientEnabled bool `koanf:"browser_client_enabled"`
	// MinFreeDiskMB is the one definition of "low disk" (B5-2, plan decision
	// 11): the reserved headroom, in MiB, below which the start-up banner
	// logs an error, /health reports degraded and the upload path refuses
	// with 507. Default 256. 0 disables the floor. Three call sites, one
	// number, so they can never disagree about what "low" means.
	MinFreeDiskMB    int `koanf:"min_free_disk_mb"`
	WAFParanoiaLevel int `koanf:"waf_paranoia_level"` // OWASP CRS paranoia level 1-4 (default: 2)
	// WAFCRSMode selects the OWASP Core Rule Set layer mode when the WAF is
	// enabled: "off" (inline rules only), "detect" (CRS evaluated, matches
	// logged, never blocks) or "block" (CRS anomaly-scoring blocking).
	// Defaults to "detect": chat traffic routinely contains SQL-ish/HTML-ish
	// text the CRS false-positives on, so blocking needs tuning against real
	// traffic first. Unknown values fall back to "detect".
	WAFCRSMode string `koanf:"waf_crs_mode"`
	// MaxWSConnections caps concurrently connected WebSocket clients; new
	// upgrade requests beyond the cap are refused with 503 before the
	// upgrade. 0 (the default) means unlimited — every connection costs
	// goroutines and buffered send queues, so set a ceiling that matches the
	// host's memory before pointing a large community at it.
	MaxWSConnections int `koanf:"max_ws_connections"`
	// MetricsAllowedCIDRs gates /api/v1/metrics and the Prometheus /metrics
	// exporter separately from the human admin surface, so a central
	// Prometheus scraper can be allowlisted without widening /admin to its
	// network. Empty (default) falls back to AdminAllowedCIDRs.
	MetricsAllowedCIDRs []string `koanf:"metrics_allowed_cidrs"`
	// LiveKitWebhookAllowedCIDRs gates the LiveKit webhook and health
	// endpoints. The webhook already authenticates cryptographically (LiveKit
	// JWT signature over the body hash) — this perimeter is defence-in-depth,
	// and giving it its own key means an externally-hosted LiveKit's IP no
	// longer has to be added to the ADMIN allowlist. Empty (default) falls
	// back to AdminAllowedCIDRs.
	LiveKitWebhookAllowedCIDRs []string `koanf:"livekit_webhook_allowed_cidrs"`
	// RestartMode selects how a self-restart (update apply, backup restore,
	// setup wizard) hands the process over to its replacement once the server
	// has fully drained:
	//   - "supervised": exit cleanly and rely on the process supervisor
	//     (systemd Restart=, NSSM AppExit, Docker restart policy) to relaunch.
	//   - "spawn": start the replacement binary directly before exiting
	//     (unmanaged deployments: console, Task Scheduler).
	//   - "auto" (default): "supervised" when a supervisor or container is
	//     detected (updater.RunningUnderSupervisor / RunningInContainer),
	//     otherwise "spawn".
	// Env override: OWNCORD_SERVER_RESTART_MODE. NSSM deployments must set
	// this to "supervised" — NSSM 2.24 is not auto-detectable.
	RestartMode string `koanf:"restart_mode"`
}

// MetricsCIDRs returns the effective allowlist for the metrics surfaces.
func (s *ServerConfig) MetricsCIDRs() []string {
	if len(s.MetricsAllowedCIDRs) > 0 {
		return s.MetricsAllowedCIDRs
	}
	return s.AdminAllowedCIDRs
}

// LiveKitWebhookCIDRs returns the effective allowlist for the LiveKit
// webhook/health endpoints.
func (s *ServerConfig) LiveKitWebhookCIDRs() []string {
	if len(s.LiveKitWebhookAllowedCIDRs) > 0 {
		return s.LiveKitWebhookAllowedCIDRs
	}
	return s.AdminAllowedCIDRs
}

// DatabaseConfig holds database settings.
//
// SQLite is the only supported backend. The PostgreSQL scaffolding that once
// motivated the Type field has been removed (see Server/main.go); the field
// survives so an explicit "sqlite" keeps working and anything else fails
// startup with a clear error instead of being silently ignored.
type DatabaseConfig struct {
	// Type selects the database backend. "sqlite" (or empty, which defaults
	// to it) is the only supported value.
	Type string `koanf:"type"`

	// Path is the SQLite database file path.
	Path string `koanf:"path"`

	// MaxReaders bounds the read-only connection pool. 0 (default) keeps the
	// automatic sizing of max(4, NumCPU). Values are clamped to [1, 64] —
	// readers beyond the CPU count mostly buy queueing, not throughput.
	MaxReaders int `koanf:"max_readers"`
}

// TLSConfig holds TLS/certificate settings.
type TLSConfig struct {
	Mode         string `koanf:"mode"`
	CertFile     string `koanf:"cert_file"`
	KeyFile      string `koanf:"key_file"`
	Domain       string `koanf:"domain"`
	AcmeCacheDir string `koanf:"acme_cache_dir"`

	// HTTPSPort is the port the HTTPS listener actually binds (cfg.Server.Port),
	// set by the caller before LoadOrGenerate — not a config file key. ACME
	// mode's HTTP->HTTPS redirect needs it because the HTTPS port is not
	// necessarily 443.
	HTTPSPort int `koanf:"-"`
}

// UploadConfig holds file upload settings.
type UploadConfig struct {
	MaxSizeMB  int    `koanf:"max_size_mb"`
	StorageDir string `koanf:"storage_dir"`
	// UserQuotaMB caps the total bytes one user may hold in upload storage —
	// attachments, avatars and emoji alike, counted where the bytes are
	// written (B5-2, plan decision 11). 0, the default, is unlimited, so no
	// existing install changes behaviour on upgrade.
	UserQuotaMB int `koanf:"user_quota_mb"`
}

// UserQuotaBytes is the per-user quota in bytes; 0 means unlimited.
func (u UploadConfig) UserQuotaBytes() int64 { return int64(u.UserQuotaMB) << 20 }

// MinFreeDiskBytes is the reserved-headroom floor in bytes; 0 means no floor.
// applyBounds keeps the MiB value in [0, MaxInt64>>20], so the shift fits.
func (s ServerConfig) MinFreeDiskBytes() uint64 {
	if s.MinFreeDiskMB <= 0 {
		return 0
	}
	return uint64(s.MinFreeDiskMB) << 20
}

// BackupConfig controls where database backups are written. Pointing Dir at
// another disk (or a mount that is shipped off-host) is the recommended way
// to keep backups from sharing a single point of failure with the live
// database and uploads.
type BackupConfig struct {
	Dir string `koanf:"dir"`
}

// SecurityConfig tunes security-adjacent behavior that has safe compiled-in
// defaults.
type SecurityConfig struct {
	// AuthRateLimitMultiplier scales the per-IP auth rate limits and failure
	// thresholds (registration, login, TOTP, sensitive endpoints). The
	// defaults assume roughly one person per IP address; a community behind a
	// shared NAT (office, school) hits them collectively. 0 or unset = 1.0;
	// clamped to [0.1, 100].
	AuthRateLimitMultiplier float64 `koanf:"auth_rate_limit_multiplier"`
	// ExpensiveAuthConcurrency bounds how many bcrypt computations — password
	// checks and hashes on every auth route, recovery-code matching at the
	// second-factor step — run at once: the B4-4 admission budget. An
	// over-budget attempt is refused with 429 RATE_LIMITED, runs no bcrypt
	// and consumes no lockout attempt. 0 or unset = twice the CPU count
	// (never below 4); clamped to [1, 4096].
	ExpensiveAuthConcurrency int `koanf:"expensive_auth_concurrency"`
}

// defaults returns the default configuration.
func defaults() Config {
	return Config{
		Server: ServerConfig{
			Port:           8443,
			Name:           "OwnCord Server",
			DataDir:        "data",
			AllowedOrigins: []string{},
			TrustedProxies: []string{},
			AdminAllowedCIDRs: []string{
				"127.0.0.0/8",    // localhost IPv4
				"::1/128",        // localhost IPv6
				"10.0.0.0/8",     // private class A
				"172.16.0.0/12",  // private class B
				"192.168.0.0/16", // private class C
				"fc00::/7",       // IPv6 unique local
			},
			WAFCRSMode:    "detect",
			RestartMode:   "auto",
			MinFreeDiskMB: 256,
		},
		Database: DatabaseConfig{
			Type: "sqlite",
			Path: "data/chatserver.db",
		},
		Backup: BackupConfig{
			Dir: "data/backups",
		},
		TLS: TLSConfig{
			Mode:         "self_signed",
			CertFile:     "data/cert.pem",
			KeyFile:      "data/key.pem",
			AcmeCacheDir: "data/acme_certs",
		},
		Upload: UploadConfig{
			MaxSizeMB:  100,
			StorageDir: "data/uploads",
		},
		Voice: VoiceConfig{
			LiveKitURL: "ws://localhost:7880",
			Quality:    "medium",
		},
		GitHub: GitHubConfig{
			Owner: "J3vb",
			Repo:  "OwnCord",
		},
		EventPersistence: EventPersistenceConfig{
			Enabled:               true,
			RetentionHours:        24,
			BatchSize:             50,
			BatchFlushMs:          100,
			PrunerIntervalMinutes: 60,
			ReplayRingSize:        1000,
			ReplayColdLimit:       5000,
		},
		Security: SecurityConfig{
			AuthRateLimitMultiplier: 1.0,
			// 0 = auth.DefaultAdmissionBudget(): twice the core count.
			ExpensiveAuthConcurrency: 0,
		},
		Telemetry: TelemetryConfig{
			Enabled:     false,
			Exporter:    "none",
			ServiceName: "owncord-server",
		},
		Plugins: PluginsConfig{
			Enabled:       false,
			Directory:     "data/plugins",
			MaxMemoryMB:   64,
			CPUBudgetMs:   100,
			HTTPAllowlist: []string{},
		},
		Logging: LoggingConfig{
			Level: "info",
		},
		Moderation: ModerationConfig{
			ReportRetentionDays: 180,
			ActionRetentionDays: 90,
		},
		Push: PushConfig{
			Enabled:             false,
			SubscriptionTTLDays: 90,
			DispatchEnabled:     false,
			Contact:             "",
		},
	}
}

// defaultYAML is the content written when no config file is present.
const defaultYAML = `# OwnCord Server Configuration
server:
  port: 8443
  name: "OwnCord Server"
  data_dir: "data"
  # min_free_disk_mb: 256     # reserved headroom on the volumes the server writes to:
  #                           # below it the banner errors, /health reports degraded
  #                           # and uploads are refused with 507. 0 disables the floor.
  # allowed_origins: []       # browser origins allowed to connect; empty = deny cross-origin.
  #                           # The OwnCord desktop client is always accepted and needs no entry.
  # trusted_proxies: []       # CIDRs of the reverse-proxy HOPS only (e.g. ["10.0.0.2/32"]).
  #                           # Never list client networks here: a range that covers
  #                           # clients degrades per-client rate limiting and lets
  #                           # covered clients influence their own rate-limit key.
  # admin_allowed_cidrs:      # CIDRs allowed to access /admin (default: private networks only)
  #   - "127.0.0.0/8"
  #   - "::1/128"
  #   - "10.0.0.0/8"
  #   - "172.16.0.0/12"
  #   - "192.168.0.0/16"
  # browser_client_enabled: false  # host a browser client from this server.
  #                           # Owner opt-in, off by default. This build ships no
  #                           # browser assets, so turning it on hosts nothing yet.
  # waf_enabled: false        # Coraza WAF (inline rules + OWASP Core Rule Set)
  # waf_paranoia_level: 2     # OWASP CRS paranoia level 1-4
  # waf_crs_mode: "detect"    # off | detect | block — CRS layer mode; "detect" logs
  #                           # CRS matches without blocking (safe default for chat traffic)
  # restart_mode: "auto"      # auto | spawn | supervised — how self-restarts (update,
  #                           # restore, setup wizard) hand off. "supervised" exits and
  #                           # lets systemd/NSSM/Docker relaunch; "spawn" starts the
  #                           # replacement directly; "auto" detects (NSSM users: set
  #                           # "supervised" explicitly, NSSM is not auto-detectable)

database:
  type: "sqlite"          # "sqlite" is the only supported backend
  path: "data/chatserver.db"

# backup:
#   dir: "data/backups"   # where database backups are written; point at another
#                         # disk or an off-host mount so backups don't share a
#                         # single point of failure with the live database

tls:
  mode: "self_signed"  # self_signed, acme, manual, off
  cert_file: "data/cert.pem"
  key_file: "data/key.pem"
  domain: ""              # required for acme mode (e.g. "chat.example.com")
  acme_cache_dir: "data/acme_certs"  # where Let's Encrypt certs are cached

upload:
  max_size_mb: 100
  storage_dir: "data/uploads"
  # user_quota_mb: 0          # total bytes one user may hold in upload storage
  #                           # (attachments, avatars and emoji); 0 = unlimited

# Web Push subscriptions. Disabled by default: with push.enabled false,
# every /api/v1/push/* route answers 503 PUSH_DISABLED after authentication
# and nothing is written. push.dispatch_enabled is a SECOND, separate
# opt-in: with it false (the default) nothing is ever dispatched to a
# stored subscription, even with push.enabled true. Turning dispatch on
# makes the server open outbound HTTPS connections to the push service
# named in each stored subscription's endpoint.
# push:
#   enabled: false
#   subscription_ttl_days: 90  # a subscription not refreshed in this many
#                              # days is removed by the maintenance sweep
#   dispatch_enabled: false    # opens outbound connections to push services
#                              # when enabled together with push.enabled
#   contact: ""                # operator contact for VAPID JWTs, sent as
#                              # "mailto:<contact>"; empty omits the claim

voice:
  # livekit_api_key: ""       # LiveKit API key (REQUIRED for voice — generate a unique key)
  # livekit_api_secret: ""    # LiveKit API secret (REQUIRED, min 32 chars — generate a unique secret)
  livekit_url: "ws://localhost:7880"  # LiveKit server WebSocket URL
  auto_download_livekit: true # download and run livekit-server automatically when
                              # no livekit_binary is set (verified against the
                              # official LiveKit release checksums; stored in data/livekit/)
  # livekit_version: ""            # override the pinned livekit-server version (e.g. "1.13.5")
  # livekit_binary: ""             # path to an existing livekit-server binary; set this to
  #                                # skip auto-download and run your own build
  # node_ip: ""                    # public IP for WebRTC media (required for remote users behind NAT)
  # advertise_internal_ip: false   # also advertise LAN IPs so local-network clients can connect
  # quality: "medium"              # low | medium | high

# github:
#   token: ""  # optional: GitHub API token for higher rate limits (5000 req/hr vs 60)

# Phase B Step 7 — cold-tier event log used by the WebSocket reconnect path.
# When the in-memory ring buffer can't cover a client's last_seq the server
# falls back to these rows before forcing a full re-sync. Rows older than
# retention_hours are pruned by a background goroutine.
# event_persistence:
#   enabled: true             # set false to disable cold-tier replay entirely
#   retention_hours: 24       # how long to keep persisted broadcast events
#   batch_size: 50            # flush after this many events buffered
#   batch_flush_ms: 100       # OR after this many milliseconds, whichever first
#   pruner_interval_minutes: 60  # how often the retention pruner runs

# Phase B Step 8 — OpenTelemetry exporter. The default build ships a no-op
# provider; building with -tags otel enables the real SDK.
# telemetry:
#   enabled: false            # master switch
#   exporter: "none"          # none | prometheus | otlp
#   otlp_endpoint: ""         # required when exporter == "otlp" (host:port of collector)
#   otlp_insecure: false      # set true only for dev/private networks (disables TLS)
#   service_name: "owncord-server"

# Phase C Step 9 — Wazero plugin runtime. Disabled by default so existing
# operators are unaffected. Plugins live in subdirectories of the configured
# directory; see Server/plugin/examples/hello for the manifest format.
# plugins:
#   enabled: false
#   directory: "data/plugins"
#   max_memory_mb: 64         # per-plugin memory cap
#   cpu_budget_ms: 100        # per-invocation CPU budget
#   http_allowlist: []        # hostnames plugins may reach via the http capability

# GIF picker (Klipy). Disabled by default: with no api_key the /api/v1/gif/*
# endpoints answer 503 GIF_DISABLED and the client hides its GIF button. The
# key stays on the server — it is never sent to clients.
# Get a key at https://partner.klipy.com
# gif:
#   api_key: ""

# Logging. "level" gates what is logged, to stdout and the admin panel's live
# log view alike. Override without editing this file via the
# OWNCORD_LOGGING_LEVEL environment variable.
# logging:
#   level: "info"             # debug | info | warn | error

# Moderation: the report queue's content retention window (B5-8), and the
# moderator-action ledger's own window (B5-9). Report rows and ban/kick/
# removal ledger rows are kept indefinitely either way; these bound only
# the report's evidence/notes/detail and the warning/timeout rows.
# moderation:
#   report_retention_days: 180  # days after a report closes before its content
#                                # is pruned; 0 = never. Open reports are never touched.
#   action_retention_days: 90   # days after acknowledgement (warning) or expiry/lift
#                                # (timeout) before the row retires; 0 = never.
`

// Load reads configuration from the given YAML file path, merging with
// defaults and environment variable overrides. If the file does not exist,
// a default config.yaml is written and defaults are returned.
func Load(cfgPath string) (*Config, error) {
	k := koanf.New(".")

	// Layer 1: built-in defaults via struct provider.
	def := defaults()
	if err := k.Load(structs.Provider(def, "koanf"), nil); err != nil {
		return nil, fmt.Errorf("loading defaults: %w", err)
	}
	// The defaults layer's key set is the complete set of keys the config
	// struct can absorb — captured NOW, before the file merges in, so it can
	// serve as the allowlist for the unknown-key warning below. (Capturing
	// after the file load would let the file's own typos into the allowlist.)
	knownKeys := make(map[string]struct{}, len(k.Keys()))
	for _, key := range k.Keys() {
		knownKeys[key] = struct{}{}
	}

	// Layer 2: YAML file (create default if missing). The freshly written
	// default file is loaded like any other so the first boot runs with
	// exactly the configuration the file documents (the generated template
	// enables options — e.g. voice.auto_download_livekit — that the
	// compiled-in defaults deliberately leave off for pre-existing configs).
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		if writeErr := os.WriteFile(cfgPath, []byte(defaultYAML), 0o600); writeErr != nil {
			return nil, fmt.Errorf("writing default config: %w", writeErr)
		}
	}
	// Read the file and try to parse it ourselves to detect invalid YAML.
	raw, readErr := os.ReadFile(cfgPath) //nolint:gosec // G304: path from trusted wiring
	if readErr != nil {
		return nil, fmt.Errorf("reading config file %s: %w", cfgPath, readErr)
	}
	if parseErr := validateYAML(raw); parseErr != nil {
		return nil, fmt.Errorf("loading config file %s: %w", cfgPath, parseErr)
	}
	if err := k.Load(file.Provider(cfgPath), yaml.Parser()); err != nil {
		return nil, fmt.Errorf("loading config file %s: %w", cfgPath, err)
	}

	// Warn (never fail — a newer server must tolerate an older config, and a
	// warning must not brick a working install) about file keys the config
	// struct cannot absorb. Without this, a typo like `admin_alowed_cidrs`
	// silently keeps the default and the operator believes they changed it.
	for _, key := range unknownFileKeys(cfgPath, knownKeys) {
		slog.Warn("config: unknown key ignored — value has NO effect (typo?)",
			"key", key, "file", cfgPath)
	}

	// Layer 3: environment variable overrides.
	// OWNCORD_SERVER_PORT -> server.port, OWNCORD_TLS_MODE -> tls.mode, etc.
	envProvider := env.Provider("OWNCORD_", ".", func(s string) string {
		// Strip prefix, lowercase, replace _ with . except within a key segment.
		// OWNCORD_SERVER_PORT -> server.port
		// OWNCORD_DATABASE_PATH -> database.path
		// OWNCORD_UPLOAD_MAX_SIZE_MB -> upload.max_size_mb
		s = strings.TrimPrefix(s, "OWNCORD_")
		s = strings.ToLower(s)
		// Split into at most 2 parts on the first underscore to get
		// section.key. We need smarter splitting because keys can have
		// underscores (e.g. max_size_mb, data_dir, storage_dir).
		return envKeyToKoanf(s)
	})
	if err := k.Load(envProvider, nil); err != nil {
		return nil, fmt.Errorf("loading env vars: %w", err)
	}

	var cfg Config
	if err := k.Unmarshal("", &cfg); err != nil {
		return nil, fmt.Errorf("unmarshalling config: %w", err)
	}
	applyBounds(&cfg)

	// Apply voice defaults for zero-value fields (koanf loses defaults when
	// the YAML section is present but fields are commented out / omitted).
	if err := applyVoiceDefaults(&cfg.Voice); err != nil {
		return nil, fmt.Errorf("applying voice defaults: %w", err)
	}

	// Warn if using default dev credentials — these are public and insecure.
	// Clear credentials so downstream consumers (e.g. NewLiveKitClient) see
	// empty values and refuse to start voice.
	if IsDefaultVoiceCredentials(&cfg.Voice) {
		slog.Warn("using default LiveKit dev credentials — voice will be disabled; set voice.livekit_api_key and voice.livekit_api_secret in config.yaml")
		cfg.Voice.LiveKitAPIKey = ""
		cfg.Voice.LiveKitAPISecret = ""
	}

	// Invalid CIDR entries are skipped at request time (they must not crash
	// handling), which silently un-trusts a misconfigured proxy — warn once
	// at startup instead. Common mistake: a bare IP without the /32 mask.
	warnInvalidCIDRs("server.trusted_proxies", cfg.Server.TrustedProxies)
	warnInvalidCIDRs("server.admin_allowed_cidrs", cfg.Server.AdminAllowedCIDRs)
	warnInvalidCIDRs("server.metrics_allowed_cidrs", cfg.Server.MetricsAllowedCIDRs)
	warnInvalidCIDRs("server.livekit_webhook_allowed_cidrs", cfg.Server.LiveKitWebhookAllowedCIDRs)

	// A customized admin allowlist with no trusted_proxies is a footgun
	// behind any reverse proxy or container network: the check then compares
	// the PROXY'S (or bridge's) address — by construction a private one —
	// instead of the real client's, so the customization silently doesn't do
	// what the operator believes. Warn, don't fail: direct-exposure setups
	// are exactly this shape and are fine.
	if len(cfg.Server.TrustedProxies) == 0 &&
		!slices.Equal(cfg.Server.AdminAllowedCIDRs, defaults().Server.AdminAllowedCIDRs) {
		slog.Warn("config: admin_allowed_cidrs is customized but trusted_proxies is empty — " +
			"behind a reverse proxy or Docker network the allowlist checks the proxy's private " +
			"address, not the real client; set server.trusted_proxies to the proxy hop(s)")
	}

	return &cfg, nil
}

// unknownFileKeys parses the config file into its own koanf instance and
// returns every leaf key that the defaults layer (= the full set of keys the
// Config struct defines) does not contain. knownKeys must be captured from
// the defaults layer BEFORE the file merges into it.
func unknownFileKeys(cfgPath string, knownKeys map[string]struct{}) []string {
	fileK := koanf.New(".")
	if err := fileK.Load(file.Provider(cfgPath), yaml.Parser()); err != nil {
		return nil // the main load already surfaced any parse problem
	}
	var unknown []string
	for _, key := range fileK.Keys() {
		if _, ok := knownKeys[key]; ok {
			continue
		}
		// A section header whose children are all commented out (or
		// omitted) parses to a nil value and koanf emits it as a bare leaf
		// key ("voice") rather than recursing into its (absent) children.
		// That bare key is a real, known section — not a typo — as long as
		// some known key is nested under it.
		if isKnownSection(knownKeys, key) {
			continue
		}
		unknown = append(unknown, key)
	}
	return unknown
}

// isKnownSection reports whether prefix names a known config section, i.e.
// some key in knownKeys is prefix followed by ".".
func isKnownSection(knownKeys map[string]struct{}, prefix string) bool {
	want := prefix + "."
	for key := range knownKeys {
		if strings.HasPrefix(key, want) {
			return true
		}
	}
	return false
}

// warnInvalidCIDRs logs a startup warning for each list entry that is not
// valid CIDR notation.
func warnInvalidCIDRs(key string, cidrs []string) {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("config: ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"key", key, "entry", c)
		}
	}
}

// defaultLiveKitAPIKey and defaultLiveKitAPISecret are the well-known dev
// credentials that ship in the default config. They must never be used in
// production — NewLiveKitClient rejects them.
const (
	DefaultLiveKitAPIKey    = "devkey"
	DefaultLiveKitAPISecret = "owncord-dev-secret-key-min-32chars" //nolint:gosec // G101: false positive — config key name, not a credential
)

// IsDefaultVoiceCredentials returns true when the voice config still uses
// the well-known default dev credentials shipped in the source code.
func IsDefaultVoiceCredentials(v *VoiceConfig) bool {
	return v.LiveKitAPIKey == DefaultLiveKitAPIKey ||
		v.LiveKitAPISecret == DefaultLiveKitAPISecret
}

// generateRandomKey returns a crypto-random hex string of the given byte length.
func generateRandomKey(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("crypto/rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// boundedKey is one integer key with a legal range. Out-of-range values are
// clamped to the nearest bound and warned about, never rejected: Load is
// warn-only by design (a warning must not brick a working install), and a
// clamped value is the nearest thing to what the operator wrote.
type boundedKey struct {
	key      string
	ptr      *int
	min, max int
	// def is what a value BELOW min becomes: the compiled default, not the
	// minimum. A negative headroom clamped to 0 would silently turn the
	// floor off, which fails open; falling back to the default fails safe,
	// and an operator who wants the floor off writes 0 explicitly.
	def int
	// meaning names what the fallback stands for, so the warning says what
	// happened to the operator's intent ("0 means unlimited").
	meaning string
}

// boundedKeys is the one place a bounded configuration key states its range
// (B5-2). A new integer key with a range adds a row here — not a clamp in the
// package that consumes it — so the checks stay together and every warning
// reads the same. Bounds are on the MiB values as written; the byte helpers
// (UserQuotaBytes, MinFreeDiskBytes) shift by 20, and maxMiB keeps that shift
// inside int64.
func boundedKeys(cfg *Config) []boundedKey {
	const maxMiB = math.MaxInt64 >> 20
	def := defaults()
	return []boundedKey{
		{"upload.user_quota_mb", &cfg.Upload.UserQuotaMB, 0, maxMiB, def.Upload.UserQuotaMB, "the default, 0, means unlimited"},
		{"server.min_free_disk_mb", &cfg.Server.MinFreeDiskMB, 0, maxMiB, def.Server.MinFreeDiskMB, "the default floor; write 0 to disable it"},
		{"moderation.report_retention_days", &cfg.Moderation.ReportRetentionDays, 0, 3650, def.Moderation.ReportRetentionDays, "0 means never prune report content"},
		{"moderation.action_retention_days", &cfg.Moderation.ActionRetentionDays, 0, 3650, def.Moderation.ActionRetentionDays, "0 means never retire warning/timeout rows"},
		{"push.subscription_ttl_days", &cfg.Push.SubscriptionTTLDays, 1, 3650, def.Push.SubscriptionTTLDays, "the default, 90 days"},
	}
}

// applyBounds brings every bounded key into its range, warning by key name:
// below the minimum falls back to the default, above the maximum clamps.
func applyBounds(cfg *Config) {
	for _, b := range boundedKeys(cfg) {
		v := *b.ptr
		fixed := v
		switch {
		case v < b.min:
			fixed = b.def
		case v > b.max:
			fixed = b.max
		}
		if fixed == v {
			continue
		}
		slog.Warn("config: value out of range", "key", b.key, "value", v, "using", fixed, "note", b.meaning)
		*b.ptr = fixed
	}
}

// applyVoiceDefaults fills in zero-value voice fields with sensible defaults.
// This guards against the koanf merge behaviour where an empty YAML section
// overwrites struct defaults with Go zero values.
// When API key/secret are empty, unique random credentials are generated
// so voice works out of the box without shipping known-public defaults.
func applyVoiceDefaults(v *VoiceConfig) error {
	if v.LiveKitAPIKey == "" {
		key, err := generateRandomKey(8)
		if err != nil {
			return fmt.Errorf("generating LiveKit API key: %w", err)
		}
		v.LiveKitAPIKey = "key-" + key
		slog.Warn("generated random LiveKit API key — voice tokens will break on restart; set voice.livekit_api_key in config.yaml for stable operation")
	}
	if v.LiveKitAPISecret == "" {
		secret, err := generateRandomKey(32)
		if err != nil {
			return fmt.Errorf("generating LiveKit API secret: %w", err)
		}
		v.LiveKitAPISecret = secret
		slog.Warn("generated random LiveKit API secret — set voice.livekit_api_secret in config.yaml for stable operation")
	}
	if v.LiveKitURL == "" {
		v.LiveKitURL = "ws://localhost:7880"
	}
	if v.Quality == "" {
		v.Quality = "medium"
	}
	return nil
}

// validateYAML checks that raw bytes are valid YAML.
func validateYAML(raw []byte) error {
	var v any
	return goyaml.Unmarshal(raw, &v)
}

// envKeyToKoanf converts a lower-case env key (without OWNCORD_ prefix) to a
// koanf dotted path. The first segment (up to the first underscore) is the
// section; the remainder is the key (with underscores preserved).
//
// Examples:
//
//	server_port        -> server.port
//	server_name        -> server.name
//	server_data_dir    -> server.data_dir
//	database_path      -> database.path
//	tls_mode           -> tls.mode
//	tls_cert_file      -> tls.cert_file
//	upload_max_size_mb -> upload.max_size_mb
func envKeyToKoanf(s string) string {
	// event_persistence is the only multi-word section; cutting at the first
	// underscore would produce the dead path event.persistence_* and koanf
	// would drop the documented override silently.
	if rest, ok := strings.CutPrefix(s, "event_persistence_"); ok {
		return "event_persistence." + rest
	}
	before, after, ok := strings.Cut(s, "_")
	if !ok {
		return s
	}
	return before + "." + after
}
