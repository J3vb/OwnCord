package app

// stage is one start step, in start order. The name is what a failure is
// reported as, so an operator reading `starting audit-writer: ...` knows
// exactly how far the boot got — and it is the key the failure-injection
// test selects on.
type stage struct {
	name  string
	start func() error
}

// stages is the start sequence. Close walks the steps these register in
// reverse, so this list IS the shutdown order read backwards. Three orderings
// here are load-bearing rather than incidental:
//
//   - the database opens before the audit writer and event persistence start,
//     so both stop before the handle closes;
//   - ACME and the HTTP server start AFTER the maintenance loop, so the
//     reverse walk drains in-flight HTTP handlers (whose broadcasts must
//     still reach a live hub) before anything else is stopped — which is the
//     order run()'s explicit shutdown call used to impose by hand;
//   - signals are armed BEFORE the http stage, whose bind retries for about
//     ten seconds while the port is in use: a SIGINT/SIGTERM in that window
//     must drain through Close, not kill the process with the LiveKit child
//     and the audit and event queues already running.
//
// It lives in its own file so the list can grow with the start sequence
// without pushing lifecycle.go past the repository's 500-line file cap.
func (a *App) stages() []stage {
	return []stage{
		{"file-limit", a.startFileLimit},
		{"data-dir", a.startDataDir},
		{"tls", a.startTLS},
		{"database", a.startDatabase},
		{"boot-marker", a.startBootMarker},
		{"migrate", a.startMigrate},
		{"erasure-markers", a.startErasureMarkers},
		{"push-vapid-key", a.startPushVAPIDKey},
		{"telemetry", a.startTelemetry},
		{"plugins", a.startPlugins},
		{"hub", a.startHub},
		{"router", a.startRouter},
		{"event-persistence", a.startEventPersistence},
		{"audit-writer", a.startAuditWriter},
		{"maintenance", a.startMaintenance},
		{"pprof", a.startPprof},
		{"acme", a.startACME},
		{"signals", a.startSignals},
		{"http", a.startHTTP},
	}
}

// startFileLimit is the start step that raises the process's soft open-file
// limit toward its hard limit and reports the result (see raiseFileLimit; a
// no-op on Windows).
func (a *App) startFileLimit() error {
	raiseFileLimit(a.log, a.cfg.Server.MaxWSConnections)
	return nil
}
