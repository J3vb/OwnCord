// Package config provides configuration loading for the OwnCord server.
package config

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"

	goyaml "go.yaml.in/yaml/v3"

	"github.com/J3vb/OwnCord/Server/storage"
)

// Config holds the full server configuration.
type Config struct {
	Server           ServerConfig           `yaml:"server"`
	Database         DatabaseConfig         `yaml:"database"`
	Backup           BackupConfig           `yaml:"backup"`
	Security         SecurityConfig         `yaml:"security"`
	TLS              TLSConfig              `yaml:"tls"`
	Upload           UploadConfig           `yaml:"upload"`
	Voice            VoiceConfig            `yaml:"voice"`
	GitHub           GitHubConfig           `yaml:"github"`
	EventPersistence EventPersistenceConfig `yaml:"event_persistence"`
	Telemetry        TelemetryConfig        `yaml:"telemetry"`
	Plugins          PluginsConfig          `yaml:"plugins"`
	GIF              GIFConfig              `yaml:"gif"`
	Logging          LoggingConfig          `yaml:"logging"`
	Moderation       ModerationConfig       `yaml:"moderation"`
	Push             PushConfig             `yaml:"push"`
	Attention        AttentionConfig        `yaml:"attention"`
}

// ModerationConfig holds the report queue's retention window.
type ModerationConfig struct {
	// ReportRetentionDays bounds report content (evidence, notes, free-text
	// detail): it is deleted this many days after a report closes while the row
	// is kept. 0 means never prune content. Open reports are never touched.
	ReportRetentionDays int `yaml:"report_retention_days"`
	// ActionRetentionDays retires warning rows this many days after
	// acknowledged_at and timeout rows after expires_at/lifted_at, unless an
	// appeal references them or one still owns a voice mute. Ban, kick and
	// removal rows stay with the account. 0 means never retire.
	ActionRetentionDays int `yaml:"action_retention_days"`
}

// LoggingConfig controls server log verbosity. Level gates both stdout and the
// in-memory ring buffer behind the admin panel's live log view.
type LoggingConfig struct {
	// Level is the minimum level logged: "debug" | "info" | "warn" | "error".
	// Override with OWNCORD_LOGGING_LEVEL.
	Level string `yaml:"level"`
	// HistoryDays is how many days of logs are saved to <data_dir>/logs for
	// the admin panel's log history. 0 saves nothing.
	HistoryDays int `yaml:"history_days"`
	// HistoryMaxMB caps the saved log files' total size; the oldest go first.
	HistoryMaxMB int `yaml:"history_max_mb"`
}

// LogHistoryDir is where saved log files go, or "" when history is off.
func (c *Config) LogHistoryDir() string {
	if c.Logging.HistoryDays <= 0 {
		return ""
	}
	return filepath.Join(c.Server.DataDir, "logs")
}

// ParseLevel maps a log-level string to a slog.Level, case-insensitively, with
// "" as info. The bool is false for an unrecognised value (slog.LevelInfo is
// returned) so the caller can warn instead of silently disabling logging.
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
// The API key is server-only: clients call /api/v1/gif/* and never
// api.klipy.com. An empty APIKey turns the feature OFF: the proxy answers 503
// GIF_DISABLED and the client hides the picker.
type GIFConfig struct {
	APIKey string `yaml:"api_key"`
}

// PushConfig is the owner gate for Web Push subscription storage and dispatch.
// While Enabled is false (the default), every /api/v1/push route answers 503
// PUSH_DISABLED after authentication and nothing is written. Turning it off
// later keeps existing rows (nothing dispatches to them) and the staleness sweep
// still runs.
type PushConfig struct {
	// Enabled is the owner opt-in for subscription storage; routes are always
	// mounted.
	Enabled bool `yaml:"enabled"`
	// SubscriptionTTLDays: a subscription whose last_seen_at is older than this
	// is removed by the maintenance sweep. Clients keep a row alive by
	// re-POSTing the same endpoint. Default 90, bounded to [1, 3650] in
	// boundedKeys.
	SubscriptionTTLDays int `yaml:"subscription_ttl_days"`
	// DispatchEnabled is a SECOND owner opt-in on top of Enabled, so an operator
	// who enabled storage before dispatch existed does not acquire dispatch on
	// upgrade. It makes the server open outbound HTTPS connections to the push
	// service named in each subscription's endpoint (see
	// docs/architecture/diagnostics.md's egress table). Dispatch runs only when
	// both are true.
	DispatchEnabled bool `yaml:"dispatch_enabled"`
	// Contact is the operator contact a VAPID JWT's "sub" claim names (RFC
	// 8292), sent as "mailto:"+Contact. Empty omits the claim; some push
	// services refuse a request without one, which is the operator's call.
	Contact string `yaml:"contact"`
}

