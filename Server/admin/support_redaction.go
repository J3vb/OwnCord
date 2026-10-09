package admin

import (
	"runtime"
	"runtime/debug"
	"slices"
	"strings"
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
	Timestamp string         `json:"timestamp"`
	Level     string         `json:"level"`
	Event     string         `json:"event"`
	Detail    map[string]any `json:"detail,omitempty"`
}

// supportEventsMax bounds events.json. SRE-03: the bundle used to keep the
// last 200 records at ANY level, so an INFO/DEBUG burst pushed the
// Warn-and-above records an operator needs out of the bundle. supportEvents
// keeps Warn/Error first and fills the rest with the most recent lower-level
// records.
const supportEventsMax = 200

// Free-form messages and source paths are always omitted. Exact known
// application messages become fixed event codes; unknown messages only
// contribute their timestamp and normalized level. Attributes survive only as
// redacted detail (support_event_detail.go).
//
// Selection (SRE-03): the last supportEventsMax records that are WARN or above
// are kept, and any remaining slots are filled with the most recent
// lower-level records, so a routine INFO burst can never evict a failure. The
// result is returned in chronological order.
func supportEvents(rb *RingBuffer, known ...string) []supportEvent {
	if rb == nil {
		return []supportEvent{}
	}
	entries := rb.supportSnapshot()
	type candidate struct {
		event supportEvent
		attrs string
		warn  bool
	}
	valid := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		ts, err := time.Parse(time.RFC3339Nano, entry.Timestamp)
		if err != nil {
			continue
		}
		level := supportEnum(entry.Level, "DEBUG", "INFO", "WARN", "ERROR")
		valid = append(valid, candidate{
			event: supportEvent{Timestamp: ts.UTC().Format(time.RFC3339Nano), Level: level, Event: supportEventCode(entry.Message)},
			attrs: entry.Attrs,
			warn:  level == "WARN" || level == "ERROR",
		})
	}
	keep := make([]int, 0, supportEventsMax)
	if len(valid) <= supportEventsMax {
		for i := range valid {
			keep = append(keep, i)
		}
	} else {
		// Walk from the newest backwards, keeping WARN+ first until the cap is hit.
		for i := len(valid) - 1; i >= 0 && len(keep) < supportEventsMax; i-- {
			if valid[i].warn {
				keep = append(keep, i)
			}
		}
		for i := len(valid) - 1; i >= 0 && len(keep) < supportEventsMax; i-- {
			if !valid[i].warn {
				keep = append(keep, i)
			}
		}
		slices.Sort(keep)
	}
	out := make([]supportEvent, len(keep))
	attrs := make([]string, len(keep))
	for j, i := range keep {
		out[j], attrs[j] = valid[i].event, valid[i].attrs
	}
	supportAttachDetail(out, attrs, newSupportKnown(known))
	return out
}

// supportEventPrefixCodes maps the constant prefix of a Warn/Error message
// built with a variable suffix to its code. supportEventCode tries an exact
// match first, then the longest matching prefix here, so these dynamic messages
// are coded without depending on their runtime suffix.
var supportEventPrefixCodes = map[string]string{
	"DeleteOtherSessions after ":             "deleteothersessions_after",
	"DeleteOtherSessions retry after ":       "deleteothersessions_retry_after",
	"hub: broadcast channel full, dropping ": "broadcast_dropped",
}

func supportEventCode(message string) string {
	if code, ok := supportEventCodes[message]; ok {
		return code
	}
	// A message built with a variable suffix ("... dropping "+kind) matches on
	// its constant prefix. Longest prefix wins, so a more specific entry cannot
	// be shadowed by a shorter one.
	best := ""
	for prefix := range supportEventPrefixCodes {
		if strings.HasPrefix(message, prefix) && len(prefix) > len(best) {
			best = prefix
		}
	}
	if best != "" {
		return supportEventPrefixCodes[best]
	}
	return "log_event"
}

func supportRedactions() []supportRedaction {
	return []supportRedaction{
		{"configuration.json", "structural allowlist", "all credentials, tokens, TOTP/environment values, keys, names, paths, addresses, URLs, contacts, plugin allowlists and live database settings omitted; unrecognized enum values replaced with unspecified"},
		{"database.json", "counts and compiled names only", "all row contents, SQL definitions/defaults, custom schema names, unknown migration names, plugin storage and search index excluded"},
		{"events.json", "fixed event codes plus non-identifying attribute detail; up to 200 records, Warn/Error kept in preference to lower levels", "free-form messages, source paths, nested attributes and every attribute keyed as an identifier, user, name, address, host, path, URL, token, key or other credential omitted; URLs, emails, paths, IP addresses, hostnames, token-like strings and the server's registered usernames, display names, server name and configured hosts inside kept values replaced by placeholders; invalid timestamps excluded"},
		{"health.json", "aggregate numeric metrics only", "no per-user, session, channel or host labels"},
	}
}
