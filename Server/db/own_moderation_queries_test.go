package db_test

import (
	"context"
	"testing"
)

// TestListOwnModerationActions: only the caller's own non-kick rows, newest
// first, each with the appeal filed against it (or none).
func TestListOwnModerationActions(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	warnID, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	if _, err := database.ForceLogoutWithAction(ctx, memberID, ownerID, nil, ""); err != nil {
		t.Fatalf("ForceLogoutWithAction: %v", err)
	}
	banID, err := database.BanUserWithAction(ctx, memberID, "spam", nil, ownerID, nil)
	if err != nil {
		t.Fatalf("BanUserWithAction: %v", err)
	}
	if _, err := database.InsertAppeal(ctx, "pub-own", warnID, memberID, "please"); err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	rows, err := database.ListOwnModerationActions(ctx, memberID)
	if err != nil {
		t.Fatalf("ListOwnModerationActions: %v", err)
	}
	if len(rows) != 2 || rows[0].ID != banID || rows[1].ID != warnID {
		t.Fatalf("rows = %+v, want ban %d then warning %d (no kick)", rows, banID, warnID)
	}
	if rows[0].AppealID != nil || rows[1].AppealID == nil || *rows[1].AppealID != "pub-own" ||
		rows[1].AppealState == nil || *rows[1].AppealState != "open" {
		t.Fatalf("appeal linkage = %+v", rows)
	}

	if own, err := database.ListOwnModerationActions(ctx, ownerID); err != nil || len(own) != 0 {
		t.Fatalf("actor's own rows = %+v, %v; want none", own, err)
	}
}
