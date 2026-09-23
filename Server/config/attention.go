package config

// AttentionConfig holds the admin attention panel's floors (RI-07). Each is
// the lowest level that raises a warning; the rate floors are raised further
// by a learned baseline once the server has observed its normal load. The
// critical disk level is server.min_free_disk_mb. Attention state is served
// only to the admin panel and is never exported off the host.
type AttentionConfig struct {
	// DiskWarnFreeMB warns when free space on the data volume drops below it.
	DiskWarnFreeMB int `yaml:"disk_warn_free_mb"`
	// WriterWaitMsPerMin warns when requests spend more than this many
	// milliseconds per minute queueing for the single SQLite writer.
	WriterWaitMsPerMin int `yaml:"writer_wait_ms_per_min"`
	// ReconnectsPerMin warns when clients resume sessions faster than this.
	ReconnectsPerMin int `yaml:"reconnects_per_min"`
	// DeliveryDropsPerMin warns when dropped deliveries plus slow-client
	// disconnects exceed this rate.
	DeliveryDropsPerMin int `yaml:"delivery_drops_per_min"`
}

// DiskWarnFreeBytes is disk_warn_free_mb in bytes; 0 when unset.
func (a AttentionConfig) DiskWarnFreeBytes() uint64 {
	if a.DiskWarnFreeMB <= 0 {
		return 0
	}
	return uint64(a.DiskWarnFreeMB) << 20
}
