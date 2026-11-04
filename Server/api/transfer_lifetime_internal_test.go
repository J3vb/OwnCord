package api

import (
	"testing"
	"time"
)

// TestTransferLifetimeFollowsUploadCap: the lifetime grows with the transfer
// size at the slowest supported rate and stays between the two bounds, so a
// raised upload cap widens the window instead of tightening it.
func TestTransferLifetimeFollowsUploadCap(t *testing.T) {
	cases := []struct {
		name string
		size int64
		want time.Duration
	}{
		{"unknown size", 0, transferMinLifetime},
		{"negative size", -1, transferMinLifetime},
		{"3 MiB avatar", 3 << 20, transferMinLifetime},
		{"exactly the floor", int64(transferMinLifetime/time.Second) * transferSlowestRate, transferMinLifetime},
		{"default 100 MiB body cap", uploadBodyCap(0), 1600 * time.Second},
		{"200 MiB cap", uploadBodyCap(200 << 20), 3216 * time.Second},
		{"1 GiB cap", uploadBodyCap(1 << 30), transferMaxLifetime},
		{"saturated cap", uploadBodyCap(1 << 62), transferMaxLifetime},
	}
	for _, tc := range cases {
		if got := transferLifetimeFor(tc.size); got != tc.want {
			t.Errorf("%s: transferLifetimeFor(%d) = %v, want %v", tc.name, tc.size, got, tc.want)
		}
	}
}
