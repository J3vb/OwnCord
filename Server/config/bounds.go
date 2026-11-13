package config

import (
	"log/slog"
	"math"
	"strings"
)

// boundedKey is one integer key with a legal range. Out-of-range values are clamped and warned about, never
// rejected, so a warning cannot brick a working install.
type boundedKey struct {
	key      string
	ptr      *int
	min, max int
	// What a value BELOW min becomes: the compiled default, not the minimum. Clamping a negative headroom to
	// 0 would silently turn the floor off (fail open); an operator who wants it off writes 0.
	def int
	// Names what the fallback stands for, so the warning says what happened to the operator's intent.
	meaning string
	// Sends a value ABOVE max to def too, for a key where max is no nearer the operator's intent (a port).
	highToDef bool
}

// boundedKeys is the one place a bounded key states its range; a new ranged key adds a row here, not a
// clamp in its consumer. Bounds are on the MiB values as written; maxMiB keeps the byte shift inside int64.
func boundedKeys(cfg *Config) []boundedKey {
	const maxMiB = math.MaxInt64 >> 20
	def := defaults()
	return []boundedKey{
		{"upload.max_size_mb", &cfg.Upload.MaxSizeMB, 0, maxMiB, def.Upload.MaxSizeMB, "the default, 100 MB", false},
		{"upload.user_quota_mb", &cfg.Upload.UserQuotaMB, 0, maxMiB, def.Upload.UserQuotaMB, "the default, 0, means unlimited", false},
		{"upload.import_max_mb", &cfg.Upload.ImportMaxMB, 1, maxMiB, def.Upload.ImportMaxMB, "the default, 500 MB", false},
		{"server.min_free_disk_mb", &cfg.Server.MinFreeDiskMB, 0, maxMiB, def.Server.MinFreeDiskMB, "the default floor; write 0 to disable it", false},
		{"logging.history_days", &cfg.Logging.HistoryDays, 0, 3650, def.Logging.HistoryDays, "the default, 7 days; write 0 to turn saved logs off", false},
		{"logging.history_max_mb", &cfg.Logging.HistoryMaxMB, 1, 1 << 20, def.Logging.HistoryMaxMB, "the default, 200 MB", false},
		{"moderation.report_retention_days", &cfg.Moderation.ReportRetentionDays, 0, 3650, def.Moderation.ReportRetentionDays, "0 means never prune report content", false},
		{"moderation.action_retention_days", &cfg.Moderation.ActionRetentionDays, 0, 3650, def.Moderation.ActionRetentionDays, "0 means never retire warning/timeout rows", false},
		{"link_previews.thumbnail_cache_mb", &cfg.LinkPreviews.ThumbnailCacheMB, 0, maxMiB, def.LinkPreviews.ThumbnailCacheMB, "the default, 512 MB; write 0 to keep no thumbnails", false},
		{"link_previews.thumbnail_unused_days", &cfg.LinkPreviews.ThumbnailUnusedDays, 1, 3650, def.LinkPreviews.ThumbnailUnusedDays, "the default, 30 days", false},
		{"attention.disk_warn_free_mb", &cfg.Attention.DiskWarnFreeMB, 0, maxMiB, def.Attention.DiskWarnFreeMB, "the default, 1024 MB; write 0 for only the critical level at server.min_free_disk_mb", false},
		{"attention.writer_wait_ms_per_min", &cfg.Attention.WriterWaitMsPerMin, 1, 60_000, def.Attention.WriterWaitMsPerMin, "the default, 5000 ms per minute", false},
		{"attention.reconnects_per_min", &cfg.Attention.ReconnectsPerMin, 1, 1_000_000, def.Attention.ReconnectsPerMin, "the default, 30 per minute", false},
		{"attention.delivery_drops_per_min", &cfg.Attention.DeliveryDropsPerMin, 1, 1_000_000, def.Attention.DeliveryDropsPerMin, "the default, 1 per minute", false},
		{"push.subscription_ttl_days", &cfg.Push.SubscriptionTTLDays, 1, 3650, def.Push.SubscriptionTTLDays, "the default, 90 days", false},
		{"event_persistence.retention_hours", &cfg.EventPersistence.RetentionHours, 1, 8_760, def.EventPersistence.RetentionHours, "the default, 24 hours", false},
		{"event_persistence.batch_size", &cfg.EventPersistence.BatchSize, 1, 10_000, def.EventPersistence.BatchSize, "the default, 50 events", false},
		{"event_persistence.batch_flush_ms", &cfg.EventPersistence.BatchFlushMs, 1, 60_000, def.EventPersistence.BatchFlushMs, "the default, 100 ms", false},
		{"event_persistence.pruner_interval_minutes", &cfg.EventPersistence.PrunerIntervalMinutes, 1, 10_080, def.EventPersistence.PrunerIntervalMinutes, "the default, 60 minutes", false},
		{"event_persistence.replay_ring_size", &cfg.EventPersistence.ReplayRingSize, 1, 1_000_000, def.EventPersistence.ReplayRingSize, "the default, 1000 events", false},
		{"event_persistence.replay_cold_limit", &cfg.EventPersistence.ReplayColdLimit, 0, 1_000_000, def.EventPersistence.ReplayColdLimit, "the default, 5000 events", false},
		{"voice.udp_port", &cfg.Voice.UDPPort, 0, 65535, def.Voice.UDPPort, "0, which uses the 50000-60000 range", true},
	}
}

func applyBounds(cfg *Config) {
	for _, b := range boundedKeys(cfg) {
		v := *b.ptr
		fixed := v
		switch {
		case v < b.min:
			fixed = b.def
		case v > b.max && b.highToDef:
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

// trimOriginSlashes drops trailing slashes from an allowed web origin: a
// browser's Origin header never carries one, and every origin check compares the
// configured text literally, so "https://chat.example/" would match nothing.
func trimOriginSlashes(s string) string {
	return strings.TrimRight(s, "/")
}

// normalizeAllowedOrigins rewrites server.allowed_origins entries to the
// scheme://host[:port] form the origin checks compare, wherever the entry came
// from (config file, panel override or environment).
func normalizeAllowedOrigins(sc *ServerConfig) {
	for i, o := range sc.AllowedOrigins {
		sc.AllowedOrigins[i] = trimOriginSlashes(o)
	}
}
