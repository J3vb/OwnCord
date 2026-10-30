package db

import (
	"context"
	"database/sql"
	"strconv"
	"testing"
)

func TestPadIDs(t *testing.T) {
	cases := []struct {
		n, want int
	}{{0, 0}, {1, 8}, {8, 8}, {9, 16}, {50, 64}, {256, 256}, {300, 300}}
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

	rows, err := d.queryCached(ctx, "SELECT 1")
	if err != nil {
		t.Fatalf("queryCached on a full cache: %v", err)
	}
	_ = rows.Close()
	d.readStmts.mu.Lock()
	n := len(d.readStmts.stmts)
	d.readStmts.stmts = nil
	d.readStmts.mu.Unlock()
	if n != maxReadStmts {
		t.Errorf("cache grew to %d entries, want it held at %d", n, maxReadStmts)
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
