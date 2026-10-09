package auth_test

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestSetRateScale_ClampsAndScalesLimits(t *testing.T) {
	t.Cleanup(func() { auth.SetRateScale(1.0) })

	tests := []struct {
		name  string
		scale float64
		limit int
		want  int
	}{
		{"zero means unset so 1.0", 0, 10, 10},
		{"negative means unset so 1.0", -3, 10, 10},
		{"in-range multiplier scales", 2.5, 10, 25},
		{"below the floor clamps to 0.1", 0.001, 100, 10},
		{"above the ceiling clamps to 100", 5000, 10, 1000},
		{"scaled value never drops below 1", 0.1, 3, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			auth.SetRateScale(tc.scale)
			if got := auth.ScaledLimit(tc.limit); got != tc.want {
				t.Errorf("ScaledLimit(%d) at scale %v = %d, want %d", tc.limit, tc.scale, got, tc.want)
			}
		})
	}
}