// EventPersistenceConfig controls the tiered event log used for WebSocket
// reconnection replay.
type EventPersistenceConfig struct {
	// Enabled toggles cold-storage persistence; false means ring-buffer-only.
	Enabled bool `yaml:"enabled"`
	// RetentionHours is how long persisted events are kept before pruning.
	RetentionHours int `yaml:"retention_hours"`
	// BatchSize is the maximum number of events per persister flush.
	BatchSize int `yaml:"batch_size"`
	// BatchFlushMs is the maximum delay between persister flushes.
	BatchFlushMs int `yaml:"batch_flush_ms"`
	// PrunerIntervalMinutes is how often the pruner goroutine wakes up.
	PrunerIntervalMinutes int `yaml:"pruner_interval_minutes"`
	// ReplayRingSize is the in-memory replay ring capacity; reconnects with a
	// larger gap fall to the persisted log.
	ReplayRingSize int `yaml:"replay_ring_size"`
	// ReplayColdLimit caps persisted events replayed per reconnect; beyond it
	// the client gets a full resync. It decides how long a disconnect replay can
	// bridge.
	ReplayColdLimit int `yaml:"replay_cold_limit"`
}

// TelemetryConfig controls the OpenTelemetry exporter.
type TelemetryConfig struct {
	// Enabled toggles the OTel SDK; false uses no-op providers. The built-in GET
	// /api/v1/metrics (JSON) and /api/v1/metrics/prometheus exist in every build
	// regardless.
	Enabled bool `yaml:"enabled"`
	// Exporter is "none" | "prometheus" | "otlp".
	Exporter string `yaml:"exporter"`
	// OTLPEndpoint is the gRPC endpoint when Exporter == "otlp".
	OTLPEndpoint string `yaml:"otlp_endpoint"`
	// OTLPInsecure disables TLS for the OTLP gRPC connection; development /
	// private networks only, since the default (TLS) avoids sending telemetry in
	// plaintext.
	OTLPInsecure bool `yaml:"otlp_insecure"`
	// ServiceName is the resource service.name attribute.
	ServiceName string `yaml:"service_name"`
}

// PluginsConfig controls the Wazero plugin runtime.
type PluginsConfig struct {
	// Enabled toggles plugin loading at startup.
	Enabled bool `yaml:"enabled"`
	// Directory is the on-disk directory scanned for plugin packages.
	Directory string `yaml:"directory"`
	// MaxMemoryMB caps a single plugin's WASM linear memory.
	MaxMemoryMB int `yaml:"max_memory_mb"`
	// CPUBudgetMs caps a single plugin invocation's CPU time.
	CPUBudgetMs int `yaml:"cpu_budget_ms"`
	// HTTPAllowlist enumerates host suffixes plugins may reach via host_http.
	HTTPAllowlist []string `yaml:"http_allowlist"`
}

// GitHubConfig holds GitHub API settings for update checking. Owner/Repo name
// the public releases repository, which must stay publicly readable even when
// the source repository is private.
type GitHubConfig struct {
	Token string `yaml:"token"`
	Owner string `yaml:"owner"`
	Repo  string `yaml:"repo"`
}

