package db

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"testing"
)

func TestPadIDs(t *testing.T) {
	cases := []struct {
		n, want int
	}{{0, 0}, {1, 8}, {8, 8}, {9, 16}, {50, 64}, {256, 256}, {300, 512}, {1001, 1024}, {1025, 1025}}
	for _, c := range cases {
		ids := make([]int64, c.n)
		for i := range ids {
			ids[i] = int64(i + 1)
		}
		got := padIDs(ids)
		if len(got) != c.want {
			t.Errorf("padIDs(%d ids) has %d, want %d", c.n, len(got), c.want)
			continue
		}
		for i := c.n; i < len(got); i++ {
			if got[i] != int64(c.n) {
				t.Errorf("padIDs(%d ids)[%d] = %d, want the last id %d", c.n, i, got[i], c.n)
			}
		}
	}
}

func TestIDsJSON(t *testing.T) {
	if got := idsJSON([]int64{3, 10, 7}); got != "[3,10,7]" {
		t.Errorf("idsJSON = %q, want [3,10,7]", got)
	}
}

// A full cache runs a query unprepared instead of growing.
func TestReadStmtCache_FullRunsUnprepared(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	ctx := context.Background()
	d.readStmts.mu.Lock()
	d.readStmts.stmts = make(map[string]*sql.Stmt)
	for i := range maxReadStmts {
		d.readStmts.stmts[string(rune('a'+i%26))+strconv.Itoa(i)] = nil
	}
	d.readStmts.mu.Unlock()
	// The placeholder entries are not real statements; drop them before the
	// DB's own cleanup closes the cache, even when the test fails early.
	t.Cleanup(func() {
		d.readStmts.mu.Lock()
		d.readStmts.stmts = nil
		d.readStmts.mu.Unlock()
	})

	rows, err := d.queryCached(ctx, "SELECT 1")
	if err != nil {
		t.Fatalf("queryCached on a full cache: %v", err)
	}
	_ = rows.Close()
	d.readStmts.mu.Lock()
	n := len(d.readStmts.stmts)
	d.readStmts.mu.Unlock()
	if n != maxReadStmts {
		t.Errorf("cache grew to %d entries, want it held at %d", n, maxReadStmts)
	}
}

// SQL with more placeholders than padIDs pads runs unprepared, so a long
// one-off IN list cannot fill the cache.
func TestReadStmtCache_LongInListNotCached(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	n := maxPaddedIDs + 1
	query := "SELECT 1 WHERE 1 IN (" + strings.Repeat("?,", n-1) + "?)"
	args := make([]any, n)
	for i := range args {
		args[i] = i
	}
	rows, err := d.queryCached(context.Background(), query, args...)
	if err != nil {
		t.Fatalf("queryCached with %d placeholders: %v", n, err)
	}
	_ = rows.Close()
	d.readStmts.mu.Lock()
	got := len(d.readStmts.stmts)
	d.readStmts.mu.Unlock()
	if got != 0 {
		t.Errorf("cache holds %d entries after a %d-placeholder query, want 0", got, n)
	}
}

// After Close a cached query fails instead of preparing on closed pools.
func TestReadStmtCache_ClosedFails(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	rows, err := d.queryCached(context.Background(), "SELECT 1")
	if err != nil {
		t.Fatalf("queryCached before Close: %v", err)
	}
	_ = rows.Close()
	if err := d.readStmts.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if rows, err := d.queryCached(context.Background(), "SELECT 1"); err == nil {
		_ = rows.Close()
		t.Fatal("queryCached after close succeeded, want an error")
	}
}
