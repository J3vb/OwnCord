package db_test

import (
	"strings"
	"testing"
)

// Deleting a message or a channel makes SQLite look up every row that points
// at it, once per deleted row, on the writer. Each lookup is the equality
// below, and each must seek an index: a scan of channels per deleted message
// held the writer for seconds on a server with many channels.
func TestDeleteLookups_PlansSeekIndexes(t *testing.T) {
	database := openMigratedMemory(t)
	for _, tc := range []struct{ table, column, index string }{
		{"channels", "thread_post_message_id", "idx_channels_thread_post_message"},
		{"message_requests", "first_message_id", "idx_message_requests_first_message"},
		{"read_states", "channel_id", "idx_read_states_channel"},
		{"dm_open_state", "channel_id", "idx_dm_open_state_channel"},
		{"nsfw_acknowledgements", "channel_id", "idx_nsfw_acknowledgements_channel"},
		{"message_requests", "channel_id", "idx_message_requests_channel"},
		{"message_calls", "channel_id", "idx_message_calls_channel"},
		{"import_jobs", "channel_id", "idx_import_jobs_channel"},
	} {
		plan := queryPlan(t, database, "SELECT 1 FROM "+tc.table+" WHERE "+tc.column+" = ?", 1)
		want := "SEARCH " + tc.table + " USING COVERING INDEX " + tc.index + " (" + tc.column + "=?)"
		if len(plan) != 1 || plan[0] != want {
			t.Errorf("%s.%s lookup, want %q; plan:\n%s", tc.table, tc.column, want, strings.Join(plan, "\n"))
		}
	}
}
