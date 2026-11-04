package voicestate

import (
	"testing"
	"time"
)

func TestRejoinBlocks(t *testing.T) {
	var s RejoinBlocks
	if s.Blocked(1, 10) {
		t.Fatal("a zero RejoinBlocks blocked a join")
	}
	s.Block(1, 10, time.Now().Add(time.Minute))
	if !s.Blocked(1, 10) {
		t.Fatal("join to the removed channel not blocked")
	}
	if s.Blocked(1, 11) || s.Blocked(2, 10) {
		t.Fatal("block leaked to another channel or user")
	}
	s.Block(1, 11, time.Now().Add(time.Minute))
	if s.Blocked(1, 10) || !s.Blocked(1, 11) {
		t.Fatal("a later removal must replace the earlier one")
	}
	s.Clear(1)
	if s.Blocked(1, 11) {
		t.Fatal("Clear did not lift the block")
	}
	s.Block(2, 10, time.Now().Add(-time.Second))
	if s.Blocked(2, 10) {
		t.Fatal("an expired block still refused the join")
	}
	if _, ok := s.entries[2]; ok {
		t.Fatal("an expired block was not dropped when read")
	}
}

func TestReconcileMisses(t *testing.T) {
	var s ReconcileMisses
	s.Clear("a")
	if n := s.Miss("a"); n != 1 {
		t.Fatalf("first miss = %d, want 1", n)
	}
	if n := s.Miss("a"); n != 2 {
		t.Fatalf("second miss = %d, want 2", n)
	}
	s.Miss("b")
	s.Prune(map[string]struct{}{"b": {}})
	if n := s.Miss("a"); n != 1 {
		t.Fatalf("pruned identity kept its count: %d", n)
	}
	s.Clear("b")
	if n := s.Miss("b"); n != 1 {
		t.Fatalf("cleared identity kept its count: %d", n)
	}
}
