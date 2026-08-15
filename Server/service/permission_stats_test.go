package service

import (
	"context"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// TestCacheStats_HitsAndMisses locks the semantics the metrics endpoint
// documents: a miss is any lookup that repopulated (first touch, TTL expiry,
// post-invalidation), a hit is a fresh cached entry.
func TestCacheStats_HitsAndMisses(t *testing.T) {
	svc, database := newTestPermService(t)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	if h, m := svc.CacheStats(); h != 0 || m != 0 {
		t.Fatalf("fresh service CacheStats = (%d, %d), want (0, 0)", h, m)
	}

	ctx := context.Background()
	svc.HasChannelPerm(ctx, 1, 10, permissions.SendMessages) // populate → miss
	svc.HasChannelPerm(ctx, 1, 10, permissions.SendMessages) // cached → hit

	if h, m := svc.CacheStats(); h != 1 || m != 1 {
		t.Fatalf("CacheStats after populate+hit = (%d, %d), want (1, 1)", h, m)
	}

	svc.InvalidateAll()
	svc.HasChannelPerm(ctx, 1, 10, permissions.SendMessages) // repopulate → miss

	if h, m := svc.CacheStats(); h != 1 || m != 2 {
		t.Fatalf("CacheStats after invalidation = (%d, %d), want (1, 2)", h, m)
	}
}
