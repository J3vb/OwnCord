package app

// stage is one start step; name is how a failure is reported and what the
// failure-injection test selects on.
type stage struct {
	name  string
	start func() error
}

// stages is the start sequence; Close walks it in reverse. Three orderings are
// load-bearing:
//
//   - the database opens before the audit writer and event persistence, so
//     both stop before the handle closes;
//   - ACME and HTTP start after the maintenance loop, so the reverse walk
//     drains in-flight handlers (whose broadcasts need a live hub) first;
//   - signals are armed before the http stage, whose bind retries about ten
//     seconds: a SIGINT in that window must drain through Close, not kill the
//     process with LiveKit and the queues running.
//
// It lives in its own file to keep lifecycle.go under the 500-line file cap.
func (a *App) stages() []stage {
	return []stage{
		{"file-limit", a.startFileLimit},
		{"data-dir", a.startDataDir},
		{"log-history", a.startLogHistory},
		{"tls", a.startTLS},
		{"database", a.startDatabase},
		{"boot-marker", a.startBootMarker},
		{"migrate", a.startMigrate},
		{"erasure-markers", a.startErasureMarkers},
		{"push-vapid-key", a.startPushVAPIDKey},
		{"totp-key", a.startTOTPKey},
		{"totp-secrets", a.startTOTPSecrets},
		{"telemetry", a.startTelemetry},
		{"plugins", a.startPlugins},
		{"hub", a.startHub},
		{"router", a.startRouter},
		{"event-persistence", a.startEventPersistence},
		{"audit-writer", a.startAuditWriter},
		{"maintenance", a.startMaintenance},
		{"status-expiry", a.startStatusExpiry},
		{"poll-expiry", a.startPollExpiry},
		{"thread-archiver", a.startThreadArchiver},
		{"call-log", a.startCallLog},
		{"pprof", a.startPprof},
		{"acme", a.startACME},
		{"signals", a.startSignals},
		{"http", a.startHTTP},
	}
}

// startFileLimit raises the soft open-file limit toward the hard limit (see
// raiseFileLimit).
func (a *App) startFileLimit() error {
	raiseFileLimit(a.log, a.cfg.Server.MaxWSConnections)
	return nil
}
