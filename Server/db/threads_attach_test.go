package db

import (
	"context"
	"testing"
)

// attachThreads issues no query when a page has no live user message to carry
// a thread, and one batched query when it has.
func TestAttachThreads_QueryOnlyWithCandidates(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // any query now fails

	if err := database.attachThreads(ctx, nil); err != nil {
		t.Fatalf("empty page ran a query: %v", err)
	}
	none := []MessageAPIResponse{{ID: 1, Deleted: true}, {ID: 2, Kind: "system"}}
	if err := database.attachThreads(ctx, none); err != nil {
		t.Fatalf("page without candidates ran a query: %v", err)
	}
	some := []MessageAPIResponse{{ID: 3}}
	if err := database.attachThreads(ctx, some); err == nil {
		t.Fatal("a page with a candidate ran no query")
	}
}
