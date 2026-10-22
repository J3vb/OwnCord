package main

import (
	"errors"
	"fmt"
	"os"
	"testing"
)

func TestOnlyMissingFile(t *testing.T) {
	missing := fmt.Errorf("reading live ws seq floor: %w", os.ErrNotExist)
	damaged := errors.New("invalid ws seq floor file")
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"missing live database", missing, true},
		{"joined missing only", errors.Join(missing, missing), true},
		{"missing plus damaged sidecar", errors.Join(damaged, missing), false},
		{"damaged only", damaged, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := onlyMissingFile(tc.err); got != tc.want {
				t.Fatalf("onlyMissingFile = %v, want %v", got, tc.want)
			}
		})
	}
}
