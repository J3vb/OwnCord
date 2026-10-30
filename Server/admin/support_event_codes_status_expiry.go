package admin

func init() {
	// Custom status expiry.
	supportEventCodes["custom status expirer: read next expiry failed"] = "custom_status_expirer_read_next_expiry_failed"
	supportEventCodes["custom status expirer: sweep failed"] = "custom_status_expirer_sweep_failed"
	supportEventCodes["custom status expirer: unparseable expiry"] = "custom_status_expirer_unparseable_expiry"
	supportEventCodes["status-expiry: boot sweep failed"] = "status_expiry_boot_sweep_failed"
}
