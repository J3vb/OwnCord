package admin

import (
	"math"
	"net/http/httptest"
	"testing"
)

// queryInt's result-set cap belongs to limit parameters only. Clamping offset
// with the same cap means the audit log and user list can never page past row
// maxLimit+limit — the admin panel loops on the same page forever.
func TestQueryInt_OffsetNotClampedByLimitCap(t *testing.T) {
	r := httptest.NewRequest("GET", "/?offset=550", nil)
	if got := queryInt(r, "offset", 0, 0, math.MaxInt32); got != 550 {
		t.Errorf("offset=550 parsed as %d, want 550", got)
	}
}

func TestQueryInt_LimitStillCapped(t *testing.T) {
	r := httptest.NewRequest("GET", "/?limit=9999", nil)
	if got := queryInt(r, "limit", 50, 1, 500); got != 500 {
		t.Errorf("limit=9999 parsed as %d, want the 500 cap", got)
	}
}
