package db

import (
	"context"
	"testing"
)

// The marker file keeps the id counters as floors: written with every
// account marker, only ever rising, one per table.
func TestMarkerStore_SequenceFloorsOnlyRise(t *testing.T) {
	ctx := context.Background()
	m := openTestMarkers(t, testMarkerKey(6))
	if floors, err := m.SequenceFloors(ctx); err != nil || len(floors) != 0 {
		t.Fatalf("floors of a fresh file = %v, %v", floors, err)
	}
	if _, _, err := m.RecordPendingAccount(ctx, 7, 12); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.RecordPendingAccount(ctx, 8, 5); err != nil {
		t.Fatal(err)
	}
	if err := m.RaiseSequenceFloor(ctx, SequenceFloorChannels, 3); err != nil {
		t.Fatal(err)
	}
	if err := m.RaiseSequenceFloor(ctx, SequenceFloorChannels, 2); err != nil {
		t.Fatal(err)
	}
	floors, err := m.SequenceFloors(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if floors[SequenceFloorUsers] != 12 || floors[SequenceFloorChannels] != 3 || len(floors) != 2 {
		t.Errorf("floors = %v, want users 12 (a lower write does not lower it), channels 3", floors)
	}
}

// RaiseSequences moves a counter up to its floor and never down, and gives
// a table that never had a row a counter so its first id lands above the
// floor too.
func TestRaiseSequences_MovesCountersUpOnly(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemoryInternal(t)
	if _, err := database.CreateUser(ctx, "seq-a", "hash", 4); err != nil {
		t.Fatal(err)
	}
	b, err := database.CreateUser(ctx, "seq-b", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	seq, err := database.SequenceValue(ctx, SequenceFloorUsers)
	if err != nil || seq != b {
		t.Fatalf("SequenceValue(users) = %d, %v; want %d", seq, err, b)
	}
	if err := database.RaiseSequences(ctx, nil); err != nil {
		t.Fatalf("RaiseSequences(nil): %v", err)
	}
	if err := database.RaiseSequences(ctx, map[string]int64{SequenceFloorUsers: seq + 10, "erasure_jobs": 40}); err != nil {
		t.Fatalf("RaiseSequences: %v", err)
	}
	if got, _ := database.SequenceValue(ctx, SequenceFloorUsers); got != seq+10 {
		t.Errorf("users counter after the raise = %d, want %d", got, seq+10)
	}
	c, err := database.CreateUser(ctx, "seq-c", "hash", 4)
	if err != nil || c != seq+11 {
		t.Errorf("next user id = %d, %v; want %d", c, err, seq+11)
	}
	// erasure_jobs never had a row: the counter is created at the floor.
	if got, _ := database.SequenceValue(ctx, "erasure_jobs"); got != 40 {
		t.Errorf("erasure_jobs counter = %d, want 40", got)
	}
	// A counter past its floor is left alone.
	if err := database.RaiseSequences(ctx, map[string]int64{SequenceFloorUsers: 1}); err != nil {
		t.Fatal(err)
	}
	if got, _ := database.SequenceValue(ctx, SequenceFloorUsers); got != c {
		t.Errorf("users counter after a lower floor = %d, want %d", got, c)
	}
}
