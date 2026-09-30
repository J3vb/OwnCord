package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

// TestPatchUser_BanDurationRoundTrips: the duration the panel's ban dialog
// sends comes back from the member list as an expiry that far ahead, and a
// permanent ban (0) comes back with none.
func TestPatchUser_BanDurationRoundTrips(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)
	ctx := context.Background()

	cases := []struct {
		username string
		hours    int
	}{
		{"bannedhour", 1},
		{"bannedday", 24},
		{"bannedweek", 24 * 7},
		{"bannedmonth", 24 * 30},
		{"bannedforever", 0},
	}
	for _, tc := range cases {
		uid, err := database.CreateUser(ctx, tc.username, "hash", 3)
		if err != nil {
			t.Fatal(err)
		}
		before := time.Now().UTC()
		w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(uid), token,
			map[string]any{"banned": true, "ban_reason": "r", "ban_duration_hours": tc.hours})
		if w.Code != http.StatusOK {
			t.Fatalf("%s: PATCH = %d, want 200; body: %s", tc.username, w.Code, w.Body.String())
		}

		list := doRequest(t, handler, http.MethodGet, "/users?banned=1&q="+tc.username, token, nil)
		var users []struct {
			Username   string  `json:"username"`
			Banned     bool    `json:"banned"`
			BanExpires *string `json:"ban_expires"`
		}
		if err := json.Unmarshal(list.Body.Bytes(), &users); err != nil || len(users) != 1 {
			t.Fatalf("%s: GET /users = %s", tc.username, list.Body.String())
		}
		u := users[0]
		if !u.Banned {
			t.Errorf("%s: not banned", tc.username)
		}
		if tc.hours == 0 {
			if u.BanExpires != nil {
				t.Errorf("%s: permanent ban has ban_expires %q", tc.username, *u.BanExpires)
			}
			continue
		}
		if u.BanExpires == nil {
			t.Fatalf("%s: temporary ban has no ban_expires", tc.username)
		}
		exp, err := time.Parse(time.RFC3339, *u.BanExpires)
		if err != nil {
			t.Fatalf("%s: ban_expires %q: %v", tc.username, *u.BanExpires, err)
		}
		want := before.Add(time.Duration(tc.hours) * time.Hour)
		if d := exp.Sub(want); d < -time.Second || d > time.Minute {
			t.Errorf("%s: ban_expires = %s, want about %s", tc.username, exp, want)
		}
	}
}