// VoiceConfig holds LiveKit server connection and voice quality settings.
type VoiceConfig struct {
	LiveKitAPIKey     string `yaml:"livekit_api_key"`    // LiveKit API key
	LiveKitAPISecret  string `yaml:"livekit_api_secret"` // LiveKit API secret
	LiveKitURL        string `yaml:"livekit_url"`        // LiveKit server WebSocket URL (e.g. ws://localhost:7880)
	LiveKitBinaryPath string `yaml:"livekit_binary"`     // path to livekit-server binary; empty = don't auto-start
	// AutoDownloadLiveKit downloads a pinned, checksum-verified livekit-server
	// release into <data_dir>/livekit/ and runs it as the companion process when
	// no livekit_binary is configured. Fresh installs enable it in the generated
	// config.yaml; the compiled-in default stays false so existing configs keep
	// their behaviour.
	AutoDownloadLiveKit bool `yaml:"auto_download_livekit"`
	// LiveKitVersion overrides the pinned livekit-server release version used
	// by auto-download (e.g. "1.13.11"). Empty = the built-in pin.
	LiveKitVersion string `yaml:"livekit_version"`
	NodeIP         string `yaml:"node_ip"` // public IP for WebRTC ICE candidates; empty = auto-detect
	// AdvertiseInternalIP also advertises internal (LAN) host candidates so
	// local clients can connect while remote ones use the public IP. It keeps
	// use_external_ip on in the generated livekit.yaml, so NodeIP is ignored.
	AdvertiseInternalIP bool `yaml:"advertise_internal_ip"`
	// UDPPort carries all WebRTC media on one UDP port (LiveKit's udp_port)
	// instead of the port range below, so an owner forwards one port. 0 keeps
	// the range. It must not collide with the TCP media port (7881) or LiveKit's
	// API port (7880).
	UDPPort int    `yaml:"udp_port"`
	Quality string `yaml:"quality"` // low | medium | high
}

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port              int      `yaml:"port"`
	Name              string   `yaml:"name"`
	DataDir           string   `yaml:"data_dir"`
	AllowedOrigins    []string `yaml:"allowed_origins"`
	TrustedProxies    []string `yaml:"trusted_proxies"`
	AdminAllowedCIDRs []string `yaml:"admin_allowed_cidrs"`
	WAFEnabled        bool     `yaml:"waf_enabled"` // Enable Coraza WAF (default: false)
	// BrowserClientEnabled is the owner opt-in for hosting the browser client.
	// Off mounts nothing at / or /assets/*; on serves the bundle embedded in the
	// binary (Server/webclient) with its own CSP. A plain `go build` carries
	// only the placeholder and answers GET / with a 404 note.
	BrowserClientEnabled bool `yaml:"browser_client_enabled"`
	// ReachabilityReportEnabled is the owner opt-in for the `reachability` block
	// on GET /api/v1/diagnostics/connectivity: every interface address, the
	// required forwarding rules, and what the server cannot determine about its
	// own reachability.
	// False by default: the endpoint is admin-only because it reveals network
	// topology, and the interface list is the most revealing part. Nothing else
	// is gated by this key; the startup banner qualifier and configuration
	// warnings always print.
	ReachabilityReportEnabled bool `yaml:"reachability_report_enabled"`
	// MinFreeDiskMB is the one definition of "low disk": the headroom in MiB
	// below which the startup banner logs an error, /health reports degraded and
	// uploads are refused with 507. Default 256; 0 disables the floor.
	MinFreeDiskMB    int `yaml:"min_free_disk_mb"`
	WAFParanoiaLevel int `yaml:"waf_paranoia_level"` // OWASP CRS paranoia level 1-4 (default: 2)
	// WAFCRSMode selects the OWASP Core Rule Set mode when the WAF is enabled:
	// "off" (inline rules only), "detect" (matches logged, never blocks) or
	// "block". Defaults to "detect" because chat text routinely false-positives
	// the CRS, so blocking needs tuning on real traffic. Unknown values fall
	// back to "detect".
	WAFCRSMode string `yaml:"waf_crs_mode"`
	// MaxWSConnections caps concurrent WebSocket clients, including sockets
	// still authenticating or awaiting a ready-build permit; excess upgrades get
	// 503 before the upgrade. 0 (default) is unlimited, but every connection
	// costs goroutines and send queues, so set a ceiling that fits host memory.
	MaxWSConnections int `yaml:"max_ws_connections"`
	// MetricsAllowedCIDRs gates the metrics endpoints and the otel build's
	// Prometheus /metrics exporter separately from the admin surface, so a
	// central scraper can be allowlisted without widening /admin. Empty falls
	// back to AdminAllowedCIDRs.
	MetricsAllowedCIDRs []string `yaml:"metrics_allowed_cidrs"`
	// PprofEnabled exposes pprof on a SEPARATE listener bound to 127.0.0.1:6060,
	// never on the main router: profiling exposes heap contents and can burn
	// CPU. Reach it remotely through an SSH port-forward. See
	// docs/server-configuration.md.
	PprofEnabled bool `yaml:"pprof_enabled"`
	// PprofBlockProfileRate is the average interval in nanoseconds between block
	// samples (runtime.SetBlockProfileRate). 100000 (about 100 µs) shows the
	// single SQLite writer's contention that a CPU profile cannot. 0 disables.
	PprofBlockProfileRate int `yaml:"pprof_block_profile_rate"`
	// PprofMutexProfileFraction samples one in N contended mutex events
	// (runtime.SetMutexProfileFraction); 0 disables.
	PprofMutexProfileFraction int `yaml:"pprof_mutex_profile_fraction"`
	// LiveKitWebhookAllowedCIDRs gates the LiveKit webhook and health endpoints.
	// The webhook already verifies LiveKit's JWT signature; this is defence in
	// depth, with its own key so an external LiveKit's IP need not join the
	// admin allowlist. Empty falls back to AdminAllowedCIDRs.
	LiveKitWebhookAllowedCIDRs []string `yaml:"livekit_webhook_allowed_cidrs"`
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
	RestartMode string `yaml:"restart_mode"`
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

