package admin

func init() {
	// Periodic database optimize.
	supportEventCodes["database optimizer did not stop before the close budget ran out"] = "database_optimizer_stop_timeout"
	// Windowed metrics sampler.
	supportEventCodes["metrics sampler did not stop before the close budget ran out"] = "metrics_sampler_stop_timeout"
	// The Dashboard health row's CPU and memory sampler.
	supportEventCodes["system stats sampler did not stop before the close budget ran out"] = "system_stats_sampler_stop_timeout"
	supportEventCodes["periodic PRAGMA optimize failed"] = "periodic_pragma_optimize_failed"
}
