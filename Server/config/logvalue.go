package config

import "log/slog"

// This file makes secret-bearing config types safe to log by construction.
// Without it, "never log secrets" holds only by call-site discipline — a
// single slog.Info("cfg", "voice", cfg.Voice) would dump the LiveKit key. By
// implementing slog.LogValuer, secrets are redacted no matter how the value
// reaches a log record. Non-secret fields stay visible so the logs remain
// useful for debugging.

// redactSecret masks a secret for logging. An empty value stays empty (so an
// unset credential is still visible as "unset"); anything else becomes a fixed
// marker that reveals neither the value nor its length.
func redactSecret(s string) string {
	if s == "" {
		return ""
	}
	return "[REDACTED]"
}

// LogValue redacts the LiveKit API key and secret.
func (v VoiceConfig) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("livekit_api_key", redactSecret(v.LiveKitAPIKey)),
		slog.String("livekit_api_secret", redactSecret(v.LiveKitAPISecret)),
		slog.String("livekit_url", v.LiveKitURL),
		slog.String("livekit_binary", v.LiveKitBinaryPath),
		slog.String("node_ip", v.NodeIP),
		slog.Bool("advertise_internal_ip", v.AdvertiseInternalIP),
		slog.String("quality", v.Quality),
	)
}

// LogValue redacts the GitHub token.
func (g GitHubConfig) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("token", redactSecret(g.Token)),
		slog.String("owner", g.Owner),
		slog.String("repo", g.Repo),
	)
}

// LogValue redacts the Klipy (GIF proxy) API key.
func (g GIFConfig) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("api_key", redactSecret(g.APIKey)),
	)
}

// LogValue delegates each section through slog.Any so secret-bearing sections
// are redacted via their own LogValue even when the whole Config is logged.
// A section added to Config but not listed here is omitted from the log (safe:
// it is hidden, never leaked).
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Any("server", c.Server),
		slog.Any("database", c.Database),
		slog.Any("tls", c.TLS),
		slog.Any("upload", c.Upload),
		slog.Any("voice", c.Voice),
		slog.Any("github", c.GitHub),
		slog.Any("event_persistence", c.EventPersistence),
		slog.Any("telemetry", c.Telemetry),
		slog.Any("plugins", c.Plugins),
		slog.Any("gif", c.GIF),
		slog.Any("logging", c.Logging),
	)
}