// DatabaseConfig holds database settings. SQLite is the only supported backend;
// Type survives so an explicit "sqlite" keeps working and anything else fails
// startup (check in Server/internal/app/database.go) rather than being ignored.
type DatabaseConfig struct {
	// Type selects the backend; "sqlite" (or empty) is the only supported value.
	Type string `yaml:"type"`

	Path string `yaml:"path"`

	// MaxReaders bounds the read-only pool. 0 keeps the automatic max(8,
	// 2×NumCPU); values are clamped to [1, 64] because more readers mostly buy
	// queueing.
	MaxReaders int `yaml:"max_readers"`
}

// TLSConfig holds TLS/certificate settings.
type TLSConfig struct {
	Mode         string `yaml:"mode"`
	CertFile     string `yaml:"cert_file"`
	KeyFile      string `yaml:"key_file"`
	Domain       string `yaml:"domain"`
	AcmeCacheDir string `yaml:"acme_cache_dir"`

	// HTTPSPort is the port the HTTPS listener binds (cfg.Server.Port), set by
	// the caller before LoadOrGenerate; not a config key. ACME's HTTP->HTTPS
	// redirect needs it because the port may not be 443.
	HTTPSPort int `yaml:"-"`
}

// UploadConfig holds file upload settings.
type UploadConfig struct {
	MaxSizeMB  int    `yaml:"max_size_mb"`
	StorageDir string `yaml:"storage_dir"`
	// UserQuotaMB caps the total bytes one user may hold in upload storage
	// (attachments and avatars). Custom emoji are excluded: they are bounded
	// (MaxEmojiCount files of maxEmojiFileBytes) and still pass the
	// disk-headroom floor, see migration 044. 0 (default) is unlimited.
	UserQuotaMB int `yaml:"user_quota_mb"`
	// ImportMaxMB caps one Discord export upload (the .json or .zip) in the
	// admin panel. It is separate from MaxSizeMB, which bounds a single
	// attachment; an export bundles many files, so it is larger.
	ImportMaxMB int `yaml:"import_max_mb"`
	// The storage.FileTypePolicy lists; an admin-panel value replaces each.
	BlockedExtensions []string `yaml:"blocked_extensions"`
	AllowedExtensions []string `yaml:"allowed_extensions"`
}

// UserQuotaBytes is the per-user quota in bytes; 0 means unlimited.
func (u UploadConfig) UserQuotaBytes() int64 { return int64(u.UserQuotaMB) << 20 }

