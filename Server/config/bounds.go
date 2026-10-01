package config

import (
	"log/slog"
	"math"
)

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
	// highToDef sends a value ABOVE max to def as well, for a key where the
	// max is no nearer the operator's intent than any other value (a port).
	highToDef bool
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
		{"upload.max_size_mb", &cfg.Upload.MaxSizeMB, 0, maxMiB, def.Upload.MaxSizeMB, "the default, 100 MB", false},
		{"upload.user_quota_mb", &cfg.Upload.UserQuotaMB, 0, maxMiB, def.Upload.UserQuotaMB, "the default, 0, means unlimited", false},
		{"server.min_free_disk_mb", &cfg.Server.MinFreeDiskMB, 0, maxMiB, def.Server.MinFreeDiskMB, "the default floor; write 0 to disable it", false},
		{"moderation.report_retention_days", &cfg.Moderation.ReportRetentionDays, 0, 3650, def.Moderation.ReportRetentionDays, "0 means never prune report content", false},
		{"moderation.action_retention_days", &cfg.Moderation.ActionRetentionDays, 0, 3650, def.Moderation.ActionRetentionDays, "0 means never retire warning/timeout rows", false},
		{"attention.disk_warn_free_mb", &cfg.Attention.DiskWarnFreeMB, 0, maxMiB, def.Attention.DiskWarnFreeMB, "the default, 1024 MB; write 0 for only the critical level at server.min_free_disk_mb", false},
		{"attention.writer_wait_ms_per_min", &cfg.Attention.WriterWaitMsPerMin, 1, 60_000, def.Attention.WriterWaitMsPerMin, "the default, 5000 ms per minute", false},
		{"attention.reconnects_per_min", &cfg.Attention.ReconnectsPerMin, 1, 1_000_000, def.Attention.ReconnectsPerMin, "the default, 30 per minute", false},
		{"attention.delivery_drops_per_min", &cfg.Attention.DeliveryDropsPerMin, 1, 1_000_000, def.Attention.DeliveryDropsPerMin, "the default, 1 per minute", false},
		{"push.subscription_ttl_days", &cfg.Push.SubscriptionTTLDays, 1, 3650, def.Push.SubscriptionTTLDays, "the default, 90 days", false},
		{"voice.udp_port", &cfg.Voice.UDPPort, 0, 65535, def.Voice.UDPPort, "0, which uses the 50000-60000 range", true},
	}
}

// applyBounds brings every bounded key into its range, warning by key name:
// below the minimum falls back to the default, above the maximum clamps
// (or falls back to the default too, for a highToDef key).
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
