package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// mustWarn records a warning against targetID by actorID and returns the
// moderation action id.
func mustWarn(t testing.TB, database *db.DB, targetID, actorID int64, reason string) int64 {
	t.Helper()
	actionID, err := database.WarnUser(context.Background(), targetID, actorID, nil, reason)
	mustDo(t, "WarnUser", err)
	return actionID
}

// mustInsertAppeal files an appeal for actionID by appellantID and returns
// its row id.
func mustInsertAppeal(t testing.TB, database *db.DB, publicID string, actionID, appellantID int64, reason string) int64 {
	t.Helper()
	appealID, err := database.InsertAppeal(context.Background(), publicID, actionID, appellantID, reason)
	mustDo(t, "InsertAppeal", err)
	return appealID
}

// appealedActionOf loads the moderation action behind an appeal in the
// shape DecideAppealTx takes for its reversal.
func appealedActionOf(ctx context.Context, t testing.TB, database *db.DB, actionID int64) db.AppealedAction {
	t.Helper()
	action, err := database.GetModerationAction(ctx, actionID)
	mustDo(t, "GetModerationAction", err)
	return db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
}

// decideOpenAppeal decides an open appeal for the action's reversal as
// deciderID, with the production permission bits, returning the write
// outcome and error. checkAuthority may be nil.
func decideOpenAppeal(ctx context.Context, t testing.TB, database *db.DB, appealID, actionID int64, outcome string, deciderID int64, note string, appellantID int64, checkAuthority func(int64, bool, *string) error) (db.AppealWriteOutcome, error) {
	t.Helper()
	reversal := appealedActionOf(ctx, t, database, actionID)
	result, _, _, err := database.DecideAppealTx(ctx, appealID, "open", 0, outcome, deciderID, note,
		false, appellantID, permissions.ModerateMembers, permissions.Administrator, reversal, checkAuthority)
	return result, err
}

// newOpenAppeal builds the appeal fixture and files an open appeal by the
// member against a fresh warning from the owner, returning the fixture ids
// and the warning and appeal ids.
func newOpenAppeal(t *testing.T, publicID string) (database *db.DB, ownerID, modID, memberID, actionID, appealID int64) {
	t.Helper()
	database, ownerID, modID, memberID, _ = newAppealQueriesTestDB(t)
	actionID = mustWarn(t, database, memberID, ownerID, "x")
	appealID = mustInsertAppeal(t, database, publicID, actionID, memberID, "please")
	return database, ownerID, modID, memberID, actionID, appealID
}