// ImportMaxBytes is the Discord export upload cap in bytes. applyBounds keeps
// the MiB value in [1, MaxInt64>>20], so the shift fits.
func (u UploadConfig) ImportMaxBytes() int64 { return int64(u.ImportMaxMB) << 20 }

// MinFreeDiskBytes is the reserved-headroom floor in bytes; 0 means no floor.
// applyBounds keeps the MiB value in [0, MaxInt64>>20], so the shift fits.
func (s ServerConfig) MinFreeDiskBytes() uint64 {
	if s.MinFreeDiskMB <= 0 {
		return 0
	}
	return uint64(s.MinFreeDiskMB) << 20
}

// BackupConfig controls where database backups are written. Point Dir at another
// disk or an off-host mount so backups don't share a failure point with the live
// database.
type BackupConfig struct {
	Dir string `yaml:"dir"`
}

// SecurityConfig tunes security-adjacent behavior that has safe compiled-in
// defaults.
type SecurityConfig struct {
	// AuthRateLimitMultiplier scales the per-IP auth rate limits and failure
	// thresholds. Defaults assume about one person per IP; a shared NAT hits
	// them collectively. 0 or unset = 1.0; clamped to [0.1, 100].
	AuthRateLimitMultiplier float64 `yaml:"auth_rate_limit_multiplier"`
	// ExpensiveAuthConcurrency bounds how many bcrypt computations — password
	// checks and hashes on every auth route, recovery-code matching at the
	// second-factor step — run at once: the admission budget. Login,
	// registration and recovery-code checks over the budget queue for up to
	// 10 s; an attempt refused (queue full, wait over, or a password
	// confirmation over budget) gets 429 AUTH_BUSY, runs no bcrypt and
	// consumes no lockout attempt. 0 or unset = twice the CPU count (never
	// below 4); clamped to [1, 4096].
	ExpensiveAuthConcurrency int `yaml:"expensive_auth_concurrency"`
}

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
			// Applied only while PprofEnabled is true, so a disabled
			// profiler still adds nothing at runtime.
			PprofBlockProfileRate:     100_000,
			PprofMutexProfileFraction: 5,
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
			MaxSizeMB:         100,
			ImportMaxMB:       500,
			StorageDir:        "data/uploads",
			BlockedExtensions: slices.Clone(storage.DefaultBlockedExtensions),
			AllowedExtensions: []string{},
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
			Level:        "info",
			HistoryDays:  7,
			HistoryMaxMB: 200,
		},
		Moderation: ModerationConfig{
			ReportRetentionDays: 180,
			ActionRetentionDays: 90,
		},
		Attention: AttentionConfig{DiskWarnFreeMB: 1024, WriterWaitMsPerMin: 5000, ReconnectsPerMin: 30, DeliveryDropsPerMin: 1},
		Push: PushConfig{
			Enabled:             false,
			SubscriptionTTLDays: 90,
			DispatchEnabled:     false,
			Contact:             "",
		},
	}
}

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
  # pprof_enabled: false      # expose Go's pprof endpoints on a separate
  #                           # listener bound to 127.0.0.1:6060 only, for
  #                           # operator profiling. Off by default; never mounted
  #                           # on the main router. In Docker that is the
  #                           # container's own loopback: reach it with e.g.
  #                           # docker run --rm --network container:<name>
  #                           # curlimages/curl http://127.0.0.1:6060/debug/pprof/
  # pprof_block_profile_rate: 100000       # nanoseconds between block samples when
  #                           # pprof is on (0 disables); sees SQLite writer contention.
  # pprof_mutex_profile_fraction: 5        # sample 1 in N contended mutex events
  #                           # when pprof is on (0 disables).
  # browser_client_enabled: false  # host the browser client from this server.
  #                           # Owner opt-in, off by default. Release builds carry
  #                           # the browser bundle; a build from source without it
  #                           # answers GET / with a 404 note.
  # reachability_report_enabled: false
  #                           # add a "reachability" block to the admin-only
  #                           # GET /api/v1/diagnostics/connectivity: this host's
  #                           # addresses by class, the ports that must be forwarded,
  #                           # and what the server cannot determine about its own
  #                           # reachability. Owner opt-in; the startup banner reports
  #                           # the address class either way. See docs/port-forwarding.md
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
  #                           # (attachments and avatars); 0 = unlimited
  # import_max_mb: 500        # largest Discord export (.json or .zip) the admin
  #                           # panel accepts for "Import from Discord"
  # blocked_extensions: [bat, cmd, ps1]  # refused by name; a list replaces the
  #                           # default (Windows scripts, installers, disk images)
  # allowed_extensions: []    # non-empty = only these extensions may be uploaded

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
  # livekit_version: ""            # override the pinned livekit-server version (e.g. "1.13.11")
  # livekit_binary: ""             # path to an existing livekit-server binary; set this to
  #                                # skip auto-download and run your own build
  # node_ip: ""                    # public IP for WebRTC media; empty = auto-detect (pin only if detection fails)
  # advertise_internal_ip: false   # also advertise LAN IPs so local-network clients can connect
  # udp_port: 0                    # carry all WebRTC media on ONE UDP port (e.g. 7882) instead of
  #                                # the 50000-60000 range — forward just that one port. 0 = range
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
# "history_days" keeps that many days of logs on disk under <data_dir>/logs,
# searchable from the Logs page's History tab (0 turns it off);
# "history_max_mb" caps their total size, deleting the oldest first.
# logging:
#   level: "info"             # debug | info | warn | error
#   history_days: 7
#   history_max_mb: 200

