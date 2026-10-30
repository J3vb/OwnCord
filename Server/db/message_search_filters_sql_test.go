package db

import (
	"context"
	"strings"
	"testing"
)

// With no imported channel in scope the date bounds render exactly the plain id
// range plus the timestamp test, so a native search keeps its index plans.
func TestSearchFilters_NoImportedChannelKeepsThePlainIdRange(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemoryInternal(t)
	q := SearchQuery{ChannelIDs: []int64{1, 2}, AfterTS: "2026-01-01 00:00:00", BeforeTS: "2026-02-01 00:00:00"}
	for _, tc := range []struct {
		ranked bool
		col    string
	}{{false, "m.id"}, {true, "f.rowid"}} {
		got, args, err := database.searchFilters(ctx, q, tc.ranked)
		if err != nil {
			t.Fatalf("searchFilters: %v", err)
		}
		want := " AND m.channel_id IN (?,?) AND " + tc.col + " >= ? AND m.timestamp >= ? AND " + tc.col + " < ? AND m.timestamp < ?"
		if strings.TrimSpace(got) != strings.TrimSpace(want) {
			t.Errorf("ranked=%v filter =\n%s\nwant\n%s", tc.ranked, got, want)
		}
		if len(args) != 6 {
			t.Errorf("ranked=%v args = %v, want 6", tc.ranked, args)
		}
	}
}

func TestSplitImportedScope(t *testing.T) {
	native, imp := splitImportedScope([]int64{1, 2, 3}, []int64{2, 9})
	if len(native) != 2 || native[0] != 1 || native[1] != 3 || len(imp) != 1 || imp[0] != 2 {
		t.Errorf("native=%v imported=%v", native, imp)
	}
	native, imp = splitImportedScope([]int64{1}, nil)
	if len(native) != 1 || imp != nil {
		t.Errorf("no imports: native=%v imported=%v", native, imp)
	}
}
