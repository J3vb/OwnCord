package db

import (
	"context"
	"strings"
	"testing"
)

// With no imported channel in scope the date bounds render exactly the plain id
// range plus the timestamp test (the scope's threads ride in one JSON parameter), so a native search keeps its index plans.
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
		want := " AND (m.channel_id IN (?,?) OR " + threadsOfScope + ") AND " + tc.col + " >= ? AND m.timestamp >= ? AND " + tc.col + " < ? AND m.timestamp < ?"
		if strings.TrimSpace(got) != strings.TrimSpace(want) {
			t.Errorf("ranked=%v filter =\n%s\nwant\n%s", tc.ranked, got, want)
		}
		if len(args) != 7 {
			t.Errorf("ranked=%v args = %v, want 7 (two ids, the scope JSON, four date terms)", tc.ranked, args)
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

func TestScopeIDsJSON(t *testing.T) {
	for _, tc := range []struct {
		ids  []int64
		want string
	}{{nil, "[]"}, {[]int64{7}, "[7]"}, {[]int64{1, -2, 30}, "[1,-2,30]"}} {
		if got := scopeIDsJSON(tc.ids); got != tc.want {
			t.Errorf("scopeIDsJSON(%v) = %q, want %q", tc.ids, got, tc.want)
		}
	}
}
