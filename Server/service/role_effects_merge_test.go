package service

import (
	"slices"
	"testing"
)

func TestMergeUserIDs(t *testing.T) {
	got := mergeUserIDs([]int64{3, 1, 3}, []int64{1, 2})
	if want := []int64{3, 1, 2}; !slices.Equal(got, want) {
		t.Fatalf("mergeUserIDs = %v, want %v", got, want)
	}
	if got := mergeUserIDs(nil, nil); len(got) != 0 {
		t.Fatalf("mergeUserIDs(nil, nil) = %v, want empty", got)
	}
}
