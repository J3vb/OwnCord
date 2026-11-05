package config

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
	// LiveKitMetricsURL is the http(s) address of LiveKit's Prometheus page
	// (livekit.yaml `prometheus: port:`), e.g. http://livekit:6789/metrics. The
	// admin Dashboard's LiveKit card reads it. Optional: when empty the card
	// reads the LiveKit OwnCord runs, or tries port 6789 on the host of
	// voice.livekit_url.
	LiveKitMetricsURL string `yaml:"livekit_metrics_url"`
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
	// uploads are refused with 507. Every backup copy (scheduled, manual,
	// pre-migration, pre-restore) must also leave this much free. Default 256;
	// 0 disables the floor.
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
