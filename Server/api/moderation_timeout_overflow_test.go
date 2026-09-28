package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestModerationTimeout_RejectsOverflowingDuration is OC-0485 at the trust
// boundary: both timeout entry points (the direct route and the queue act
// route) must refuse a `duration_seconds` whose product with time.Second
// would wrap into the accepted window, rather than silently shrinking it.
// The value below is 3600 + 2^55, which the old multiply collapsed to
// exactly one hour and the 1-minute..28-day gate then accepted.
func TestModerationTimeout_RejectsOverflowingDuration(t *testing.T) {
	const overflow = `{"reason":"cool off","duration_seconds":36028797018967568}`

	t.Run("direct timeout route", func(t *testing.T) {
		h, database, _ := buildModQueueActRouter(t)
		modID := mintModerator(t, database, "overflow-mod", 90, permissions.ModerateMembers)
		modToken, _ := mintSession(t, database, modID)
		targetID := mintUser(t, database, "overflow-target")

		status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/users/"+itoa(targetID)+"/timeout", modToken, overflow)
		if status != http.StatusBadRequest {
			t.Fatalf("overflowing direct timeout: status = %d, body = %s, want 400", status, body)
		}
		var resp struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("unmarshal error response: %v", err)
		}
		if resp.Error != "BAD_REQUEST" {
			t.Fatalf("error = %q, want BAD_REQUEST", resp.Error)
		}
	})

	t.Run("queue act timeout route", func(t *testing.T) {
		h, database, _ := buildModQueueActRouter(t)
		modID := mintModerator(t, database, "overflow-act-mod", 90, permissions.ModerateMembers)
		modToken, _ := mintSession(t, database, modID)
		reporterID := mintUser(t, database, "overflow-reporter")
		reporterToken, _ := mintSession(t, database, reporterID)
		targetID := mintUser(t, database, "overflow-act-target")
		publicID := fileUserReport(t, h, reporterToken, targetID)

		status, body := actJSON(t, h, http.MethodPost, "/api/v1/moderation/queue/"+publicID+"/act", modToken,
			`{"kind":"timeout","reason":"cool off","duration_seconds":36028797018967568}`)
		if status != http.StatusBadRequest {
			t.Fatalf("overflowing act(timeout): status = %d, body = %s, want 400", status, body)
		}
	})
}
