package admin

import (
	"runtime"
	"runtime/debug"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

// Do not serialize Config and then try to find secrets with patterns. Only
// enumerated booleans, numbers and normalized enums cross this boundary.
func supportConfig(cfg *config.Config) map[string]any {
	if cfg == nil {
		return map[string]any{"available": false}
	}
	return map[string]any{
		"available":                           true,
		"source":                              "running startup configuration; live settings omitted",
		"server.port":                         cfg.Server.Port,
		"server.waf_enabled":                  cfg.Server.WAFEnabled,
		"server.max_ws_connections":           cfg.Server.MaxWSConnections,
		"server.min_free_disk_mb":             cfg.Server.MinFreeDiskMB,
		"database.max_readers":                cfg.Database.MaxReaders,
		"tls.mode":                            supportEnum(cfg.TLS.Mode, "off", "self_signed", "manual", "acme"),
		"upload.max_size_mb":                  cfg.Upload.MaxSizeMB,
		"upload.user_quota_mb":                cfg.Upload.UserQuotaMB,
		"voice.auto_download_livekit":         cfg.Voice.AutoDownloadLiveKit,
		"voice.advertise_internal_ip":         cfg.Voice.AdvertiseInternalIP,
		"voice.quality":                       supportEnum(cfg.Voice.Quality, "low", "medium", "high"),
		"event_persistence.enabled":           cfg.EventPersistence.Enabled,
		"event_persistence.retention_hours":   cfg.EventPersistence.RetentionHours,
		"event_persistence.replay_ring_size":  cfg.EventPersistence.ReplayRingSize,
		"event_persistence.replay_cold_limit": cfg.EventPersistence.ReplayColdLimit,
		"telemetry.enabled":                   cfg.Telemetry.Enabled,
		"telemetry.exporter":                  supportEnum(cfg.Telemetry.Exporter, "none", "prometheus", "otlp"),
		"plugins.enabled":                     cfg.Plugins.Enabled,
		"push.enabled":                        cfg.Push.Enabled,
		"push.dispatch_enabled":               cfg.Push.DispatchEnabled,
		"logging.level":                       supportEnum(cfg.Logging.Level, "debug", "info", "warn", "error"),
	}
}

func supportEnum(value string, allowed ...string) string {
	for _, item := range allowed {
		if value == item {
			return item
		}
	}
	return "unspecified"
}

func supportBuild(version string) map[string]any {
	out := map[string]any{"version": version, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				out["revision"] = setting.Value
			}
			if setting.Key == "vcs.modified" {
				out["modified"] = setting.Value == "true"
			}
		}
	}
	return out
}

type supportEvent struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Event     string `json:"event"`
}

// Free-form messages, source paths and attributes are always omitted. Exact
// known application messages become fixed event codes; unknown messages only
// contribute their timestamp and normalized level. No pattern can accidentally
// preserve an unrecognized password, address, message or key.
func supportEvents(rb *RingBuffer) []supportEvent {
	out := []supportEvent{}
	if rb == nil {
		return out
	}
	entries := rb.Snapshot()
	if len(entries) > 200 {
		entries = entries[len(entries)-200:]
	}
	for _, entry := range entries {
		ts, err := time.Parse(time.RFC3339Nano, entry.Timestamp)
		if err != nil {
			continue
		}
		out = append(out, supportEvent{Timestamp: ts.UTC().Format(time.RFC3339Nano), Level: supportEnum(entry.Level, "DEBUG", "INFO", "WARN", "ERROR"), Event: supportEventCode(entry.Message)})
	}
	return out
}

var supportEventCodes = map[string]string{
	"database backup created":                              "backup_created",
	"backup failed integrity check — removing":             "backup_verification_failed",
	"restore refused: backup failed integrity check":       "restore_verification_failed",
	"pre-restore backup failed — aborting restore":         "restore_safety_backup_failed",
	"audit log write failed":                               "audit_write_failed",
	"admin: token resolution failed":                       "authentication_storage_failed",
	"session sweep: batch session lookup failed":           "session_storage_failed",
	"ws service internal error":                            "message_service_failed",
	"ws handler internal error":                            "socket_handler_failed",
	"ws writePump error":                                   "socket_write_failed",
	"hub: closing stale connection (no activity)":          "socket_stale_closed",
	"hub: broadcast channel full, dropping message":        "broadcast_dropped",
	"hub: broadcast channel full, dropping global message": "broadcast_dropped",
	"hub: panic recovered":                                 "hub_panic_recovered",
	"livekit: process exited unexpectedly":                 "livekit_process_exited",
	"livekit: too many rapid failures, giving up":          "livekit_restart_exhausted",
	"livekit: auto-download failed — voice stays offline until livekit-server is available": "livekit_download_failed",
	"LeaveVoiceChannelIfMatch exhausted retries — ghost state may persist":                  "voice_cleanup_exhausted",
	"sweepStaleVoiceStates: removed ghost voice state":                                      "voice_ghost_removed",
	"voice permission reconciliation deferred":                                              "voice_permission_reconcile_deferred",
	"event pruner: PruneEventsOlderThan failed":                                             "event_prune_failed",
	"backup maintenance failed":                                                             "backup_maintenance_failed",
	"retention sweep failed":                                                                "retention_failed",
	"report content retention failed":                                                       "report_retention_failed",
	"moderation action retention failed":                                                    "moderation_retention_failed",
	"maintenance loop: circuit breaker open, skipping tick":                                 "maintenance_circuit_open",
}

func supportEventCode(message string) string {
	if code, ok := supportEventCodes[message]; ok {
		return code
	}
	return "log_event"
}

func supportRedactions() []supportRedaction {
	return []supportRedaction{
		{"configuration.json", "structural allowlist", "all credentials, tokens, TOTP/environment values, keys, names, paths, addresses, URLs, contacts, plugin allowlists and live database settings omitted; unrecognized enum values replaced with unspecified"},
		{"database.json", "counts and compiled names only", "all row contents, SQL definitions/defaults, custom schema names, unknown migration names, plugin storage and search index excluded"},
		{"events.json", "fixed event codes only; at most 200 recent records", "all free-form messages, attributes, usernames, identifiers, addresses and source paths omitted; invalid timestamps excluded"},
		{"health.json", "aggregate numeric metrics only", "no per-user, session, channel or host labels"},
	}
}
