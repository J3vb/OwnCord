package db_test

import (
	"context"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Both message subqueries of the unread counts must read the live-message
// index alone. Falling back to idx_messages_channel reads every row to check
// its deleted flag, which made the query four times slower on a large channel.
func TestChannelUnreadCounts_PlanUsesLiveIndex(t *testing.T) {
	database := openMigratedMemory(t)
	rows, err := database.SQLReaderDB().QueryContext(context.Background(),
		"EXPLAIN QUERY PLAN "+db.ChannelUnreadCountsSQLForTest, 1, 1, 1, 1)
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN: %v", err)
	}
	defer rows.Close() //nolint:errcheck
	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan plan row: %v", err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("plan rows: %v", err)
	}
	covering := 0
	for _, step := range plan {
		if strings.Contains(step, "USING COVERING INDEX idx_messages_channel_live") {
			covering++
		}
	}
	if covering != 2 {
		t.Errorf("message subqueries on idx_messages_channel_live = %d, want 2; plan:\n%s",
			covering, strings.Join(plan, "\n"))
	}
}
