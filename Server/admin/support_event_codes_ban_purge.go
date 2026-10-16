package admin

// The ban purge's log messages. They live beside support_event_codes.go
// because that table is at the file-size ceiling; init folds them in.
func init() {
	supportEventCodes["ModerationService.PurgeAfterBan list channels"] = "moderationservice_purgeafterban_list_channels"
	supportEventCodes["ModerationService.PurgeAfterBan purge batch"] = "moderationservice_purgeafterban_purge_batch"
	supportEventCodes["ModerationService.PurgeAfterBan DecrementMentionCounts"] = "moderationservice_purgeafterban_decrementmentioncounts"
	supportEventCodes["ModerationService.PurgeAfterBan record removal"] = "moderationservice_purgeafterban_record_removal"
}
