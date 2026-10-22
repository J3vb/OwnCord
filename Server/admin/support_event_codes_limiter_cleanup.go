package admin

func init() {
	// Rate-limiter cleanup loop, App-owned since WP 5.6g.
	supportEventCodes["limiter cleanup did not stop before the close budget ran out"] = "limiter_cleanup_stop_timeout"
}