# Moderation: the report queue's content retention window (B5-8), and the
# moderator-action ledger's own window (B5-9). Report rows and ban/kick/
# removal ledger rows are kept indefinitely either way; these bound only
# the report's evidence/notes/detail and the warning/timeout rows.
# moderation:
#   report_retention_days: 180  # days after a report closes before its content
#                                # is pruned; 0 = never. Open reports are never touched.
#   action_retention_days: 90   # days after acknowledgement (warning) or expiry/lift
#                                # (timeout) before the row retires; 0 = never.

# Admin attention panel (Dashboard): warning floors, raised for rates by the
# learned baseline. Shown only in the admin panel; never exported off-host.
# attention:
#   disk_warn_free_mb: 1024     # warn below this much free space on the data volume;
#                               # 0 = only critical, at server.min_free_disk_mb
#   writer_wait_ms_per_min: 5000  # warn when writes queue longer than this per minute
#   reconnects_per_min: 30      # warn when clients resume sessions faster than this
#   delivery_drops_per_min: 1   # warn when broadcasts drop or full send queues cut
#                               # clients off (typing/presence drops not counted)
`

// Load reads the YAML file, merging defaults and environment overrides. A
// missing file is written as the default config.yaml and defaults are returned.
func Load(cfgPath string) (*Config, error) {
	// Load the freshly written file like any other so first boot runs the
	// configuration the file documents (the template enables options such as
	// voice.auto_download_livekit that compiled-in defaults leave off).
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		if writeErr := os.WriteFile(cfgPath, []byte(defaultYAML), 0o600); writeErr != nil {
			return nil, fmt.Errorf("writing default config: %w", writeErr)
		}
	}
	raw, readErr := os.ReadFile(cfgPath) //nolint:gosec // G304: path from trusted wiring
	if readErr != nil {
		return nil, fmt.Errorf("reading config file %s: %w", cfgPath, readErr)
	}

	cfg, err := loadBytes(raw, cfgPath)
	if err != nil {
		return nil, err
	}

	// Warn, never fail (a newer server must tolerate an older config), about
	// file keys the struct cannot absorb. Otherwise a typo like
	// `admin_alowed_cidrs` silently keeps the default.
	var tree map[string]any
	if err := goyaml.Unmarshal(raw, &tree); err != nil {
		return nil, fmt.Errorf("loading config file %s: %w", cfgPath, err)
	}
	for _, key := range unknownKeys(tree) {
		slog.Warn("config: unknown key ignored — value has NO effect (typo?)",
			"key", key, "file", cfgPath)
	}

	// Warn if using default dev or .env.example placeholder credentials —
	// both are public and insecure.
	// Clear credentials so downstream consumers (e.g. NewLiveKitClient) see
	// empty values and refuse to start voice.
	if IsDefaultVoiceCredentials(&cfg.Voice) {
		slog.Warn("using default or placeholder LiveKit credentials — voice will be disabled; set voice.livekit_api_key and voice.livekit_api_secret in config.yaml (or LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env under Docker)")
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

	// An EMPTY admin_allowed_cidrs silently switches the /admin IP perimeter
	// off: api.AdminIPRestrict allows every address when the list is empty
	// (session auth still applies). Only an operator who set an empty sequence
	// gets here. Warn, don't fail: a panel left open behind a VPN or
	// authenticating proxy is a real deployment.
	if len(cfg.Server.AdminAllowedCIDRs) == 0 {
		slog.Warn("config: admin_allowed_cidrs is empty — the /admin IP perimeter is disabled, " +
			"so AdminIPRestrict admits every address; set server.admin_allowed_cidrs to the " +
			"addresses that should reach the admin panel")
	}

	return cfg, nil
}

// loadBytes builds a Config from raw YAML: defaults, then the file, then the
// admin-panel overrides file, then the OWNCORD_* environment. Unmarshal
// overwrites only keys a document names, so a present-but-empty section keeps
// its defaults.
// The environment layer is marshalled to YAML and unmarshalled through the same
// path as the file, never spliced into text, so a value containing YAML syntax
// stays one scalar.
// Save's verifyLoadable gate runs this whole function, environment included: the
// file it writes must survive the path the server boots with.
func loadBytes(raw []byte, cfgPath string) (*Config, error) {
	cfg, err := loadBytesWith(raw, cfgPath, nil)
	if err != nil {
		return nil, err
	}
	if err := ensureVoiceCredentials(&cfg.Voice); err != nil {
		return nil, fmt.Errorf("applying voice defaults: %w", err)
	}
	return cfg, nil
}

// loadBytesWith builds a Config with the overrides layer injected and no
// generation side effects. A nil overrides map reads the overrides file (Load
// and Save's verifyLoadable gate); Preview passes the current file merged with
// the pending changes.
func loadBytesWith(raw []byte, cfgPath string, overrides map[string]any) (*Config, error) {
	cfg := defaults()
	if err := goyaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("loading config file %s: %w", cfgPath, err)
	}
	// The admin panel's overrides sit between the file and the environment.
	if overrides == nil {
		if err := applyOverrideLayer(&cfg); err != nil {
			return nil, err
		}
	} else if err := applyOverrides(&cfg, overrides); err != nil {
		return nil, err
	}
	env, err := envOverrides()
	if err != nil {
		// Attribute the error to the failing layer here; a single wrap in Load
		// blamed the YAML file for a bad OWNCORD_* value.
		return nil, fmt.Errorf("loading env vars: %w", err)
	}
	if len(env) > 0 {
		envYAML, err := goyaml.Marshal(env)
		if err != nil {
			return nil, fmt.Errorf("encoding env overrides: %w", err)
		}
		if err := goyaml.Unmarshal(envYAML, &cfg); err != nil {
			return nil, fmt.Errorf("applying env overrides: %w", err)
		}
	}
	applyBounds(&cfg)
	if err := normalizeUploadExtensions(&cfg.Upload); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// normalizeUploadExtensions fails the load on a bad entry: skipping it could
// empty an allow-only list, and so switch allow-only mode off.
func normalizeUploadExtensions(u *UploadConfig) (err error) {
	if u.BlockedExtensions, err = storage.NormalizeExtensions(u.BlockedExtensions); err != nil {
		return fmt.Errorf("upload.blocked_extensions: %w", err)
	}
	if u.AllowedExtensions, err = storage.NormalizeExtensions(u.AllowedExtensions); err != nil {
		return fmt.Errorf("upload.allowed_extensions: %w", err)
	}
	return nil
}

func warnInvalidCIDRs(key string, cidrs []string) {
	for _, c := range cidrs {
		if _, _, err := net.ParseCIDR(c); err != nil {
			slog.Warn("config: ignoring invalid CIDR entry (use address/prefix notation, e.g. 10.0.0.1/32)",
				"key", key, "entry", c)
		}
	}
}
