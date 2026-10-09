package db_test

import (
	"context"
	"strings"
	"testing"
)

// TestMentionQueries_ReportClosedDatabaseErrors proves every mention query
// wraps the driver's error with its own name once the handle is closed, rather
// than panicking or returning an empty result as if nothing matched.
func TestMentionQueries_ReportClosedDatabaseErrors(t *testing.T) {
	database := openMigratedMemory(t)
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	calls := map[string]func() error{
		"CreateMessageWithMentions": func() error {
			_, err := database.CreateMessageWithMentions(ctx, 1, 1, "hi", nil, []int64{2}, false)
			return err
		},
		"ReplaceMessageMentions": func() error {
			return database.ReplaceMessageMentions(ctx, 1, []int64{2}, true)
		},
		"GetMentionsByMessageIDs": func() error {
			_, err := database.GetMentionsByMessageIDs(ctx, []int64{1})
			return err
		},
		"DecrementMentionCounts": func() error {
			_, err := database.DecrementMentionCounts(ctx, 1, []int64{1})
			return err
		},
		"GetMentionCount": func() error {
			_, err := database.GetMentionCount(ctx, 1, 1)
			return err
		},
		"GetUserIDsByUsernames": func() error {
			_, err := database.GetUserIDsByUsernames(ctx, []string{"alice"})
			return err
		},
		"ListMentionTargetsByRoles": func() error {
			_, err := database.ListMentionTargetsByRoles(ctx, []int64{1})
			return err
		},
		"ListMentionTargetsByUserIDs": func() error {
			_, err := database.ListMentionTargetsByUserIDs(ctx, []int64{1})
			return err
		},
		"ListBlockersOf": func() error {
			_, err := database.ListBlockersOf(ctx, 1)
			return err
		},
		"GetChannelOverrides": func() error {
			_, err := database.GetChannelOverrides(ctx, 1)
			return err
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			err := call()
			if err == nil {
				t.Fatalf("%s on a closed database: want an error", name)
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("%s error = %q, want it to name the method", name, err)
			}
		})
	}
}
