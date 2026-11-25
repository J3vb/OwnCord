package db_test

import (
	"context"
	"testing"
	"time"
)

// A ban, temporary or permanent, removes the account's push subscriptions in
// the ban's own transaction; other accounts keep theirs.
func TestBanUserWithAction_RemovesPushSubscriptions(t *testing.T) {
	t.Parallel()
	for name, expires := range map[string]*time.Time{
		"permanent": nil,
		"temporary": new(time.Now().Add(time.Hour)),
	} {
		t.Run(name, func(t *testing.T) {
			database := openMigratedMemory(t)
			ctx := context.Background()
			seedPushUser(t, database, 1)
			if err := database.UpdateUserRole(ctx, 1, 1); err != nil { // the owner bans
				t.Fatalf("UpdateUserRole: %v", err)
			}
			seedPushUser(t, database, 2)
			seedPushUser(t, database, 3)
			for _, uid := range []int64{2, 3} {
				if _, err := database.UpsertPushSubscription(ctx, uid, nil, "https://push.example/"+name, "p", "a", "phone", "k", 10); err != nil {
					t.Fatalf("UpsertPushSubscription(%d): %v", uid, err)
				}
			}

			if _, err := database.BanUserWithAction(ctx, 2, "spam", expires, 1, nil); err != nil {
				t.Fatalf("BanUserWithAction: %v", err)
			}

			rows := func(uid int64) int {
				var n int
				if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`, uid).Scan(&n); err != nil {
					t.Fatalf("count: %v", err)
				}
				return n
			}
			if n := rows(2); n != 0 {
				t.Errorf("banned account keeps %d push subscription(s)", n)
			}
			if n := rows(3); n != 1 {
				t.Errorf("other account has %d push subscription(s), want 1", n)
			}
		})
	}
}
