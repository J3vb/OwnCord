package admin

func init() {
	// Periodic database optimize (WP O-3).
	supportEventCodes["database optimizer did not stop before the close budget ran out"] = "database_optimizer_stop_timeout"
	// Windowed metrics sampler (WP 4.3a).
	supportEventCodes["metrics sampler did not stop before the close budget ran out"] = "metrics_sampler_stop_timeout"
	supportEventCodes["periodic PRAGMA optimize failed"] = "periodic_pragma_optimize_failed"
}
